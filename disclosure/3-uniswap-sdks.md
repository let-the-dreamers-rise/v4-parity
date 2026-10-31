@uniswap/v4-sdk 2.4.1 / v3-sdk 3.31.5 (commit ca94e682):

1. **No protocol-fee input.** `Pool` takes a single `fee` and passes it to `v3Swap` (`pool.ts:317-327`). In v4 the protocol fee is charged on top of the LP fee (`ProtocolFeeLibrary.calculateSwapFee`). Protocol fees have been live since proposal 100 (27 Jul 2026), so `getOutputAmount` / `Trade.fromRoute` / `bestTradeExactIn` overquote by roughly the protocol fee on affected pools.
   - Repro: 30 bps pool, 5 bps protocol fee, exact-in 1e18. v4-core returns 1005508485868436630; the SDK returns 1006011492375058864 (**+5.0 bps**).
   - It matches to the wei when given `fee = calculateSwapFee(pf, lp)`, but that changes `poolKey`/`poolId`.
   - smart-order-router reads `protocolFee` from slot0 (`V4ISlot0`) and discards it. Its quotes come from V4Quoter, so Uniswap's own routing is fine; third-party off-chain quoters are not.
   - Suggestion: an optional `protocolFee` (or `swapFee`) constructor argument used only for swap math.

2. **Flagless dynamic-fee hooks get an 838% fee.** For `fee = DYNAMIC_FEE_FLAG` with a hook that has no swap permissions, `swap()` runs `v3Swap` with fee 0x800000 = 8,388,608 pips. v4-core allows that hook address (`Hooks.isValidHookAddress`); the real fee is `slot0.lpFee`.
   - Exact-in 1e18 returns 7.52e18 out, and exact-out returns a negative input.

3. **Minor:**
   - `getOutputAmount` / `getInputAmount` can't report a partial fill (`v3swap.ts:130-135` drops the remaining amount).
   - A static fee of exactly 1e6 is valid in v4 but rejected by the constructor.

Harness and repros: https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/v4-sdk-ts (`node repro.mjs`). Expected values come from real v4-core.
