// Prop 100 live schedule: 30 bps static pool -> 5 bps protocol fee (500 pips), same both directions.
// Compares the quote after handleProtocolFeeUpdatedEvent with the quote from correctly-set state
// (ParaSwap's math matches v4-core exactly on correct state; see report-swaps.json).
import { readFileSync } from 'fs';
import { SwapSide } from '@paraswap/core';
import { uniswapV4PoolMath } from '../vendor/src/dex/uniswap-v4/contract-math/uniswap-v4-pool-math';
const V: any = Object.fromEntries(JSON.parse(readFileSync('harness/minimal-vectors.json', 'utf8')).vectors.map((v: any) => [v.id, v]));
const B = BigInt;
const log: any = { info() {}, warn() {}, error() {}, debug() {} };
function state(v: any, protocolFee: bigint) {
  const p = v.pool;
  const st: any = { id: '0x', token0: '0', token1: '1', fee: String(p.lpFee), hooks: '0x0', feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, liquidity: 0n,
    slot0: { sqrtPriceX96: B(p.sqrtPriceX96), tick: B(p.tick), protocolFee, lpFee: B(p.lpFee) }, tickSpacing: p.tickSpacing, ticks: {}, tickBitmap: {}, isValid: true };
  for (const q of p.positions) uniswapV4PoolMath.modifyLiquidity(st, { liquidityDelta: B(q.liquidity), tickLower: B(q.tickLower), tickUpper: B(q.tickUpper), tickSpacing: B(p.tickSpacing) });
  return st;
}
const pool = { id: '0x', key: { currency0: '0', currency1: '1', fee: '3000', tickSpacing: 60, hooks: '0x0' } };
const v = V['min-pf-250-0-z4o-in'];
const packed = 500n | (500n << 12n);
for (const zf of [true, false]) {
  for (const side of [SwapSide.SELL, SwapSide.BUY]) {
    const good = state(v, packed);
    const bad = state(v, 0n); uniswapV4PoolMath.setProtocolFee(bad, packed);
    const amt = 10n ** 18n;
    const q = (st: any) => { try { return uniswapV4PoolMath.queryOutputs(pool, st, [amt], zf, side)[0]; } catch (e: any) { return 'THROWS: ' + e.message; } };
    const g = q(good), b = q(bad);
    const d = typeof g === 'bigint' && typeof b === 'bigint' && g !== 0n ? (Number(b - g) / Number(g) * 1e4).toFixed(1) + ' bps' : 'n/a';
    console.log(`zeroForOne=${zf} ${side === SwapSide.SELL ? 'SELL(exact-in)' : 'BUY(exact-out)'}: correct ${g}  after-event ${b}  diff ${d}  (lpFee now ${bad.slot0.lpFee})`);
  }
}

// Does the next real Swap event heal the corrupted state? Event values below come from real v4-core
// (v4-parity Oracle, same pool, protocol fee 500/500): replay must match them or the pool is re-fetched.
const events = [
  { z: true, a0: -(10n ** 18n), a1: 996500006986746537n, p: 79228083563399838582041403494n, t: -1n, l: 10n ** 24n },
  { z: false, a0: 996500006986746537n, a1: -(10n ** 18n), p: 79228241465207511220470626640n, t: 0n, l: 10n ** 24n },
];
for (const e of events) {
  const bad = state(v, 0n); uniswapV4PoolMath.setProtocolFee(bad, packed);
  try {
    uniswapV4PoolMath.swapFromEvent(bad, e.z, e.p, e.t, e.l, 3499n, e.a0, e.a1, log);
    console.log(`replay zeroForOne=${e.z}: OK, corrupted lpFee ${bad.slot0.lpFee} persists`);
  } catch (err: any) {
    console.log(`replay zeroForOne=${e.z}: throws -> pool marked invalid and re-fetched (heals): ${String(err.message).slice(0, 80)}`);
  }
}
