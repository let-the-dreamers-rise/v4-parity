uniswap-v4-sdk 2.0.0 / uniswap-v3-sdk 7.0.0:

1. **Protocol fee ignored.** `Pool` passes its single `fee` into `v3_swap` (`src/entities/pool.rs:305-306`), and the chain loader drops protocolFee (`src/extensions/pool.rs:87`: `let (sqrt_price_x96, _, _, _) = slot0?;`). v4 charges the protocol fee on top of the LP fee, and it has been live since July 2026.
   - Repro: 30 bps pool, pf 1000, exact-in 1e18. v4-core returns 995011965097726768; the SDK returns 996006981039903216 (**+10 bps**).
   - With the combined fee set by hand, results match on all 6,000 test swaps.

2. **Dynamic-fee pools can't be quoted.** `from_pool_key` uses the PoolKey fee 0x800000, so `1e6 - fee` wraps in `swap_math.rs:57` and `get_output_amount` returns `MulDivOverflow`.

3. **Wrong tick on the returned pool.** When a zeroForOne swap ends exactly on an initialized tick, the returned pool has tick T instead of v4's T−1, with liquidity already crossed (`pool.rs:382,443`). A chained quote on that pool fails with `AddDeltaOverflow`.

4. **Minor:**
   - A static fee of 1e6 panics in `Pool::new` (`pool.rs:161`).
   - A 100% fee in an empty range returns `MulDivOverflow`, where v4 special-cases it.

Harness: https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/rust. Expected values come from real v4-core.
