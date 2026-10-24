// F1 reproduction: ProtocolFeeUpdated handler writes the packed protocol fee into slot0.lpFee.
// Uses oracle-backed vectors from harness/minimal-vectors.json. Usage: npx tsx harness/repro_fee_event.ts
import { readFileSync } from 'fs';
import { SwapSide } from '@paraswap/core';
import { uniswapV4PoolMath } from '../vendor/src/dex/uniswap-v4/contract-math/uniswap-v4-pool-math';
import { TickMath } from '../vendor/src/dex/uniswap-v4/contract-math/TickMath';
const V: Record<string, any> = Object.fromEntries(JSON.parse(readFileSync('harness/minimal-vectors.json', 'utf8')).vectors.map((v: any) => [v.id, v]));
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
const sell = (st: any, zf: boolean, amt: bigint) => uniswapV4PoolMath.queryOutputs(pool, st, [amt], zf, SwapSide.SELL)[0];
const bps = (got: bigint, exp: bigint) => (Number(got - exp) / Number(exp) * 1e4).toFixed(1);
for (const [label, ids, packed, prevPacked] of [
  ['fee switch ON, zeroForOne-only 250 pips (packed 250)', ['min-pf-250-0-z4o-in', 'min-pf-250-0-o4z-in'], 250n, 0n],
  ['fee switch ON, 50/50 pips (packed 204850)', ['min-pf-50-50-z4o-in'], 50n | (50n << 12n), 0n],
  ['fee switch OFF again, was 50/50 (ProtocolFeeUpdated(0))', ['min-pf-0-z4o-in'], 0n, 50n | (50n << 12n)],
] as [string, string[], bigint, bigint][]) {
  console.log('\n== ' + label);
  for (const id of ids) {
    const v = V[id];
    const st = state(v, prevPacked);
    uniswapV4PoolMath.setProtocolFee(st, packed); // == handleProtocolFeeUpdatedEvent body
    console.log(`  after event: slot0.lpFee=${st.slot0.lpFee} slot0.protocolFee=${st.slot0.protocolFee}  (chain: lpFee=${v.pool.lpFee}, protocolFee=${packed})`);
    const zf = v.swap.zeroForOne, amt = -B(v.swap.amountSpecified);
    const exp = zf ? B(v.expect.amount1) : B(v.expect.amount0);
    const got = sell(st, zf, amt);
    console.log(`  ${id}: quote ${got}  v4 ${exp}  -> ${bps(got, exp)} bps`);
    // next on-chain Swap event (the real v4 result of this same swap): does replay throw (=> state re-fetched) or silently continue?
    const st2 = state(v, prevPacked); uniswapV4PoolMath.setProtocolFee(st2, packed);
    const e = v.expect;
    try {
      uniswapV4PoolMath.swapFromEvent(st2, B(e.amount0) < 0n, B(e.sqrtPriceX96), B(e.tick), B(e.liquidity), B(e.swapFee), B(e.amount0), B(e.amount1), log);
      console.log(`  replay of next Swap event: OK -> corrupted lpFee=${st2.slot0.lpFee} PERSISTS (no re-fetch)`);
    } catch (err: any) { console.log('  replay of next Swap event: THROWS -> isValid=false -> generateState() re-fetch heals it'); }
  }
}
