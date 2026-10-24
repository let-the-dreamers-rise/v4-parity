// Minimal hand-built reproductions for FINDINGS.md. Usage: node repro.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const JSBI = require("jsbi");
const { Token, CurrencyAmount } = require("@uniswap/sdk-core");
const { Pool } = require("@uniswap/v4-sdk");
const { TickMath, nearestUsableTick } = require("@uniswap/v3-sdk");

const T0 = new Token(1, "0x0000000000000000000000000000000000000001", 18);
const T1 = new Token(1, "0x0000000000000000000000000000000000000002", 18);
const ZERO_HOOK = "0x0000000000000000000000000000000000000000";
const bps = (got, exp) => (Number(((got - exp) * 10n ** 8n) / exp) / 1e4).toFixed(3);

// ---- independent BigInt port of the v4-core code needed for ONE swap step (no SDK code used)
const Q96 = 1n << 96n;
const divUp = (a, b) => a / b + (a % b ? 1n : 0n);
const mulDivUp = (a, b, c) => divUp(a * b, c);
const calculateSwapFee = (pf, lp) => pf + lp - (pf * lp) / 1000000n; // ProtocolFeeLibrary.calculateSwapFee
const nextFromAmount0Up = (P, L, amt) => mulDivUp(L << 96n, P, (L << 96n) + amt * P); // add=true, no overflow branch
const nextFromAmount1DownSub = (P, L, amt) => P - mulDivUp(amt, Q96, L); // getNextSqrtPriceFromAmount1RoundingDown(add=false)
const amount0Delta = (A, B, L, up) => { if (A > B) [A, B] = [B, A]; return up ? divUp(mulDivUp(L << 96n, B - A, B), A) : ((L << 96n) * (B - A)) / B / A; };
const amount1Delta = (A, B, L, up) => { if (A > B) [A, B] = [B, A]; return up ? mulDivUp(L, B - A, Q96) : (L * (B - A)) / Q96; };
// v4 SwapMath.computeSwapStep, zeroForOne only, assuming the target is NOT reached (asserted)
function v4StepZeroForOne(P, target, L, amountRemaining, fee) {
  if (amountRemaining < 0n) { // exact in
    const lessFee = (-amountRemaining * (1000000n - fee)) / 1000000n;
    if (lessFee >= amount0Delta(target, P, L, true)) throw new Error("repro assumption broken: target reached");
    const next = nextFromAmount0Up(P, L, lessFee);
    return { next, amountIn: lessFee, amountOut: amount1Delta(next, P, L, false), fee: -amountRemaining - lessFee };
  }
  if (amountRemaining >= amount1Delta(target, P, L, false)) throw new Error("repro assumption broken: target reached");
  const next = nextFromAmount1DownSub(P, L, amountRemaining);
  const amountIn = amount0Delta(next, P, L, true);
  return { next, amountIn, amountOut: amountRemaining, fee: mulDivUp(amountIn, fee, 1000000n - fee) };
}

// ---- pool: tickSpacing 60, one full-range position L=1e21, price at tick 100 (inside the [0,60*256) word, so a
// zeroForOne swap's first step targets tick 0's price), LP fee 3000 (30 bps), protocol fee 500 pips (5 bps) each way.
const L = 10n ** 21n;
const lo = nearestUsableTick(TickMath.MIN_TICK, 60), hi = nearestUsableTick(TickMath.MAX_TICK, 60);
const ticks = [{ index: lo, liquidityNet: L.toString(), liquidityGross: L.toString() }, { index: hi, liquidityNet: (-L).toString(), liquidityGross: L.toString() }];
const P = BigInt(TickMath.getSqrtRatioAtTick(100).toString());
const target = BigInt(TickMath.getSqrtRatioAtTick(0).toString());
const LP = 3000n, PF = 500n, SWAPFEE = calculateSwapFee(PF, LP);
const mk = (fee, hooks = ZERO_HOOK) => new Pool(T0, T1, fee, 60, hooks, P.toString(), L.toString(), 100, ticks);

console.log("== F1: protocol fee ignored (30 bps pool, 5 bps protocol fee, swapFee =", SWAPFEE.toString(), "pips)");
{
  const amt = 10n ** 18n;
  const v4 = v4StepZeroForOne(P, target, L, -amt, SWAPFEE);
  const [out] = await mk(3000).getOutputAmount(CurrencyAmount.fromRawAmount(T0, amt.toString()));
  const sdk = BigInt(out.quotient.toString());
  console.log(`exactIn 1e18 token0: v4 out=${v4.amountOut}  sdk out=${sdk}  -> SDK overquotes output by ${bps(sdk, v4.amountOut)} bps`);
  const [outAdj] = await mk(Number(SWAPFEE)).getOutputAmount(CurrencyAmount.fromRawAmount(T0, amt.toString()));
  console.log(`   SDK with fee=calculateSwapFee(pf,lp)=${SWAPFEE}: out=${outAdj.quotient.toString()} (equal: ${outAdj.quotient.toString() === v4.amountOut.toString()})`);
  const want = 10n ** 18n;
  const v4o = v4StepZeroForOne(P, target, L, want, SWAPFEE);
  const [inp] = await mk(3000).getInputAmount(CurrencyAmount.fromRawAmount(T1, want.toString()));
  const sdkIn = BigInt(inp.quotient.toString());
  const v4In = v4o.amountIn + v4o.fee;
  console.log(`exactOut 1e18 token1: v4 in=${v4In}  sdk in=${sdkIn}  -> SDK underquotes input by ${bps(v4In, sdkIn)} bps (relative to SDK quote)`);
}

console.log("\n== F2: dynamic-fee PoolKey (fee=0x800000) with a hook that has no swap permission flags");
{
  // Valid in v4-core: Hooks.isValidHookAddress accepts a hook address with dynamic fee even if it has no flags.
  // v4-core swaps such a pool with slot0.lpFee (0 at init, or whatever the hook set via updateDynamicLPFee).
  const HOOK = "0x0000000000000000000000000000000000001000"; // only AFTER_INITIALIZE flag (bit 12)
  const amt = 10n ** 18n;
  for (const slot0LpFee of [0n, 3000n]) {
    const v4 = v4StepZeroForOne(P, target, L, -amt, slot0LpFee);
    console.log(`  v4 exactIn 1e18 token0 with slot0.lpFee=${slot0LpFee}: out=${v4.amountOut}`);
  }
  const [out] = await mk(0x800000, HOOK).getOutputAmount(CurrencyAmount.fromRawAmount(T0, amt.toString()));
  console.log(`  SDK getOutputAmount: out=${out.quotient.toString()}   (fee passed to v3Swap = ${0x800000} pips)`);
  const [inp] = await mk(0x800000, HOOK).getInputAmount(CurrencyAmount.fromRawAmount(T1, amt.toString()));
  console.log(`  SDK getInputAmount(1e18 token1): in=${inp.quotient.toString()}  (negative input)`);
}

console.log("\n== F3: partial fill invisible (price limit / liquidity exhaustion)");
{
  const vecs = JSON.parse(readFileSync(new URL("../../vectors/swaps.json", import.meta.url))).vectors;
  const v = vecs.find((x) => x.id === "swap-1-38");
  console.log("  vector swap-1-38 (no price limit, pool has no liquidity below current price): v4 expect", JSON.stringify(v.expect));
  // hand-built: exactIn 1e30 token0 into the pool above with price limit = tick 50
  const limit = TickMath.getSqrtRatioAtTick(50);
  const [out, after] = await mk(3000).getOutputAmount(CurrencyAmount.fromRawAmount(T0, (10n ** 30n).toString()), limit);
  const consumed = amount0Delta(BigInt(limit.toString()), P, L, true);
  const consumedWithFee = consumed + mulDivUp(consumed, 3000n, 997000n);
  console.log(`  hand-built: exactIn 1e30 token0, limit=tick 50 -> SDK out=${out.quotient.toString()}, final tick=${after.tickCurrent};`);
  console.log(`  the swap actually consumes only ~${consumedWithFee} token0 (v4 amount0 delta), but the SDK API returns no input amount, so a caller assumes 1e30.`);
}
