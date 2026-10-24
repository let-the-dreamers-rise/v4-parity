// v4-parity harness for the official Uniswap TypeScript SDKs.
//   swap vectors -> @uniswap/v4-sdk Pool.getOutputAmount / getInputAmount (which delegate to @uniswap/v3-sdk v3Swap)
//   unit vectors -> @uniswap/v3-sdk TickMath / SqrtPriceMath / SwapMath (the primitives v4-sdk reuses)
// Usage: node harness.mjs <vectors.json> [--out report.json] [--mode integrator|fee-adjusted|both]
// A file whose vectors have a `pool` field is treated as swap vectors; one whose vectors have `fn` as unit vectors.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const JSBI = require("jsbi");
const { Token, CurrencyAmount } = require("@uniswap/sdk-core");
const v3 = require("@uniswap/v3-sdk");
const v4 = require("@uniswap/v4-sdk");
const { TickMath, SqrtPriceMath, SwapMath, Tick, TickListDataProvider } = v3;

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--"));
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
if (!file) { console.error("usage: node harness.mjs <vectors.json> [--out report.json] [--mode both]"); process.exit(2); }
const OUT = opt("out", "report.json");
const MODE = opt("mode", "both");
const LIMIT = Number(opt("limit", "0"));

const data = JSON.parse(readFileSync(file, "utf8"));
let vectors = data.vectors ?? data;
if (LIMIT) vectors = vectors.slice(0, LIMIT);
const B = (x) => JSBI.BigInt(typeof x === "string" ? x : String(x));
const S = (x) => (x === null || x === undefined ? x : x.toString());

const versions = Object.fromEntries(
  ["@uniswap/v4-sdk", "@uniswap/v3-sdk", "@uniswap/sdk-core", "jsbi"].map((p) => [p, JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url), "utf8")).version]),
);

// ---------------- v4 protocol-fee math (ProtocolFeeLibrary.calculateSwapFee), used only for the fee-adjusted mode
function calculateSwapFee(pf, lp) {
  const p = BigInt(pf), l = BigInt(lp);
  return Number(p + l - (p * l) / 1000000n);
}

// ---------------- swap vectors
const T0 = new Token(1, "0x0000000000000000000000000000000000000001", 18, "T0");
const T1 = new Token(1, "0x0000000000000000000000000000000000000002", 18, "T1");
const HOOKS = "0x0000000000000000000000000000000000000000";

function buildTicks(positions) {
  const m = new Map();
  for (const p of positions) {
    const L = BigInt(p.liquidity);
    for (const [t, net] of [[p.tickLower, L], [p.tickUpper, -L]]) {
      const cur = m.get(t) ?? { net: 0n, gross: 0n };
      cur.net += net; cur.gross += L; m.set(t, cur);
    }
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, v]) => new Tick({ index, liquidityGross: v.gross.toString(), liquidityNet: v.net.toString() }));
}

// wraps the SDK tick data provider to abort runaway loops (v3Swap's loop compares JSBI objects with !==)
class GuardedProvider {
  constructor(inner) { this.inner = inner; this.calls = 0; }
  async getTick(t) { return this.inner.getTick(t); }
  async nextInitializedTickWithinOneWord(tick, lte, ts) {
    if (++this.calls > 200000) throw new Error("HARNESS_STEP_GUARD: >200000 swap steps (non-terminating loop)");
    return this.inner.nextInitializedTickWithinOneWord(tick, lte, ts);
  }
}

// returns { ok:{amount0,amount1,sqrtPriceX96,tick,liquidity} } | { error } | { unsupported }
async function runSdkSwap(v, mode) {
  const { pool: p, swap: s } = v;
  const pf = s.zeroForOne ? p.protocolFeeZeroForOne : p.protocolFeeOneForZero;
  let fee;
  if (mode === "integrator") {
    // what production integrators do (e.g. smart-order-router V4PoolProvider.instantiatePool): fee = PoolKey.fee
    // (static LP fee); slot0.protocolFee is not an input the SDK has.
    if (s.lpFeeOverride !== 0) return { unsupported: "dynamic-fee hook override: v4-sdk only simulates hookless pools (Unsupported hook)" };
    fee = p.lpFee;
  } else {
    const lp = s.lpFeeOverride !== 0 ? s.lpFeeOverride & ~0x400000 : p.lpFee;
    fee = pf === 0 ? lp : calculateSwapFee(pf, lp);
  }
  if (fee >= 1000000) return { unsupported: `fee ${fee} >= 1e6 rejected by Pool constructor (invariant FEE)` };
  let pool;
  const provider = new GuardedProvider(new TickListDataProvider(buildTicks(p.positions), p.tickSpacing));
  try {
    pool = new v4.Pool(T0, T1, fee, p.tickSpacing, HOOKS, p.sqrtPriceX96, p.liquidity, p.tick, provider);
  } catch (e) {
    return { error: `Pool constructor: ${e.message}` };
  }
  const amt = BigInt(s.amountSpecified);
  const exactIn = amt < 0n;
  const limit = B(s.sqrtPriceLimitX96);
  try {
    let calc, after;
    if (exactIn) {
      const inCur = s.zeroForOne ? T0 : T1;
      const [out, np] = await pool.getOutputAmount(CurrencyAmount.fromRawAmount(inCur, (-amt).toString()), limit);
      calc = BigInt(out.quotient.toString()); // received
      after = np;
    } else {
      const outCur = s.zeroForOne ? T1 : T0;
      const [inp, np] = await pool.getInputAmount(CurrencyAmount.fromRawAmount(outCur, amt.toString()), limit);
      calc = -BigInt(inp.quotient.toString()); // paid
      after = np;
    }
    // The SDK API returns only the calculated side; the specified side is implicitly the full amountSpecified.
    const specified = amt; // v4 sign: exactIn -> negative (paid), exactOut -> positive (received)
    const specIs0 = exactIn === s.zeroForOne; // exactIn&&0->1: specified is token0; exactOut&&1->0: specified is token0
    return {
      ok: {
        amount0: (specIs0 ? specified : calc).toString(),
        amount1: (specIs0 ? calc : specified).toString(),
        sqrtPriceX96: after.sqrtRatioX96.toString(),
        tick: after.tickCurrent,
        liquidity: after.liquidity.toString(),
      },
      specIs0,
    };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function runSwaps() {
  const modes = MODE === "both" ? ["integrator", "fee-adjusted"] : [MODE];
  const report = { target: "uniswap-v4-sdk-ts", versions, file, kind: "swaps", modes: {} };
  for (const mode of modes) {
    const counts = { PASS: 0, MISMATCH: 0, TARGET_ERROR: 0, UNSUPPORTED: 0 };
    const fieldCounts = {};
    const mismatches = [], errors = [], unsupported = {};
    const mismatchClasses = { partialFillOnly: 0, mathOrFee: 0 };
    for (const v of vectors) {
      const r = await runSdkSwap(v, mode);
      const exp = v.expect;
      if (r.unsupported) { counts.UNSUPPORTED++; unsupported[r.unsupported.split(":")[0]] = (unsupported[r.unsupported.split(":")[0]] ?? 0) + 1; continue; }
      if (exp.revert) {
        if (r.error) { counts.PASS++; continue; } // both reject
        counts.TARGET_ERROR++;
        errors.push({ id: v.id, kind: "v4 reverted, target quoted", expected: { revert: exp.revert }, got: r.ok });
        continue;
      }
      if (r.error) {
        counts.TARGET_ERROR++;
        errors.push({ id: v.id, kind: "target threw, v4 succeeded", got: r.error, expected: exp });
        continue;
      }
      const bad = [];
      const calcField = r.specIs0 ? "amount1" : "amount0";
      for (const f of ["amount0", "amount1", "sqrtPriceX96", "tick", "liquidity"]) {
        if (String(exp[f]) !== String(r.ok[f])) {
          const role = f === calcField ? "calculated" : f.startsWith("amount") ? "specified" : "state";
          const d = { id: v.id, field: f, role, expected: String(exp[f]), got: String(r.ok[f]) };
          if (f.startsWith("amount")) d.diff = (BigInt(r.ok[f]) - BigInt(exp[f])).toString();
          bad.push(d);
          fieldCounts[`${f}(${role})`] = (fieldCounts[`${f}(${role})`] ?? 0) + 1;
        }
      }
      if (bad.length) {
        counts.MISMATCH++; mismatches.push(...bad);
        // sub-class: only the specified side differs => v4 partially filled; the SDK API cannot report that
        if (bad.every((b) => b.role === "specified")) mismatchClasses.partialFillOnly++; else mismatchClasses.mathOrFee++;
      } else counts.PASS++;
    }
    report.modes[mode] = { counts, mismatchClasses, fieldCounts, unsupported, errors, mismatches };
    console.log(`[swaps:${mode}]`, JSON.stringify(counts), JSON.stringify(mismatchClasses), JSON.stringify(fieldCounts), JSON.stringify(unsupported));
  }
  return report;
}

// ---------------- unit vectors
function unitCall(fn, a) {
  switch (fn) {
    case "getSqrtPriceAtTick": return TickMath.getSqrtRatioAtTick(Number(a[0])).toString();
    case "getTickAtSqrtPrice": return String(TickMath.getTickAtSqrtRatio(B(a[0])));
    case "getAmount0Delta": return SqrtPriceMath.getAmount0Delta(B(a[0]), B(a[1]), B(a[2]), a[3] === true || a[3] === "true").toString();
    case "getAmount1Delta": return SqrtPriceMath.getAmount1Delta(B(a[0]), B(a[1]), B(a[2]), a[3] === true || a[3] === "true").toString();
    case "getNextSqrtPriceFromInput": return SqrtPriceMath.getNextSqrtPriceFromInput(B(a[0]), B(a[1]), B(a[2]), a[3] === true || a[3] === "true").toString();
    case "getNextSqrtPriceFromOutput": return SqrtPriceMath.getNextSqrtPriceFromOutput(B(a[0]), B(a[1]), B(a[2]), a[3] === true || a[3] === "true").toString();
    case "computeSwapStep": {
      // v4: amountRemaining < 0 = exact in. v3-sdk: amountRemaining >= 0 = exact in. Negate.
      const r = SwapMath.computeSwapStep(B(a[0]), B(a[1]), B(a[2]), JSBI.unaryMinus(B(a[3])), B(a[4]));
      return r.map((x) => x.toString());
    }
    default: return { unsupported: `${fn}: no equivalent exported by @uniswap/v3-sdk or @uniswap/v4-sdk` };
  }
}

const U160 = (1n << 160n) - 1n, U256 = (1n << 256n) - 1n;
function runUnits() {
  const counts = { PASS: 0, MISMATCH: 0, TARGET_ERROR: 0, UNSUPPORTED: 0 };
  const byFn = {};
  const mismatches = [], errors = [];
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    const id = `${v.fn}#${i}`;
    byFn[v.fn] ??= { PASS: 0, MISMATCH: 0, TARGET_ERROR: 0, UNSUPPORTED: 0 };
    let got, err;
    try { got = unitCall(v.fn, v.args); } catch (e) { err = e.message || String(e) || e.constructor.name; }
    const bump = (k) => { counts[k]++; byFn[v.fn][k]++; };
    if (got && got.unsupported) { bump("UNSUPPORTED"); continue; }
    const exp = v.expect;
    if (exp && exp.revert) {
      if (err !== undefined) { bump("PASS"); continue; }
      // v4 reverts on uint160/uint256 overflow of results; the SDK (JSBI, unbounded) does not
      bump("TARGET_ERROR");
      const vals = Array.isArray(got) ? got : [got];
      const over = vals.some((x) => BigInt(x) > U256) ? "result>uint256" : vals.some((x) => BigInt(x) > U160) ? "result>uint160" : "in-range";
      errors.push({ id, fn: v.fn, args: v.args, kind: "v4 reverted, target returned", expected: exp, got, resultRange: over });
      continue;
    }
    if (err !== undefined) { bump("TARGET_ERROR"); errors.push({ id, fn: v.fn, args: v.args, kind: "target threw, v4 succeeded", expected: exp, got: err }); continue; }
    const e = Array.isArray(exp) ? exp.map(String) : [String(exp)];
    const g = Array.isArray(got) ? got : [got];
    const names = v.fn === "computeSwapStep" ? ["sqrtPriceNextX96", "amountIn", "amountOut", "feeAmount"] : ["result"];
    const bad = [];
    for (let k = 0; k < e.length; k++) if (e[k] !== g[k]) bad.push({ id, fn: v.fn, args: v.args, field: names[k], expected: e[k], got: g[k] });
    if (bad.length) { bump("MISMATCH"); mismatches.push(...bad); } else bump("PASS");
  }
  console.log("[units]", JSON.stringify(counts));
  for (const [k, c] of Object.entries(byFn)) console.log("   ", k.padEnd(28), JSON.stringify(c));
  return { target: "uniswap-v4-sdk-ts (v3-sdk primitives)", versions, file, kind: "units", counts, byFn, errors, mismatches };
}

const isSwap = vectors.length && vectors[0].pool !== undefined;
const report = isSwap ? await runSwaps() : runUnits();
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(`wrote ${OUT}`);
