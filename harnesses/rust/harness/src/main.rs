//! v4-parity harness for the Rust Uniswap SDKs.
//!
//! Targets (pinned in Cargo.toml / Cargo.lock):
//!   - uniswap-v4-sdk 2.0.0 (shuhuiluo) -> swaps via v4 `Pool` (which delegates to uniswap-v3-sdk 7.0.0 `v3_swap`)
//!   - uniswap-v3-sdk 7.0.0 math (`utils::*`)        -> unit vectors, target "v3sdk"
//!   - uniswap_v3_math 0.6.2 (0xKitsune)             -> unit vectors, target "v3math"
//!
//! Usage: v4parity-rust swaps <swaps.json> [report.json]
//!        v4parity-rust units <units.json> [report.json]
use alloy_primitives::{aliases::U24, Address, I256, U160, U256};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::pin;
use std::str::FromStr;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
use uniswap_sdk_core::prelude::*;
use uniswap_v3_sdk::prelude::{
    self as v3, v3_swap, Tick, TickListDataProvider,
};
use uniswap_v4_sdk::prelude::Pool as V4Pool;

// ---------------- tiny executor (all futures here are immediately ready) ----------------
fn block_on<F: Future>(f: F) -> F::Output {
    fn noop_raw() -> RawWaker {
        fn no(_: *const ()) {}
        fn clone(_: *const ()) -> RawWaker {
            noop_raw()
        }
        static VT: RawWakerVTable = RawWakerVTable::new(clone, no, no, no);
        RawWaker::new(std::ptr::null(), &VT)
    }
    let waker = unsafe { Waker::from_raw(noop_raw()) };
    let mut cx = Context::from_waker(&waker);
    let mut f = pin!(f);
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
    }
}

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.clone(),
        other => other.to_string(),
    }
}
fn u256(v: &Value) -> U256 {
    U256::from_str(&s(v)).unwrap()
}
fn i256(v: &Value) -> I256 {
    I256::from_dec_str(&s(v)).unwrap()
}
fn i64v(v: &Value) -> i64 {
    s(v).parse::<i64>().unwrap()
}

fn panic_msg(e: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = e.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = e.downcast_ref::<&str>() {
        s.to_string()
    } else {
        "panic".into()
    }
}

#[derive(Default)]
struct Tally {
    counts: BTreeMap<String, u64>,
    mismatches: Vec<Value>,
    errors: Vec<Value>,
    unsupported: Vec<Value>,
}
impl Tally {
    fn bump(&mut self, k: &str) {
        *self.counts.entry(k.to_string()).or_default() += 1;
    }
    fn json(&self) -> Value {
        json!({ "counts": self.counts, "mismatches": self.mismatches, "target_errors": self.errors,
                "unsupported": self.unsupported })
    }
}

// ---------------- swaps ----------------

/// v4 ProtocolFeeLibrary.calculateSwapFee
fn calc_swap_fee(pf: u64, lp: u64) -> u64 {
    pf + lp - (pf * lp) / 1_000_000
}

struct Out {
    amount0: I256,
    amount1: I256,
    sqrt: U160,
    tick: i32,
    liquidity: u128,
    api_calc: Option<I256>, // calculated amount via get_output_amount/get_input_amount
    api_tick: Option<i32>,  // tick_current of the pool returned by the high-level API
    ctor_tick: i32,
}

fn token(addr: &str) -> Currency {
    Currency::Token(Token::new(1, addr.parse::<Address>().unwrap(), 18, None, None, 0, 0))
}

/// Build the v4-sdk pool the way an integrator does from chain data, then run the swap.
/// `fee_override`: None = integrator mode (fee = PoolKey/static lpFee via constructor);
/// Some(f) = harness sets pool.fee = f (the total v4 swapFee) after construction.
fn run_swap(v: &Value, fee_override: Option<u32>) -> Result<Out, String> {
    let p = &v["pool"];
    let sw = &v["swap"];
    let ts = i64v(&p["tickSpacing"]) as i32;
    let lp_fee = i64v(&p["lpFee"]) as u32;
    let sqrt = U160::from(u256(&p["sqrtPriceX96"]));
    let liq: u128 = s(&p["liquidity"]).parse().unwrap();
    // aggregate initialized ticks
    let mut ticks: BTreeMap<i32, (u128, i128)> = BTreeMap::new();
    for pos in p["positions"].as_array().unwrap() {
        let l: u128 = s(&pos["liquidity"]).parse().unwrap();
        let lo = i64v(&pos["tickLower"]) as i32;
        let hi = i64v(&pos["tickUpper"]) as i32;
        let e = ticks.entry(lo).or_default();
        e.0 += l;
        e.1 += l as i128;
        let e = ticks.entry(hi).or_default();
        e.0 += l;
        e.1 -= l as i128;
    }
    let tick_vec: Vec<Tick<i32>> = ticks.iter().map(|(i, (g, n))| Tick::new(*i, *g, *n)).collect();
    let provider = TickListDataProvider::new(tick_vec, ts);

    let mut pool = V4Pool::new_with_tick_data_provider(
        token("0x0000000000000000000000000000000000000001"),
        token("0x0000000000000000000000000000000000000002"),
        U24::from(if fee_override.is_some() { 0 } else { lp_fee }),
        ts,
        Address::ZERO,
        sqrt,
        liq,
        provider,
    )
    .map_err(|e| format!("ctor: {e:?}"))?;
    let ctor_tick = pool.tick_current;
    if let Some(f) = fee_override {
        pool.fee = U24::from(f);
    }

    let zfo = sw["zeroForOne"].as_bool().unwrap();
    let s4 = i256(&sw["amountSpecified"]); // v4: <0 exact in
    let limit = U160::from(u256(&sw["sqrtPriceLimitX96"]));
    let s3 = -s4; // v3 convention used by the SDK: >0 exact in

    // Core: exactly what V4Pool::swap (private) does for a hookless pool
    let st = block_on(v3_swap(
        pool.fee,
        pool.sqrt_price_x96,
        pool.tick_current,
        pool.liquidity,
        pool.tick_spacing,
        &pool.tick_data_provider,
        zfo,
        s3,
        Some(limit),
    ))
    .map_err(|e| format!("v3_swap: {e:?}"))?;
    let used = s3 - st.amount_specified_remaining;
    let (a0, a1) = if zfo == (s3 > I256::ZERO) {
        (used, st.amount_calculated)
    } else {
        (st.amount_calculated, used)
    };

    // High-level public API (what integrators actually call)
    let (api_calc, api_tick) = if s4.is_zero() {
        (None, None)
    } else {
        let exact_in = s4 < I256::ZERO;
        let (c_in, c_out) = if zfo { (pool.currency0.clone(), pool.currency1.clone()) } else { (pool.currency1.clone(), pool.currency0.clone()) };
        let r = if exact_in {
            let amt = CurrencyAmount::from_raw_amount(c_in, (-s4).to_big_int()).map_err(|e| format!("{e:?}"))?;
            block_on(pool.get_output_amount(&amt, Some(limit))).map(|(o, np)| (I256::from_big_int(o.quotient()), np.tick_current))
        } else {
            let amt = CurrencyAmount::from_raw_amount(c_out, s4.to_big_int()).map_err(|e| format!("{e:?}"))?;
            block_on(pool.get_input_amount(&amt, Some(limit))).map(|(i, np)| (-I256::from_big_int(i.quotient()), np.tick_current))
        };
        match r {
            Ok((c, t)) => (Some(c), Some(t)),
            Err(_) => (None, None),
        }
    };

    Ok(Out {
        amount0: -a0,
        amount1: -a1,
        sqrt: st.sqrt_price_x96,
        tick: st.tick_current,
        liquidity: st.liquidity,
        api_calc,
        api_tick,
        ctor_tick,
    })
}

fn compare_swap(v: &Value, out: &Out) -> Vec<Value> {
    let e = &v["expect"];
    let id = &v["id"];
    let mut m = vec![];
    let mut chk = |f: &str, exp: String, got: String| {
        if exp != got {
            m.push(json!({"id": id, "field": f, "expected": exp, "got": got}));
        }
    };
    chk("amount0", s(&e["amount0"]), out.amount0.to_string());
    chk("amount1", s(&e["amount1"]), out.amount1.to_string());
    chk("sqrtPriceX96", s(&e["sqrtPriceX96"]), out.sqrt.to_string());
    chk("tick", s(&e["tick"]), out.tick.to_string());
    chk("liquidity", s(&e["liquidity"]), out.liquidity.to_string());
    m
}

fn swaps(path: &str, report: &str) {
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let vecs = data["vectors"].as_array().unwrap();
    std::panic::set_hook(Box::new(|_| {}));

    // mode A: integrator; mode B: fee field = full v4 swapFee (protocol fee + override folded in)
    let mut a = Tally::default();
    let mut b = Tally::default();
    // mode A restricted to vectors where the direction's protocol fee is 0 and no override (pure math check)
    let mut a_nopf = Tally::default();
    // high level API checks (mode B fee, so only API-layer effects show)
    let mut api = Tally::default();
    let mut ctor_tick_mismatch = 0u64;
    let mut api_partial: Vec<Value> = vec![];
    let mut a_err_bps: Vec<f64> = vec![];

    for v in vecs {
        let p = &v["pool"];
        let sw = &v["swap"];
        let zfo = sw["zeroForOne"].as_bool().unwrap();
        let pf = if zfo { i64v(&p["protocolFeeZeroForOne"]) } else { i64v(&p["protocolFeeOneForZero"]) } as u64;
        let ovr = i64v(&sw["lpFeeOverride"]) as u64;
        let lp = i64v(&p["lpFee"]) as u64;
        let eff_lp = if ovr & 0x400000 != 0 { ovr & !0x400000 } else { lp };
        let swap_fee = if pf == 0 { eff_lp } else { calc_swap_fee(pf, eff_lp) };
        if let Some(sf) = v["expect"].get("swapFee") {
            assert_eq!(sf.as_u64().unwrap(), swap_fee, "harness swapFee calc disagrees with vector {}", v["id"]);
        }
        let exp_revert = v["expect"].get("revert").is_some();
        let id = v["id"].clone();

        for (mode, tally) in [("A", &mut a), ("B", &mut b)] {
            let pure = pf == 0 && ovr == 0;
            if mode == "A" && ovr != 0 {
                tally.bump("unsupported");
                tally.unsupported.push(json!({"id": id, "reason": "lpFeeOverride (dynamic-fee hook) not expressible"}));
                continue;
            }
            let fee = if mode == "B" { Some(swap_fee as u32) } else { None };
            let r = catch_unwind(AssertUnwindSafe(|| run_swap(v, fee)));
            let r = match r {
                Ok(x) => x,
                Err(pm) => Err(format!("panic: {}", panic_msg(pm))),
            };
            let status;
            match (&r, exp_revert) {
                (Err(msg), _) if mode == "A" && (msg.contains("ctor") || msg == "panic: FEE") => {
                    status = "unsupported";
                    tally.unsupported.push(json!({"id": id, "reason": format!("constructor rejects lpFee {lp}: {msg}")}));
                }
                (Err(_), true) => status = "pass",
                (Err(msg), false) => {
                    status = "target_error";
                    tally.errors.push(json!({"id": id, "detail": format!("target failed where v4 succeeded: {msg}"), "lpFee": lp, "swapFee": swap_fee}));
                }
                (Ok(o), true) => {
                    status = "target_error";
                    tally.errors.push(json!({"id": id, "detail": format!("v4 reverts {} but target returned amount0={} amount1={}", v["expect"]["revert"], o.amount0, o.amount1)}));
                }
                (Ok(o), false) => {
                    let mm = compare_swap(v, o);
                    if o.ctor_tick.to_string() != s(&p["tick"]) && mode == "A" {
                        ctor_tick_mismatch += 1;
                    }
                    if mm.is_empty() {
                        status = "pass";
                    } else {
                        status = "mismatch";
                        if mode == "A" {
                            // size of error on the calculated side, in bps of expected
                            let s4 = i256(&sw["amountSpecified"]);
                            let exact_in = s4 < I256::ZERO;
                            let (ef, gf) = if zfo == exact_in {
                                (s(&v["expect"]["amount1"]), o.amount1.to_string())
                            } else {
                                (s(&v["expect"]["amount0"]), o.amount0.to_string())
                            };
                            let ev: f64 = ef.parse().unwrap();
                            let gv: f64 = gf.parse().unwrap();
                            if ev.abs() > 1e6 {
                                a_err_bps.push((gv - ev).abs() / ev.abs() * 1e4);
                            }
                        }
                        let fields: Vec<_> = mm.iter().map(|x| x["field"].clone()).collect();
                        tally.mismatches.push(json!({"id": id, "lpFee": lp, "protocolFee": pf, "swapFee": swap_fee,
                                                     "fields": fields, "diffs": mm}));
                    }
                }
            }
            tally.bump(status);
            if mode == "A" && pure {
                a_nopf.bump(status);
                if status == "mismatch" {
                    a_nopf.mismatches.push(tally.mismatches.last().unwrap().clone());
                }
                if status == "target_error" {
                    a_nopf.errors.push(tally.errors.last().unwrap().clone());
                }
            }
            if mode == "B" {
                if let Ok(o) = &r {
                    if !exp_revert {
                        let s4 = i256(&sw["amountSpecified"]);
                        if s4.is_zero() {
                            continue;
                        }
                        let exact_in = s4 < I256::ZERO;
                        let calc_field = if zfo == exact_in { "amount1" } else { "amount0" };
                        let exp_calc = s(&v["expect"][calc_field]);
                        match o.api_calc {
                            None => {
                                api.bump("target_error");
                                api.errors.push(json!({"id": id, "detail": "high-level API errored"}));
                            }
                            Some(c) => {
                                let mut mm = vec![];
                                if c.to_string() != exp_calc {
                                    mm.push(json!({"id": id, "field": calc_field, "expected": exp_calc, "got": c.to_string()}));
                                }
                                let et = s(&v["expect"]["tick"]);
                                if o.api_tick.unwrap().to_string() != et {
                                    mm.push(json!({"id": id, "field": "returnedPool.tick_current", "expected": et,
                                                   "got": o.api_tick.unwrap().to_string(),
                                                   "sqrtPriceX96": s(&v["expect"]["sqrtPriceX96"])}));
                                }
                                // the specified side: API assumes full amount used
                                let spec_field = if calc_field == "amount1" { "amount0" } else { "amount1" };
                                let exp_spec = s(&v["expect"][spec_field]);
                                if exp_spec != s4.to_string() {
                                    api.bump("info_partial_fill_specified_amount_not_reported");
                                    api_partial.push(json!({"id": id, "field": spec_field, "expected": exp_spec, "api_implies": s4.to_string()}));
                                }
                                if false {
                                    mm.push(json!({"id": id, "field": format!("{spec_field}(partial fill: API does not report amount actually consumed)"),
                                                   "expected": exp_spec, "got": s4.to_string()}));
                                }
                                if mm.is_empty() {
                                    api.bump("pass");
                                } else {
                                    api.bump("mismatch");
                                    api.mismatches.push(json!({"id": id, "diffs": mm}));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    a_err_bps.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let q = |f: f64| if a_err_bps.is_empty() { 0.0 } else { a_err_bps[((a_err_bps.len() - 1) as f64 * f) as usize] };
    let rep = json!({
        "target": "uniswap-v4-sdk 2.0.0 (+ uniswap-v3-sdk 7.0.0 v3_swap)",
        "vectors": path, "n": vecs.len(),
        "modeA_integrator": a.json(),
        "modeA_integrator_only_vectors_without_protocolFee_or_override": a_nopf.json(),
        "modeB_fee_field_set_to_v4_swapFee": b.json(),
        "highLevelAPI_get_output_amount_get_input_amount_modeB": api.json(),
        "constructor_tick_differs_from_slot0_tick": ctor_tick_mismatch,
        "highLevelAPI_partial_fills": api_partial,
        "modeA_calculated_side_error_bps": {"n": a_err_bps.len(), "p50": q(0.5), "p90": q(0.9), "max": q(1.0)},
    });
    std::fs::write(report, serde_json::to_string_pretty(&rep).unwrap()).unwrap();
    println!("modeA (integrator, no protocol fee input): {:?}", a.counts);
    println!("modeA restricted to pf=0 & no override:   {:?}", a_nopf.counts);
    println!("modeB (fee := v4 swapFee):                {:?}", b.counts);
    println!("high-level API (modeB fee):               {:?}", api.counts);
    println!("ctor tick != slot0 tick: {ctor_tick_mismatch}");
    println!("modeA calc-side error bps: n={} p50={:.3} p90={:.3} max={:.3}", a_err_bps.len(), q(0.5), q(0.9), q(1.0));
    println!("wrote {report}");
}

fn msg_is(r: &Result<Out, String>, needle: &str) -> bool {
    matches!(r, Err(m) if m.contains(needle))
}

// ---------------- units ----------------

enum UOut {
    Val(String),
    Vals(Vec<String>),
    Unsupported,
}

fn unit_v3sdk(fn_: &str, a: &[Value]) -> Result<UOut, String> {
    let e = |x: v3::Error| format!("{x:?}");
    Ok(match fn_ {
        "getSqrtPriceAtTick" => {
            let t = i64v(&a[0]);
            let t24 = alloy_primitives::aliases::I24::try_from(t).map_err(|x| format!("{x:?}"))?;
            UOut::Val(v3::get_sqrt_ratio_at_tick(t24).map_err(e)?.to_string())
        }
        "getTickAtSqrtPrice" => {
            let p = U160::from(u256(&a[0]));
            UOut::Val(v3::get_tick_at_sqrt_ratio(p).map_err(e)?.to_string())
        }
        "getAmount0Delta" | "getAmount1Delta" => {
            let pa = U160::from(u256(&a[0]));
            let pb = U160::from(u256(&a[1]));
            let l: u128 = s(&a[2]).parse().unwrap();
            let ru = a[3].as_bool().unwrap();
            let r = if fn_ == "getAmount0Delta" { v3::get_amount_0_delta(pa, pb, l, ru) } else { v3::get_amount_1_delta(pa, pb, l, ru) };
            UOut::Val(r.map_err(e)?.to_string())
        }
        "getNextSqrtPriceFromInput" | "getNextSqrtPriceFromOutput" => {
            let p = U160::from(u256(&a[0]));
            let l: u128 = s(&a[1]).parse().unwrap();
            let amt = u256(&a[2]);
            let z = a[3].as_bool().unwrap();
            let r = if fn_ == "getNextSqrtPriceFromInput" { v3::get_next_sqrt_price_from_input(p, l, amt, z) } else { v3::get_next_sqrt_price_from_output(p, l, amt, z) };
            UOut::Val(r.map_err(e)?.to_string())
        }
        "computeSwapStep" => {
            let c = U160::from(u256(&a[0]));
            let t = U160::from(u256(&a[1]));
            let l: u128 = s(&a[2]).parse().unwrap();
            let rem = -i256(&a[3]); // v4 -> v3 sign
            let fee = U24::from(i64v(&a[4]) as u32);
            let (n, ai, ao, f) = v3::compute_swap_step(c, t, l, rem, fee).map_err(e)?;
            UOut::Vals(vec![n.to_string(), ai.to_string(), ao.to_string(), f.to_string()])
        }
        _ => UOut::Unsupported,
    })
}

fn unit_v3math(fn_: &str, a: &[Value]) -> Result<UOut, String> {
    use uniswap_v3_math as m;
    let e = |x: m::error::UniswapV3MathError| format!("{x:?}");
    Ok(match fn_ {
        "getSqrtPriceAtTick" => UOut::Val(m::tick_math::get_sqrt_ratio_at_tick(i64v(&a[0]) as i32).map_err(e)?.to_string()),
        "getTickAtSqrtPrice" => UOut::Val(m::tick_math::get_tick_at_sqrt_ratio(u256(&a[0])).map_err(e)?.to_string()),
        "getAmount0Delta" | "getAmount1Delta" => {
            let l: u128 = s(&a[2]).parse().unwrap();
            let ru = a[3].as_bool().unwrap();
            let r = if fn_ == "getAmount0Delta" {
                m::sqrt_price_math::_get_amount_0_delta(u256(&a[0]), u256(&a[1]), l, ru)
            } else {
                m::sqrt_price_math::_get_amount_1_delta(u256(&a[0]), u256(&a[1]), l, ru)
            };
            UOut::Val(r.map_err(e)?.to_string())
        }
        "getNextSqrtPriceFromInput" | "getNextSqrtPriceFromOutput" => {
            let l: u128 = s(&a[1]).parse().unwrap();
            let z = a[3].as_bool().unwrap();
            let r = if fn_ == "getNextSqrtPriceFromInput" {
                m::sqrt_price_math::get_next_sqrt_price_from_input(u256(&a[0]), l, u256(&a[2]), z)
            } else {
                m::sqrt_price_math::get_next_sqrt_price_from_output(u256(&a[0]), l, u256(&a[2]), z)
            };
            UOut::Val(r.map_err(e)?.to_string())
        }
        "computeSwapStep" => {
            let l: u128 = s(&a[2]).parse().unwrap();
            let rem = -i256(&a[3]);
            let (n, ai, ao, f) = m::swap_math::compute_swap_step(u256(&a[0]), u256(&a[1]), l, rem, i64v(&a[4]) as u32).map_err(e)?;
            UOut::Vals(vec![n.to_string(), ai.to_string(), ao.to_string(), f.to_string()])
        }
        _ => UOut::Unsupported,
    })
}

fn units(path: &str, report: &str) {
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let vecs = data["vectors"].as_array().unwrap();
    std::panic::set_hook(Box::new(|_| {}));
    let mut out = serde_json::Map::new();
    for (name, f) in [("uniswap-v3-sdk 7.0.0 (used by uniswap-v4-sdk 2.0.0)", unit_v3sdk as fn(&str, &[Value]) -> Result<UOut, String>),
                      ("uniswap_v3_math 0.6.2", unit_v3math)] {
        let mut t = Tally::default();
        let mut per_fn: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
        for (i, v) in vecs.iter().enumerate() {
            let fn_ = v["fn"].as_str().unwrap();
            let args = v["args"].as_array().unwrap();
            let r = match catch_unwind(AssertUnwindSafe(|| f(fn_, args))) {
                Ok(x) => x,
                Err(pm) => Err(format!("panic: {}", panic_msg(pm))),
            };
            let exp = &v["expect"];
            let exp_rev = exp.get("revert").is_some();
            let id = json!(format!("unit-{i}-{fn_}"));
            let status = match (r, exp_rev) {
                (Ok(UOut::Unsupported), _) => {
                    t.unsupported.push(json!({"id": id, "reason": "no such function in target"}));
                    "unsupported"
                }
                (Err(_), true) => "pass",
                (Err(m), false) => {
                    t.errors.push(json!({"id": id, "fn": fn_, "args": args, "expected": exp, "got_error": m}));
                    "target_error"
                }
                (Ok(o), true) => {
                    let got = match o { UOut::Val(x) => json!(x), UOut::Vals(x) => json!(x), _ => json!(null) };
                    t.errors.push(json!({"id": id, "fn": fn_, "args": args, "expected": exp, "got": got}));
                    "target_error"
                }
                (Ok(UOut::Val(g)), false) => {
                    if g == s(exp) { "pass" } else {
                        t.mismatches.push(json!({"id": id, "fn": fn_, "args": args, "field": "value", "expected": s(exp), "got": g}));
                        "mismatch"
                    }
                }
                (Ok(UOut::Vals(g)), false) => {
                    let ev: Vec<String> = exp.as_array().unwrap().iter().map(s).collect();
                    if g == ev { "pass" } else {
                        let names = ["sqrtPriceNextX96", "amountIn", "amountOut", "feeAmount"];
                        for k in 0..4 {
                            if g[k] != ev[k] {
                                t.mismatches.push(json!({"id": id, "fn": fn_, "args": args, "field": names[k], "expected": ev[k], "got": g[k]}));
                            }
                        }
                        "mismatch"
                    }
                }
            };
            t.bump(status);
            *per_fn.entry(fn_.to_string()).or_default().entry(status.to_string()).or_default() += 1;
        }
        println!("{name}: {:?}", t.counts);
        for (k, c) in &per_fn {
            println!("   {k}: {c:?}");
        }
        let mut j = t.json();
        j["per_fn"] = json!(per_fn);
        out.insert(name.to_string(), j);
    }
    std::fs::write(report, serde_json::to_string_pretty(&Value::Object(out)).unwrap()).unwrap();
    println!("wrote {report}");
}


// ---------------- hand-built probes ----------------
fn probes() {
    use uniswap_v4_sdk::prelude::DYANMIC_FEE_FLAG;
    let q96 = U160::from(1u128) << 96;
    let c0 = token("0x0000000000000000000000000000000000000001");
    let c1 = token("0x0000000000000000000000000000000000000002");
    let mk = |fee: U24, hooks: Address, sqrt: U160, liq: u128, ticks: Vec<Tick<i32>>, ts: i32| {
        V4Pool::new_with_tick_data_provider(c0.clone(), c1.clone(), fee, ts, hooks, sqrt, liq, TickListDataProvider::new(ticks, ts))
    };

    // P1: chained quote across a tick boundary using the pool returned by get_output_amount
    println!("== P1 chained quote: position [0,600] L=1e18, price at tick 30, fee 3000");
    let sqrt30 = v3::get_sqrt_ratio_at_tick(alloy_primitives::aliases::I24::try_from(30).unwrap()).unwrap();
    let ticks = vec![Tick::new(0, 10u128.pow(18), 10i128.pow(18)), Tick::new(600, 10u128.pow(18), -(10i128.pow(18)))];
    let pool = mk(U24::from(3000), Address::ZERO, sqrt30, 10u128.pow(18), ticks.clone(), 60).unwrap();
    let sqrt0 = v3::get_sqrt_ratio_at_tick(alloy_primitives::aliases::I24::ZERO).unwrap();
    let big = CurrencyAmount::from_raw_amount(c0.clone(), I256::try_from(10u128.pow(18)).unwrap().to_big_int()).unwrap();
    let (out1, p2) = block_on(pool.get_output_amount(&big, Some(sqrt0))).unwrap();
    println!("   swap1 zeroForOne exact-in, limit=sqrt(tick 0): out={} -> returned pool sqrt==sqrt(0): {} tick_current={} liquidity={}  (v4 slot0 would be tick=-1, liquidity=0)",
             out1.quotient(), p2.sqrt_price_x96 == sqrt0, p2.tick_current, p2.liquidity);
    let in2 = CurrencyAmount::from_raw_amount(c1.clone(), I256::try_from(10u128.pow(15)).unwrap().to_big_int()).unwrap();
    let r = block_on(p2.get_output_amount(&in2, None));
    println!("   swap2 oneForZero exact-in 1e15 on returned pool: {:?}", r.as_ref().map(|(o, _)| o.quotient().to_string()).map_err(|e| format!("{e:?}")));
    let mut p2fixed = p2.clone();
    p2fixed.tick_current = -1;
    let r = block_on(p2fixed.get_output_amount(&in2, None));
    println!("   swap2 on same pool with tick_current=-1 (v4 slot0): {:?}  (v4 oracle truth: 996006981039903, see minimal.json chain-truth-oneForZero-from-tick0)",
             r.as_ref().map(|(o, _)| o.quotient().to_string()).map_err(|e| format!("{e:?}")));
    let in3 = CurrencyAmount::from_raw_amount(c0.clone(), I256::try_from(10u128.pow(15)).unwrap().to_big_int()).unwrap();
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| block_on(p2.get_output_amount(&in3, Some(U160::from(4295128740u64))))));
    println!("   swap2' zeroForOne exact-in 1e15 on returned pool: {:?}",
             r.map(|x| x.map(|(o, np)| (o.quotient().to_string(), np.liquidity)).map_err(|e| format!("{e:?}"))).map_err(panic_msg));
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| block_on(p2fixed.get_output_amount(&in3, Some(U160::from(4295128740u64))))));
    println!("   swap2' zeroForOne on tick_current=-1 pool (v4 semantics: no liquidity below 0 -> 0 out): {:?}",
             r.map(|x| x.map(|(o, np)| (o.quotient().to_string(), np.liquidity)).map_err(|e| format!("{e:?}"))).map_err(panic_msg));

    // P2: dynamic-fee pool whose hook has no swap permission bits (e.g. fee set via updateDynamicLPFee)
    println!("== P2 dynamic-fee pool (PoolKey.fee = 0x800000), hook address with only afterInitialize flag (0x1000)");
    let hook: Address = "0x0000000000000000000000000000000000001000".parse().unwrap();
    let fr = vec![Tick::new(-887220, 10u128.pow(21), 10i128.pow(21)), Tick::new(887220, 10u128.pow(21), -(10i128.pow(21)))];
    let dp = mk(DYANMIC_FEE_FLAG, hook, q96, 10u128.pow(21), fr.clone(), 60).unwrap();
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| block_on(dp.get_output_amount(&big, None))));
    println!("   get_output_amount(1e18 token0): {:?}",
             r.map(|x| x.map(|(o, _)| o.quotient().to_string()).map_err(|e| format!("{e:?}"))).map_err(panic_msg));
    let sp = mk(U24::from(3000), Address::ZERO, q96, 10u128.pow(21), fr.clone(), 60).unwrap();
    let r = block_on(sp.get_output_amount(&big, None)).map(|(o, _)| o.quotient().to_string());
    println!("   same pool with fee field set to the slot0 lpFee 3000: {:?}  (v4 truth with lpFee=3000: 996006981039903216)", r);

    // P3: static lpFee = 1_000_000 is valid in v4 (LPFeeLibrary.MAX_LP_FEE, isValid: <=)
    println!("== P3 static lpFee 1_000_000 (valid in v4)");
    let r = std::panic::catch_unwind(AssertUnwindSafe(|| mk(U24::from(1_000_000u32), Address::ZERO, q96, 10u128.pow(21), fr.clone(), 60).map(|_| ())));
    println!("   constructor: {:?}", r.map_err(panic_msg));
    let mut p = mk(U24::from(0u32), Address::ZERO, q96, 0, vec![Tick::new(-600, 1, 1), Tick::new(600, 1, -1)], 60).unwrap();
    p.liquidity = 0; // price in a range with no liquidity
    p.sqrt_price_x96 = v3::get_sqrt_ratio_at_tick(alloy_primitives::aliases::I24::try_from(1200).unwrap()).unwrap();
    p.tick_current = 1200;
    p.fee = U24::from(1_000_000u32);
    let r = block_on(v3_swap(p.fee, p.sqrt_price_x96, p.tick_current, p.liquidity, p.tick_spacing, &p.tick_data_provider, true, I256::try_from(1000).unwrap(), None));
    println!("   v3_swap fee=1e6, exact-in through an empty range: {:?}  (v4: computeSwapStep special-cases feePips==MAX_SWAP_FEE)", r.map(|s| s.amount_calculated).map_err(|e| format!("{e:?}")));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let kind = args.get(1).map(|s| s.as_str()).unwrap_or("");
    if kind == "probe" {
        probes();
        return;
    }
    let path = args.get(2).expect("usage: v4parity-rust swaps|units|probe <vectors.json> [report.json]");
    let def = format!("report-{kind}.json");
    let report = args.get(3).cloned().unwrap_or(def);
    match kind {
        "swaps" => swaps(path, &report),
        "units" => units(path, &report),
        "probe" => probes(),
        _ => panic!("first arg must be swaps or units"),
    }
}
