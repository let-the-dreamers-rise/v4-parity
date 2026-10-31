// Same as live_schedule.ts, but feeds the handler the value the way production does:
// ethers v5 Interface.parseLog decodes the uint24 `protocolFee` as a JS number, and the
// handler at uniswap-v4-pool.ts:245 passes it on unconverted. Run for several packed values.
import { readFileSync } from 'fs';
import { utils } from 'ethers';
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
// Decode a ProtocolFeeUpdated log exactly as uniswap-v4-pool.ts does (ethers v5 Interface).
const iface = new utils.Interface(['event ProtocolFeeUpdated(bytes32 indexed id, uint24 protocolFee)']);
function decoded(packed: bigint) {
  const ev = iface.getEvent('ProtocolFeeUpdated');
  const parsed = iface.parseLog({ topics: [iface.getEventTopic(ev), utils.hexZeroPad('0x01', 32)], data: utils.defaultAbiCoder.encode(['uint24'], [packed]) });
  return parsed.args.protocolFee; // == event.args.protocolFee in handleProtocolFeeUpdatedEvent
}
const pool = { id: '0x', key: { currency0: '0', currency1: '1', fee: '3000', tickSpacing: 60, hooks: '0x0' } };
const v = V['min-pf-250-0-z4o-in'];
const cases: [string, bigint][] = [['500/500 (Proposal 100 tier)', 500n | (500n << 12n)], ['50/50', 50n | (50n << 12n)], ['250 on 0->1 only', 250n], ['switched off (0)', 0n]];
const events = [
  { z: true, a0: -(10n ** 18n), a1: 996500006986746537n, p: 79228083563399838582041403494n, t: -1n, l: 10n ** 24n },
  { z: false, a0: 996500006986746537n, a1: -(10n ** 18n), p: 79228241465207511220470626640n, t: 0n, l: 10n ** 24n },
];
for (const [name, packed] of cases) {
  const arg = decoded(packed);
  console.log(`== ${name}: packed ${packed}, decoded arg typeof ${typeof arg} = ${arg}`);
  for (const zf of [true, false]) for (const side of [SwapSide.SELL, SwapSide.BUY]) {
    const bad = state(v, 0n); uniswapV4PoolMath.setProtocolFee(bad, arg as any);
    let r: string; try { r = String(uniswapV4PoolMath.queryOutputs(pool, bad, [10n ** 18n], zf, side)[0]); } catch (e: any) { r = 'THROWS: ' + String(e.message).slice(0, 60); }
    console.log(`  quote zeroForOne=${zf} ${side === SwapSide.SELL ? 'exact-in ' : 'exact-out'}: ${r}`);
  }
  const bad = state(v, 0n); uniswapV4PoolMath.setProtocolFee(bad, arg as any);
  try { uniswapV4PoolMath.swapFromEvent(bad, events[0].z, events[0].p, events[0].t, events[0].l, 3499n, events[0].a0, events[0].a1, log); console.log('  next Swap replay: accepted, bad lpFee kept -> pool stays unquotable'); }
  catch { console.log('  next Swap replay: throws -> pool re-fetched from chain (heals)'); }
}
