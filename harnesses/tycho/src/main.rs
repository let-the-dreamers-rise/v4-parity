//! v4-parity harness for propeller-heads/tycho-simulation UniswapV4State.
//!
//! Usage: tycho-v4-parity <swaps.json|units.json> [report.json]
//!
//! Swap vectors are run in three modes:
//!   api       : the public `ProtocolSim::get_amount_out` path, state built exactly as
//!               `uniswap_v4/decoder.rs` does (fees = (pf0, pf1, key_lp_fee), ticks with
//!               net_liquidity != 0, sorted). Exact-in with default price limit only.
//!               A dynamic-fee hook override is supplied through a stub HookHandler that
//!               has the beforeSwap permission bit and returns the override fee.
//!   raw       : the private `UniswapV4State::swap` (called through a visibility-only
//!               wrapper) so exact-out and custom price limits can be checked too. Same state.
//!   raw_allticks: like raw but also keeps initialized ticks whose net liquidity is 0
//!               (which the decoder / indexer cannot represent) to isolate that effect.
use std::{
    collections::HashMap,
    env, fs,
    panic::{self, AssertUnwindSafe},
    str::FromStr,
};

use alloy::primitives::{aliases::U24, Address, I256, U256};
use num_bigint::BigUint;
use serde_json::{json, Value};
use tycho_common::{
    dto::ProtocolStateDelta,
    models::token::Token,
    simulation::{
        errors::{SimulationError, TransitionError},
        protocol_sim::{Balances, ProtocolSim},
    },
    Bytes,
};
use tycho_simulation::evm::protocol::{
    uniswap_v4::{
        hooks::{
            hook_handler::HookHandler,
            models::{
                AfterSwapDelta, AfterSwapParameters, AmountRanges, BeforeSwapDelta,
                BeforeSwapOutput, BeforeSwapParameters, SwapParams, WithGasEstimate,
            },
        },
        state::{UniswapV4Fees, UniswapV4State},
    },
    utils::uniswap::{liquidity_math, sqrt_price_math, swap_math, tick_list::TickInfo, tick_math},
};

const MIN_SQRT: &str = "4295128739";
const MAX_SQRT: &str = "1461446703485210103287273052203988822378723970342";

// ---------------------------------------------------------------- stub hook
#[derive(Debug, Clone)]
struct OverrideHook {
    fee: u32,
}
impl HookHandler for OverrideHook {
    fn address(&self) -> Address {
        // only the beforeSwap permission bit (bit 7) set
        Address::from_str("0x0000000000000000000000000000000000000080").unwrap()
    }
    fn before_swap(
        &self,
        _p: BeforeSwapParameters,
        _o: Option<HashMap<Address, HashMap<U256, U256>>>,
        _t: Option<HashMap<Address, HashMap<U256, U256>>>,
    ) -> Result<WithGasEstimate<BeforeSwapOutput>, SimulationError> {
        Ok(WithGasEstimate {
            gas_estimate: 0,
            result: BeforeSwapOutput {
                amount_delta: BeforeSwapDelta(I256::ZERO),
                fee: U24::from(self.fee),
                overwrites: HashMap::new(),
                transient_storage: HashMap::new(),
            },
        })
    }
    fn after_swap(
        &self,
        _p: AfterSwapParameters,
        _o: Option<HashMap<Address, HashMap<U256, U256>>>,
        _t: Option<HashMap<Address, HashMap<U256, U256>>>,
    ) -> Result<WithGasEstimate<AfterSwapDelta>, SimulationError> {
        unreachable!("no afterSwap permission")
    }
    fn fee(&self, _c: &UniswapV4State, _p: SwapParams) -> Result<f64, SimulationError> {
        Err(SimulationError::RecoverableError("not implemented".into()))
    }
    fn spot_price(&self, _b: &Token, _q: &Token) -> Result<f64, SimulationError> {
        Err(SimulationError::RecoverableError("not implemented".into()))
    }
    fn get_amount_ranges(&self, _a: Bytes, _b: Bytes) -> Result<AmountRanges, SimulationError> {
        Err(SimulationError::RecoverableError("not implemented".into()))
    }
    fn delta_transition(
        &mut self,
        _d: ProtocolStateDelta,
        _t: &HashMap<Bytes, Token>,
        _b: &Balances,
    ) -> Result<(), TransitionError> {
        Ok(())
    }
    fn clone_box(&self) -> Box<dyn HookHandler> {
        Box::new(self.clone())
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn is_equal(&self, _o: &dyn HookHandler) -> bool {
        true
    }
}

// ---------------------------------------------------------------- helpers
fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => v.to_string(),
    }
}
fn u256(v: &Value) -> U256 {
    U256::from_str(&s(v)).unwrap()
}
fn i256(v: &Value) -> I256 {
    I256::from_dec_str(&s(v)).unwrap()
}
fn i64v(v: &Value) -> i64 {
    s(v).parse().unwrap()
}

fn token(addr_last: u8) -> Token {
    let mut a = vec![0u8; 20];
    a[19] = addr_last;
    Token::new(&Bytes::from(a), "T", 18, 0, &[Some(10_000)], Default::default(), 100)
}

#[derive(Default)]
struct Counts {
    pass: u64,
    mismatch: u64,
    target_error: u64,
    unsupported: u64,
}

struct Report {
    counts: Counts,
    mismatches: Vec<Value>,
    errors: Vec<Value>,
    unsupported_reasons: HashMap<String, u64>,
}
impl Report {
    fn new() -> Self {
        Report {
            counts: Counts::default(),
            mismatches: vec![],
            errors: vec![],
            unsupported_reasons: HashMap::new(),
        }
    }
    fn unsupported(&mut self, why: &str) {
        self.counts.unsupported += 1;
        *self
            .unsupported_reasons
            .entry(why.to_string())
            .or_default() += 1;
    }
    fn json(&self) -> Value {
        json!({
            "pass": self.counts.pass, "mismatch": self.counts.mismatch,
            "target_error": self.counts.target_error, "unsupported": self.counts.unsupported,
            "unsupported_reasons": self.unsupported_reasons,
            "mismatches": self.mismatches, "target_errors": self.errors,
        })
    }
}

fn quiet<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    panic::catch_unwind(AssertUnwindSafe(f)).map_err(|e| {
        if let Some(s) = e.downcast_ref::<String>() {
            format!("panic: {s}")
        } else if let Some(s) = e.downcast_ref::<&str>() {
            format!("panic: {s}")
        } else {
            "panic".into()
        }
    })
}

// ---------------------------------------------------------------- swaps
fn build_state(pool: &Value, keep_zero_net: bool) -> Result<UniswapV4State, String> {
    let ts = i64v(&pool["tickSpacing"]) as i32;
    let mut net: HashMap<i32, i128> = HashMap::new();
    for p in pool["positions"].as_array().unwrap() {
        let l: i128 = s(&p["liquidity"]).parse().unwrap();
        *net.entry(i64v(&p["tickLower"]) as i32).or_default() += l;
        *net.entry(i64v(&p["tickUpper"]) as i32).or_default() -= l;
    }
    let mut ticks = vec![];
    for (k, v) in net {
        if v != 0 || keep_zero_net {
            ticks.push(TickInfo::new(k, v).map_err(|e| format!("{e:?}"))?);
        }
    }
    ticks.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let fees = UniswapV4Fees::new(
        i64v(&pool["protocolFeeZeroForOne"]) as u32,
        i64v(&pool["protocolFeeOneForZero"]) as u32,
        i64v(&pool["lpFee"]) as u32,
    );
    UniswapV4State::new(
        s(&pool["liquidity"]).parse().unwrap(),
        u256(&pool["sqrtPriceX96"]),
        fees,
        i64v(&pool["tick"]) as i32,
        ts,
        ticks,
    )
    .map_err(|e| format!("{e:?}"))
}

fn cmp(rep: &mut Report, id: &str, fields: &[(&str, String, String)]) {
    let mut bad = vec![];
    for (f, e, g) in fields {
        if e != g {
            bad.push(json!({"id": id, "field": f, "expected": e, "got": g}));
        }
    }
    if bad.is_empty() {
        rep.counts.pass += 1;
    } else {
        rep.counts.mismatch += 1;
        rep.mismatches.extend(bad);
    }
}

fn run_api(v: &Value, rep: &mut Report) {
    let id = s(&v["id"]);
    let pool = &v["pool"];
    let sw = &v["swap"];
    let exp = &v["expect"];
    let zfo = sw["zeroForOne"].as_bool().unwrap();
    let amt = i256(&sw["amountSpecified"]);
    if amt >= I256::ZERO {
        return rep.unsupported("exact-out (get_amount_out is exact-in only)");
    }
    let lim = u256(&sw["sqrtPriceLimitX96"]);
    let default_lim = if zfo {
        U256::from_str(MIN_SQRT).unwrap() + U256::from(1)
    } else {
        U256::from_str(MAX_SQRT).unwrap() - U256::from(1)
    };
    if lim != default_lim {
        return rep.unsupported("custom sqrtPriceLimitX96 (no limit parameter in get_amount_out)");
    }
    let ov = i64v(&sw["lpFeeOverride"]) as u32;
    let r = quiet(|| -> Result<_, String> {
        let mut st = build_state(pool, false)?;
        if ov != 0 {
            st.set_hook_handler(Box::new(OverrideHook { fee: ov }));
        }
        let (tin, tout) = if zfo { (token(1), token(2)) } else { (token(2), token(1)) };
        let amount_in = BigUint::from_str(&amt.unsigned_abs().to_string()).unwrap();
        let res = st
            .get_amount_out(amount_in, &tin, &tout)
            .map_err(|e| format!("{e:?}"))?;
        let ns = res
            .new_state
            .as_any()
            .downcast_ref::<UniswapV4State>()
            .unwrap()
            .parity_state();
        Ok((res.amount.to_string(), ns))
    })
    .and_then(|x| x);
    match (exp.get("revert"), r) {
        (Some(_), Err(_)) => rep.counts.pass += 1,
        (Some(rv), Ok(_)) => {
            rep.counts.target_error += 1;
            rep.errors
                .push(json!({"id": id, "expected_revert": rv, "got": "success"}));
        }
        (None, Err(e)) => {
            rep.counts.target_error += 1;
            rep.errors.push(json!({"id": id, "error": e}));
        }
        (None, Ok((out, (sp, liq, tick)))) => {
            let (e_in, e_out) = if zfo {
                (s(&exp["amount0"]), s(&exp["amount1"]))
            } else {
                (s(&exp["amount1"]), s(&exp["amount0"]))
            };
            let e_in_abs = e_in.trim_start_matches('-').to_string();
            cmp(
                rep,
                &id,
                &[
                    ("amountOut", e_out, out),
                    // get_amount_out implicitly claims the full amount_in is consumed
                    ("amountIn(implied=full)", e_in_abs, amt.unsigned_abs().to_string()),
                    ("sqrtPriceX96", s(&exp["sqrtPriceX96"]), sp.to_string()),
                    ("tick", s(&exp["tick"]), tick.to_string()),
                    ("liquidity", s(&exp["liquidity"]), liq.to_string()),
                ],
            );
        }
    }
}

fn run_raw(v: &Value, rep: &mut Report, keep_zero_net: bool) {
    let id = s(&v["id"]);
    let pool = &v["pool"];
    let sw = &v["swap"];
    let exp = &v["expect"];
    let zfo = sw["zeroForOne"].as_bool().unwrap();
    let amt = i256(&sw["amountSpecified"]);
    let lim = u256(&sw["sqrtPriceLimitX96"]);
    let ov = i64v(&sw["lpFeeOverride"]) as u32;
    // same handling as get_amount_out: non-zero hook fee -> remove override flag
    let ovr = if ov != 0 { Some(ov & 0xBFFFFF) } else { None };
    let r = quiet(|| -> Result<_, String> {
        let st = build_state(pool, keep_zero_net)?;
        let fee = st.parity_fee_pips(zfo, ovr);
        let out = st
            .parity_swap(zfo, amt, Some(lim), ovr)
            .map_err(|e| format!("{e:?}"))?;
        Ok((fee, out))
    })
    .and_then(|x| x);
    match (exp.get("revert"), r) {
        (Some(_), Err(_)) => rep.counts.pass += 1,
        (Some(rv), Ok(_)) => {
            rep.counts.target_error += 1;
            rep.errors
                .push(json!({"id": id, "expected_revert": rv, "got": "success"}));
        }
        (None, Err(e)) => {
            rep.counts.target_error += 1;
            rep.errors.push(json!({"id": id, "error": e}));
        }
        (None, Ok((fee, (calc, rem, sp, liq, tick)))) => {
            // tycho: exact-in -> calc = -(amountOut); exact-out -> calc = +(amountIn)
            // v4 delta (swapper view): specified-token = amt - rem, other token = -calc
            let spec = amt - rem;
            let other = -calc;
            let exact_in = amt < I256::ZERO;
            let (a0, a1) = if zfo == exact_in { (spec, other) } else { (other, spec) };
            cmp(
                rep,
                &id,
                &[
                    ("amount0", s(&exp["amount0"]), a0.to_string()),
                    ("amount1", s(&exp["amount1"]), a1.to_string()),
                    ("swapFee", s(&exp["swapFee"]), fee.to_string()),
                    ("sqrtPriceX96", s(&exp["sqrtPriceX96"]), sp.to_string()),
                    ("tick", s(&exp["tick"]), tick.to_string()),
                    ("liquidity", s(&exp["liquidity"]), liq.to_string()),
                ],
            );
        }
    }
}

// ---------------------------------------------------------------- units
fn unit(v: &Value) -> Result<Value, String> {
    let a = v["args"].as_array().unwrap();
    let e = |x: SimulationError| format!("{x:?}");
    Ok(match v["fn"].as_str().unwrap() {
        "getSqrtPriceAtTick" => {
            json!(tick_math::get_sqrt_ratio_at_tick(i64v(&a[0]) as i32).map_err(e)?.to_string())
        }
        "getTickAtSqrtPrice" => json!(tick_math::get_tick_at_sqrt_ratio(u256(&a[0])).map_err(e)?),
        "getAmount0Delta" | "getAmount1Delta" => {
            let l: u128 = s(&a[2])
                .parse()
                .map_err(|_| "liquidity not u128".to_string())?;
            let f = if v["fn"] == "getAmount0Delta" {
                sqrt_price_math::get_amount0_delta
            } else {
                sqrt_price_math::get_amount1_delta
            };
            json!(f(u256(&a[0]), u256(&a[1]), l, a[3].as_bool().unwrap())
                .map_err(e)?
                .to_string())
        }
        "getNextSqrtPriceFromInput" | "getNextSqrtPriceFromOutput" => {
            let l: u128 = s(&a[1]).parse().unwrap();
            let f = if v["fn"] == "getNextSqrtPriceFromInput" {
                sqrt_price_math::get_next_sqrt_price_from_input
            } else {
                sqrt_price_math::get_next_sqrt_price_from_output
            };
            json!(f(u256(&a[0]), l, u256(&a[2]), a[3].as_bool().unwrap())
                .map_err(e)?
                .to_string())
        }
        "computeSwapStep" => {
            let l: u128 = s(&a[2]).parse().unwrap();
            // tycho's compute_swap_step uses the v3 sign convention (>0 exact in), negate v4's
            let r = swap_math::compute_swap_step(
                u256(&a[0]),
                u256(&a[1]),
                l,
                -i256(&a[3]),
                i64v(&a[4]) as u32,
            )
            .map_err(e)?;
            json!([r.0.to_string(), r.1.to_string(), r.2.to_string(), r.3.to_string()])
        }
        "calculateSwapFee" => {
            let pf = i64v(&a[0]) as u32;
            let lp = i64v(&a[1]) as u32;
            // UniswapV4Fees::calculate_swap_fees_pips via a state; protocol fee in both dirs
            let st = UniswapV4State::new(1, U256::from(1u64) << 96, UniswapV4Fees::new(pf, pf, lp), 0, 1, vec![])
                .map_err(e)?;
            json!(st.parity_fee_pips(true, None))
        }
        other => return Err(format!("unknown fn {other}")),
    })
}

fn norm(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Number(_) | Value::String(_) => Value::String(s(v)),
        _ => v.clone(),
    }
}

fn api_quote(st: &UniswapV4State, zfo: bool, amt: &str) -> Result<(String, (U256, u128, i32)), String> {
    let (tin, tout) = if zfo { (token(1), token(2)) } else { (token(2), token(1)) };
    let res = st
        .get_amount_out(BigUint::from_str(amt).unwrap(), &tin, &tout)
        .map_err(|e| format!("{e:?}").chars().take(80).collect::<String>())?;
    let ns = res
        .new_state
        .as_any()
        .downcast_ref::<UniswapV4State>()
        .unwrap()
        .parity_state();
    Ok((res.amount.to_string(), ns))
}

/// Hand-built minimal reproductions (see FINDINGS.md).
fn repro(swaps_path: Option<&String>) {
    let q96 = U256::from(1u64) << 96;
    // R1: getAmount0Delta(roundUp=false) uses mulDivRoundingUp instead of mulDiv.
    // a = 2^96, b = 2^96 + 1, L = 2^96. v4: floor(floor(L*2^96*(b-a)/b)/a) = floor((a-1)/a) = 0
    let got = sqrt_price_math::get_amount0_delta(q96, q96 + U256::from(1), 1u128 << 96, false).unwrap();
    println!("R1 getAmount0Delta(2^96, 2^96+1, L=2^96, roundDown): tycho={got}  v4=0 (FullMath.mulDiv floor)");

    // R2: dynamic-fee pool (key fee 0x800000) without a beforeSwap override is quoted at LP fee 0.
    // On-chain the pool charges slot0.lpFee (set by the hook via updateDynamicLPFee, no event).
    let mk = |lp: u32| {
        UniswapV4State::new(
            10u128.pow(24),
            q96,
            UniswapV4Fees::new(0, 0, lp),
            0,
            60,
            vec![TickInfo::new(-600, 10i128.pow(24)).unwrap(), TickInfo::new(600, -(10i128.pow(24))).unwrap()],
        )
        .unwrap()
    };
    let amt = "1000000000000000000000"; // 1000e18 into 1e24 L at price 1
    let dyn_q = api_quote(&mk(0x800000), true, amt).unwrap().0;
    let f0 = api_quote(&mk(0), true, amt).unwrap().0;
    let f3000 = api_quote(&mk(3000), true, amt).unwrap().0;
    println!("R2 dynamic-fee pool, 1000e18 in: tycho(0x800000)={dyn_q}  tycho(lp=0)={f0}  tycho(lp=3000, what v4 charges if slot0.lpFee=3000)={f3000}");

    // R3: stale tick after a swap that ends inside a tick range.
    let st = mk(3000);
    let (out, (sp, liq, tick)) = api_quote(&st, false, "1000000000000000000000").unwrap();
    let true_tick = tick_math::get_tick_at_sqrt_ratio(sp).unwrap();
    println!("R3 1000e18 oneForZero on price-1 pool (tick 0): out={out} new sqrtP={sp} L={liq} tycho new tick={tick} true tick(getTickAtSqrtPrice)={true_tick}");

    // R4: pool price inside a liquidity gap -> "No liquidity" error; v4 swaps into the next range.
    let gap = UniswapV4State::new(
        0,
        q96,
        UniswapV4Fees::new(0, 0, 3000),
        0,
        60,
        vec![TickInfo::new(-1200, 10i128.pow(24)).unwrap(), TickInfo::new(-600, -(10i128.pow(24))).unwrap()],
    )
    .unwrap();
    println!("R4 price in gap above [-1200,-600], zfo 1e18: tycho={:?}", api_quote(&gap, true, "1000000000000000000").map(|x| x.0));

    // R5: chained simulation from tycho's returned (stale-tick) state vs the true state
    if let Some(p) = swaps_path {
        let data: Value = serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap();
        let (mut n, mut differ, mut err_diff) = (0, 0, 0);
        let mut examples = vec![];
        for v in data["vectors"].as_array().unwrap() {
            let sw = &v["swap"];
            let exp = &v["expect"];
            if exp.get("revert").is_some() || i256(&sw["amountSpecified"]) >= I256::ZERO || i64v(&sw["lpFeeOverride"]) != 0 {
                continue;
            }
            let zfo = sw["zeroForOne"].as_bool().unwrap();
            let amt = i256(&sw["amountSpecified"]).unsigned_abs().to_string();
            let Ok(st) = build_state(&v["pool"], false) else { continue };
            let Ok(Ok((_, (sp, _, tick)))) = quiet(|| api_quote(&st, zfo, &amt)) else { continue };
            if tick.to_string() == s(&exp["tick"]) || sp.to_string() != s(&exp["sqrtPriceX96"]) {
                continue;
            }
            // tycho's returned state vs the same state with v4's tick
            let mut pool2 = v["pool"].clone();
            pool2["sqrtPriceX96"] = exp["sqrtPriceX96"].clone();
            pool2["liquidity"] = exp["liquidity"].clone();
            let mut pool_t = pool2.clone();
            pool_t["tick"] = json!(tick);
            pool2["tick"] = exp["tick"].clone();
            let (Ok(a), Ok(b)) = (build_state(&pool_t, false), build_state(&pool2, false)) else { continue };
            for dir in [true, false] {
                for amt2 in ["1000", "1000000000000000000", "1000000000000000000000000"] {
                    n += 1;
                    let ra = quiet(|| api_quote(&a, dir, amt2)).and_then(|x| x).map(|x| x.0);
                    let rb = quiet(|| api_quote(&b, dir, amt2)).and_then(|x| x).map(|x| x.0);
                    match (&ra, &rb) {
                        (Ok(x), Ok(y)) if x != y => {
                            differ += 1;
                            if examples.len() < 5 {
                                examples.push(format!("{} dir_zfo={dir} amt={amt2}: stale={x} true={y}", s(&v["id"])));
                            }
                        }
                        (Ok(_), Ok(_)) => {}
                        (Err(_), Err(_)) => {}
                        _ => {
                            err_diff += 1;
                            if examples.len() < 8 {
                                examples.push(format!("{} dir_zfo={dir} amt={amt2}: stale={ra:?} true={rb:?}", s(&v["id"])));
                            }
                        }
                    }
                }
            }
        }
        println!("R5 chained quotes from stale-tick state vs true-tick state: {n} quotes, {differ} differ in amount, {err_diff} differ in error/success");
        for e in examples {
            println!("   {e}");
        }
    }
}

fn main() {
    panic::set_hook(Box::new(|_| {}));
    let _ = liquidity_math::add_liquidity_delta; // keep import used
    let args: Vec<String> = env::args().collect();
    if args[1] == "repro" {
        return repro(args.get(2));
    }
    let path = &args[1];
    let out = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| "report.json".into());
    let data: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let vecs = data["vectors"].as_array().unwrap();
    let is_units = vecs.first().map(|v| v.get("fn").is_some()).unwrap_or(false);
    let report = if is_units {
        let mut rep = Report::new();
        let mut per_fn: HashMap<String, [u64; 3]> = HashMap::new();
        for v in vecs {
            let f = s(&v["fn"]);
            let r = quiet(|| unit(v)).and_then(|x| x);
            let slot = per_fn.entry(f.clone()).or_default();
            match (v["expect"].get("revert"), r) {
                (Some(_), Err(_)) => {
                    rep.counts.pass += 1;
                    slot[0] += 1
                }
                (Some(rv), Ok(g)) => {
                    rep.counts.target_error += 1;
                    slot[2] += 1;
                    rep.errors.push(json!({"fn": f, "args": v["args"], "expected_revert": rv, "got": g}))
                }
                (None, Err(err)) => {
                    rep.counts.target_error += 1;
                    slot[2] += 1;
                    rep.errors.push(json!({"fn": f, "args": v["args"], "expected": v["expect"], "error": err}))
                }
                (None, Ok(g)) => {
                    if norm(&g) == norm(&v["expect"]) {
                        rep.counts.pass += 1;
                        slot[0] += 1
                    } else {
                        rep.counts.mismatch += 1;
                        slot[1] += 1;
                        rep.mismatches.push(json!({"fn": f, "args": v["args"], "expected": v["expect"], "got": g}))
                    }
                }
            }
        }
        let mut j = rep.json();
        j["per_fn_pass_mismatch_error"] = json!(per_fn);
        json!({"file": path, "kind": "units", "units": j})
    } else {
        let mut api = Report::new();
        let mut raw = Report::new();
        let mut raw_all = Report::new();
        for v in vecs {
            run_api(v, &mut api);
            run_raw(v, &mut raw, false);
            run_raw(v, &mut raw_all, true);
        }
        json!({"file": path, "kind": "swaps", "n": vecs.len(),
               "api_get_amount_out": api.json(), "raw_swap_decoder_ticks": raw.json(),
               "raw_swap_all_ticks": raw_all.json()})
    };
    for (k, v) in report.as_object().unwrap() {
        if let Some(o) = v.as_object() {
            println!(
                "{k}: pass={} mismatch={} target_error={} unsupported={}",
                o["pass"], o["mismatch"], o["target_error"], o["unsupported"]
            );
        }
    }
    fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("wrote {out}");
}
