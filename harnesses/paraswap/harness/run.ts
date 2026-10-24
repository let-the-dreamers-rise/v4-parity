// v4-parity harness for paraswap-dex-lib (commit 291393f0f489b9fe9b0e2ddc3313724f4dbb5cd2, package 5.1.28)
// Usage: npx tsx harness/run.ts <vectors.json> [report.json]
//
// All target code is imported UNMODIFIED from ../vendor/src (copied from src-repo/src).
// The only harness-authored glue that mirrors target code are the two event-handler bodies
// (UniswapV4Pool.handleModifyLiquidityEvent / handleProtocolFeeUpdatedEvent / handleSwapEvent,
// src/dex/uniswap-v4/uniswap-v4-pool.ts:244-306) which are 3-line wrappers around
// uniswapV4PoolMath.* and are reproduced line-for-line below (the class itself needs a live
// dexHelper/RPC, so it is not instantiated).
import { readFileSync, writeFileSync } from 'fs';
import { SwapSide } from '@paraswap/core';
import { uniswapV4PoolMath } from '../vendor/src/dex/uniswap-v4/contract-math/uniswap-v4-pool-math';
import { TickMath } from '../vendor/src/dex/uniswap-v4/contract-math/TickMath';
import { SqrtPriceMath } from '../vendor/src/dex/uniswap-v4/contract-math/SqrtPriceMath';
import { SwapMath } from '../vendor/src/dex/uniswap-v4/contract-math/SwapMath';
import { ProtocolFeeLibrary } from '../vendor/src/dex/uniswap-v4/contract-math/ProtocolFeeLibrary';
import { TickBitMap } from '../vendor/src/dex/uniswap-v4/contract-math/TickBitMap';
import type { PoolState, Pool } from '../vendor/src/dex/uniswap-v4/types';

const B = (x: any) => BigInt(x);
const file = process.argv[2];
const out = process.argv[3] ?? 'report.json';
const data = JSON.parse(readFileSync(file, 'utf8'));
const vectors: any[] = data.vectors ?? data;

type Res = 'PASS' | 'MISMATCH' | 'TARGET_ERROR' | 'UNSUPPORTED';
class Mode {
  counts: Record<string, number> = { PASS: 0, MISMATCH: 0, TARGET_ERROR: 0, UNSUPPORTED: 0 };
  mismatches: any[] = [];
  errors: any[] = [];
  unsupported: Record<string, number> = {};
  constructor(public name: string, public desc: string) {}
  add(r: Res, id: string, extra?: any) {
    this.counts[r]++;
    if (r === 'MISMATCH') this.mismatches.push({ id, ...extra });
    if (r === 'TARGET_ERROR') this.errors.push({ id, ...extra });
    if (r === 'UNSUPPORTED') this.unsupported[extra?.reason ?? '?'] = (this.unsupported[extra?.reason ?? '?'] ?? 0) + 1;
  }
}

const silentLogger: any = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------- swap state builders
function packedProtocolFee(p: any) {
  return (B(p.protocolFeeOneForZero) << 12n) | B(p.protocolFeeZeroForOne);
}
function baseState(p: any, protocolFee: bigint, liquidity: bigint): PoolState {
  return {
    id: '0xpool', token0: '0x0', token1: '0x1', fee: String(p.lpFee),
    hooks: '0x0000000000000000000000000000000000000000',
    feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n,
    liquidity,
    slot0: { sqrtPriceX96: B(p.sqrtPriceX96), tick: B(p.tick), protocolFee, lpFee: B(p.lpFee) },
    tickSpacing: p.tickSpacing, ticks: {}, tickBitmap: {}, isValid: true,
  };
}
// (A) what UniswapV4Pool.generateState() builds from StateMulticall.getFullStateWithRelativeBitmaps:
//     slot0 incl. protocolFee + lpFee from chain, liquidity, ticks with liquidityGross>0, bitmap words.
//     wordRange = null -> every word (idealised); N -> only words [w0-N, w0+N] around current tick word
//     (paraswap requests TICK_BITMAP_TO_USE+TICK_BITMAP_BUFFER = 12 words per side, 24 on mainnet).
function chainState(p: any, wordRange: number | null): PoolState {
  const st = baseState(p, packedProtocolFee(p), B(p.liquidity));
  const ts = BigInt(p.tickSpacing);
  const gross: Record<string, bigint> = {}, net: Record<string, bigint> = {};
  for (const pos of p.positions) {
    const L = B(pos.liquidity);
    for (const [t, s] of [[pos.tickLower, 1n], [pos.tickUpper, -1n]] as [number, bigint][]) {
      gross[t] = (gross[t] ?? 0n) + L; net[t] = (net[t] ?? 0n) + s * L;
    }
  }
  const w0 = TickBitMap.position(TickBitMap.compress(B(p.tick), ts))[0];
  for (const t of Object.keys(gross)) {
    if (gross[t] === 0n) continue;
    const [w, bit] = TickBitMap.position(TickBitMap.compress(B(t), ts));
    if (wordRange !== null && (w < w0 - BigInt(wordRange) || w > w0 + BigInt(wordRange))) continue;
    st.ticks[t] = { liquidityGross: gross[t], liquidityNet: net[t] };
    st.tickBitmap[w.toString()] = (st.tickBitmap[w.toString()] ?? 0n) | (1n << bit);
  }
  return st;
}
// (B) event-built: pool seen from Initialize (protocolFee=0, as PoolManager.initialize emits no
//     ProtocolFeeUpdated), then ModifyLiquidity events, then ProtocolFeeUpdated(id, packedFee)
//     emitted by ProtocolFees.setProtocolFee when governance turns the fee switch on.
function eventBuiltState(p: any): PoolState {
  const st = baseState(p, 0n, 0n);
  for (const pos of p.positions) {
    // == UniswapV4Pool.handleModifyLiquidityEvent (uniswap-v4-pool.ts:291-306)
    uniswapV4PoolMath.checkPoolInitialized(st);
    uniswapV4PoolMath.modifyLiquidity(st, {
      liquidityDelta: B(pos.liquidity), tickUpper: B(pos.tickUpper), tickLower: B(pos.tickLower),
      tickSpacing: BigInt(st.tickSpacing),
    });
  }
  const pf = packedProtocolFee(p);
  if (pf !== 0n) {
    // == UniswapV4Pool.handleProtocolFeeUpdatedEvent (uniswap-v4-pool.ts:244-251)
    const protocolFee = pf; // event.args.protocolFee (uint24)
    uniswapV4PoolMath.checkPoolInitialized(st);
    uniswapV4PoolMath.setProtocolFee(st, protocolFee);
  }
  return st;
}

function poolOf(p: any): Pool {
  return { id: '0xpool', key: { currency0: '0x0', currency1: '0x1', fee: String(p.lpFee), tickSpacing: p.tickSpacing, hooks: '0x0000000000000000000000000000000000000000' } };
}

function cmpAmounts(m: Mode, v: any, got: [bigint, bigint] | Error, extraFields: Record<string, [any, any]> = {}) {
  const e = v.expect;
  if (e.revert !== undefined) {
    if (got instanceof Error) return m.add('PASS', v.id);
    return m.add('TARGET_ERROR', v.id, { kind: 'v4 reverted, target returned', v4revert: e.revert, got: got.map(String) });
  }
  if (got instanceof Error) return m.add('TARGET_ERROR', v.id, { kind: 'target threw, v4 succeeded', msg: String(got.message).slice(0, 300) });
  const fields: Record<string, [any, any]> = { amount0: [e.amount0, got[0].toString()], amount1: [e.amount1, got[1].toString()], ...extraFields };
  const bad = Object.entries(fields).filter(([, [a, b]]) => String(a) !== String(b)).map(([field, [expected, g]]) => ({ field, expected: String(expected), got: String(g) }));
  if (bad.length === 0) return m.add('PASS', v.id);
  if (got[0] === 0n && got[1] === 0n && !(e.amount0 === '0' && e.amount1 === '0') && steps >= 64)
    return m.add('UNSUPPORTED', v.id, { reason: 'returned [0,0] (MAX_PRICING_COMPUTATION_STEPS_ALLOWED=64 step cap)' });
  m.add('MISMATCH', v.id, { fields: bad, pool: { lpFee: v.pool.lpFee, pf0: v.pool.protocolFeeZeroForOne, pf1: v.pool.protocolFeeOneForZero, ts: v.pool.tickSpacing }, swap: v.swap });
}

// step counter: wraps (does not modify) TickBitMap.nextInitializedTickWithinOneWord, called once per loop step of _swap
let steps = 0;
const _next = TickBitMap.nextInitializedTickWithinOneWord;
(TickBitMap as any).nextInitializedTickWithinOneWord = (...a: any[]) => { steps++; return (_next as any).apply(TickBitMap, a); };
function trySwap(st: PoolState, v: any, override: bigint): [bigint, bigint] | Error {
  steps = 0;
  try {
    return uniswapV4PoolMath._swap(st, {
      zeroForOne: v.swap.zeroForOne, amountSpecified: B(v.swap.amountSpecified),
      tickSpacing: BigInt(v.pool.tickSpacing), sqrtPriceLimitX96: B(v.swap.sqrtPriceLimitX96), lpFeeOverride: override,
    });
  } catch (e: any) { return e instanceof Error ? e : new Error(String(e)); }
}

function runSwaps() {
  const modes = {
    chain: new Mode('chain', 'state as generateState() reads it from chain (slot0.protocolFee+lpFee, all ticks); _swap() with the vector price limit; lpFeeOverride=0 as production'),
    chainOverride: new Mode('chainOverride', 'same as chain, but the vector lpFeeOverride passed into _swap() (capability check; production never passes it)'),
    query: new Mode('query', 'production entrypoint queryOutputs() (SELL for exact-in, BUY for exact-out), only on non-reverting vectors that filled fully (price limit not binding)'),
    eventBuilt: new Mode('eventBuilt', 'state built purely from events: Initialize -> ModifyLiquidity* -> ProtocolFeeUpdated (handlers as in uniswap-v4-pool.ts); _swap() with vector params'),
    eventReplay: new Mode('eventReplay', 'chain state, then the v4 Swap event (expected result) is replayed through swapFromEvent(); compare resulting sqrtPrice/tick/liquidity'),
    chainRange12: new Mode('chainRange12', 'chain state but bitmap/ticks only for words within +-12 of the current word (paraswap default request range, non-mainnet)'),
    chainRange24: new Mode('chainRange24', 'same with +-24 words (mainnet request range)'),
  };
  for (const v of vectors) {
    const p = v.pool, e = v.expect;
    const hasOverride = v.swap.lpFeeOverride !== 0 && v.swap.lpFeeOverride !== '0';
    // chain
    if (hasOverride) modes.chain.add('UNSUPPORTED', v.id, { reason: 'lpFeeOverride (dynamic-fee hook) - queryOutputs always passes lpFeeOverride=0' });
    else cmpAmounts(modes.chain, v, trySwap(chainState(p, null), v, 0n));
    if (hasOverride) cmpAmounts(modes.chainOverride, v, trySwap(chainState(p, null), v, B(v.swap.lpFeeOverride)));
    // ranged
    for (const [m, r] of [[modes.chainRange12, 12], [modes.chainRange24, 24]] as [Mode, number][]) {
      if (hasOverride) m.add('UNSUPPORTED', v.id, { reason: 'lpFeeOverride' });
      else cmpAmounts(m, v, trySwap(chainState(p, r), v, 0n));
    }
    // eventBuilt
    if (hasOverride) modes.eventBuilt.add('UNSUPPORTED', v.id, { reason: 'lpFeeOverride' });
    else {
      let st: PoolState | Error;
      try { st = eventBuiltState(p); } catch (err: any) { st = err; }
      if (st instanceof Error) modes.eventBuilt.add('TARGET_ERROR', v.id, { kind: 'event state build threw', msg: String(st.message).slice(0, 200) });
      else cmpAmounts(modes.eventBuilt, v, trySwap(st, v, 0n));
    }
    // query (production entrypoint)
    if (hasOverride) modes.query.add('UNSUPPORTED', v.id, { reason: 'lpFeeOverride' });
    else if (e.revert !== undefined) modes.query.add('UNSUPPORTED', v.id, { reason: 'revert vector (queryOutputs uses its own MIN/MAX price limit)' });
    else {
      const amt = B(v.swap.amountSpecified), exactIn = amt < 0n, zf = v.swap.zeroForOne;
      const specifiedActual = B(zf === exactIn ? e.amount0 : e.amount1);
      if (specifiedActual !== amt || B(e.sqrtPriceX96) === B(v.swap.sqrtPriceLimitX96)) modes.query.add('UNSUPPORTED', v.id, { reason: 'price limit reached (binding) - not expressible via queryOutputs' });
      else {
        const expectedOut = exactIn ? (zf ? B(e.amount1) : B(e.amount0)) : (zf ? -B(e.amount0) : -B(e.amount1));
        let got: bigint | Error;
        try {
          got = uniswapV4PoolMath.queryOutputs(poolOf(p), chainState(p, null), [exactIn ? -amt : amt], zf, exactIn ? SwapSide.SELL : SwapSide.BUY)[0];
        } catch (err: any) { got = err; }
        const m = modes.query;
        if (got instanceof Error) m.add('TARGET_ERROR', v.id, { kind: 'target threw, v4 succeeded', msg: String(got.message).slice(0, 300) });
        else if (got === expectedOut) m.add('PASS', v.id);
        else if (got === 0n) m.add('UNSUPPORTED', v.id, { reason: 'queryOutputs returned 0 (64-step cap or own partial-fill check)' });
        else m.add('MISMATCH', v.id, { fields: [{ field: exactIn ? 'amountOut' : 'amountIn', expected: expectedOut.toString(), got: got.toString() }], pool: { lpFee: p.lpFee, pf0: p.protocolFeeZeroForOne, pf1: p.protocolFeeOneForZero, ts: p.tickSpacing }, swap: v.swap });
      }
    }
    // eventReplay
    if (e.revert !== undefined) modes.eventReplay.add('UNSUPPORTED', v.id, { reason: 'revert vector (no Swap event)' });
    else if (hasOverride) modes.eventReplay.add('UNSUPPORTED', v.id, { reason: 'lpFeeOverride' });
    else {
      const st = chainState(p, null);
      const a0 = B(e.amount0), a1 = B(e.amount1);
      try {
        // == UniswapV4Pool.handleSwapEvent (uniswap-v4-pool.ts:263-289)
        const zeroForOne = a0 < 0n;
        uniswapV4PoolMath.checkPoolInitialized(st);
        uniswapV4PoolMath.swapFromEvent(st, zeroForOne, B(e.sqrtPriceX96), BigInt(e.tick), B(e.liquidity), BigInt(e.swapFee), a0, a1, silentLogger);
        const bad = [['sqrtPriceX96', e.sqrtPriceX96, st.slot0.sqrtPriceX96], ['tick', e.tick, st.slot0.tick], ['liquidity', e.liquidity, st.liquidity]]
          .filter(([, a, b]) => String(a) !== String(b)).map(([field, expected, got]) => ({ field, expected: String(expected), got: String(got) }));
        if (bad.length) modes.eventReplay.add('MISMATCH', v.id, { fields: bad, swap: v.swap, amounts: [e.amount0, e.amount1] });
        else modes.eventReplay.add('PASS', v.id);
      } catch (err: any) {
        modes.eventReplay.add('TARGET_ERROR', v.id, { kind: 'swapFromEvent threw on a real v4 Swap event (pool would be marked invalid and re-fetched)', msg: String(err.message).slice(0, 200), amounts: [e.amount0, e.amount1], swap: v.swap });
      }
    }
  }
  return modes;
}

// ---------------------------------------------------------------- units
function runUnits() {
  const m = new Mode('units', 'paraswap contract-math helpers vs v4-core');
  const perFn: Record<string, Record<string, number>> = {};
  for (const v of vectors) {
    const a = v.args;
    let got: any;
    try {
      switch (v.fn) {
        case 'getSqrtPriceAtTick': got = TickMath.getSqrtPriceAtTick(B(a[0])); break;
        case 'getTickAtSqrtPrice': got = TickMath.getTickAtSqrtPrice(B(a[0])); break;
        case 'getAmount0Delta': got = SqrtPriceMath.getAmount0Delta(B(a[0]), B(a[1]), B(a[2]), a[3]); break;
        case 'getAmount1Delta': got = SqrtPriceMath.getAmount1Delta(B(a[0]), B(a[1]), B(a[2]), a[3]); break;
        case 'getNextSqrtPriceFromInput': got = SqrtPriceMath.getNextSqrtPriceFromInput(B(a[0]), B(a[1]), B(a[2]), a[3]); break;
        case 'getNextSqrtPriceFromOutput': got = SqrtPriceMath.getNextSqrtPriceFromOutput(B(a[0]), B(a[1]), B(a[2]), a[3]); break;
        case 'computeSwapStep': {
          const r = SwapMath.computeSwapStep(B(a[0]), B(a[1]), B(a[2]), B(a[3]), B(a[4]));
          got = [r.sqrtPriceNextX96, r.amountIn, r.amountOut, r.feeAmount]; break;
        }
        case 'calculateSwapFee': got = ProtocolFeeLibrary.calculateSwapFee(B(a[0]), B(a[1])); break;
        default: m.add('UNSUPPORTED', v.fn, { reason: 'fn ' + v.fn }); continue;
      }
    } catch (err: any) { got = err instanceof Error ? err : new Error(String(err)); }
    const pf = (perFn[v.fn] ??= { PASS: 0, MISMATCH: 0, TARGET_ERROR: 0 });
    const id = `${v.fn}(${JSON.stringify(a)})`;
    let r: Res;
    if (v.expect && typeof v.expect === 'object' && !Array.isArray(v.expect) && 'revert' in v.expect) {
      r = got instanceof Error ? 'PASS' : 'TARGET_ERROR';
      m.add(r, id, r === 'TARGET_ERROR' ? { kind: 'v4 reverted, target returned', v4revert: v.expect.revert, got: Array.isArray(got) ? got.map(String) : String(got) } : undefined);
    } else if (got instanceof Error) {
      r = 'TARGET_ERROR'; m.add(r, id, { kind: 'target threw, v4 succeeded', expected: v.expect, msg: String(got.message).slice(0, 200) });
    } else {
      const g = Array.isArray(got) ? got.map(String) : String(got);
      const ex = Array.isArray(v.expect) ? v.expect.map(String) : String(v.expect);
      r = JSON.stringify(g) === JSON.stringify(ex) ? 'PASS' : 'MISMATCH';
      m.add(r, id, r === 'MISMATCH' ? { fields: [{ field: 'result', expected: ex, got: g }] } : undefined);
    }
    pf[r]++;
  }
  return { m, perFn };
}

const isUnits = vectors.length > 0 && 'fn' in vectors[0];
let report: any = { target: 'paraswap-dex-lib@291393f0f489b9fe9b0e2ddc3313724f4dbb5cd2 (npm @paraswap/dex-lib 5.1.28) src/dex/uniswap-v4', vectors: file, n: vectors.length };
if (isUnits) {
  const { m, perFn } = runUnits();
  report = { ...report, kind: 'units', counts: m.counts, perFn, mismatches: m.mismatches, targetErrors: m.errors };
  console.log('units', m.counts, perFn);
} else {
  const modes = runSwaps();
  report.kind = 'swaps';
  report.modes = {};
  for (const [k, m] of Object.entries(modes)) {
    report.modes[k] = { desc: m.desc, counts: m.counts, unsupported: m.unsupported, mismatches: m.mismatches, targetErrors: m.errors };
    console.log(k.padEnd(14), JSON.stringify(m.counts), JSON.stringify(m.unsupported));
  }
}
writeFileSync(out, JSON.stringify(report, null, 1));
console.log('wrote', out);
