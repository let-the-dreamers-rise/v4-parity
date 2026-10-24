// Probe: dynamic-fee pool (PoolKey.fee = 0x800000) whose hook has no swap permission flags.
const JSBI = require('jsbi');
const { Token, CurrencyAmount } = require('@uniswap/sdk-core');
const { Pool } = require('@uniswap/v4-sdk');
const { nearestUsableTick, TickMath } = require('@uniswap/v3-sdk');
const T0 = new Token(1, '0x0000000000000000000000000000000000000001', 18), T1 = new Token(1, '0x0000000000000000000000000000000000000002', 18);
// hook address whose low 14 bits contain no swap flags (only AFTER_INITIALIZE = 1<<12)
const HOOK = '0x0000000000000000000000000000000000001000';
const L = '1000000000000000000000';
const lo = nearestUsableTick(TickMath.MIN_TICK, 60), hi = nearestUsableTick(TickMath.MAX_TICK, 60);
const ticks = [{ index: lo, liquidityNet: L, liquidityGross: L }, { index: hi, liquidityNet: '-' + L, liquidityGross: L }];
(async () => {
  const pool = new Pool(T0, T1, 0x800000, 60, HOOK, TickMath.getSqrtRatioAtTick(0).toString(), L, 0, ticks);
  try { const [out] = await pool.getOutputAmount(CurrencyAmount.fromRawAmount(T0, '1000000000000000000')); console.log('exactIn 1e18 token0 -> out', out.quotient.toString()); } catch (e) { console.log('exactIn threw:', e.message); }
  try { const [inp] = await pool.getInputAmount(CurrencyAmount.fromRawAmount(T1, '1000000000000000000')); console.log('exactOut 1e18 token1 -> in', inp.quotient.toString()); } catch (e) { console.log('exactOut threw:', e.message); }
  const p3 = new Pool(T0, T1, 3000, 60, '0x0000000000000000000000000000000000000000', TickMath.getSqrtRatioAtTick(0).toString(), L, 0, ticks);
  const [o3] = await p3.getOutputAmount(CurrencyAmount.fromRawAmount(T0, '1000000000000000000')); console.log('reference static 3000 pool out', o3.quotient.toString());
})();
