# v4-parity findings (20 Oct 2026)

Oracle: Uniswap v4-core `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`. Vectors: `vectors/` (seed 1; 3,000 swaps, 80% with protocol fee on; 2,400 math units) and `vectors-nopf/` (seed 2; 3,000 swaps, protocol fee off). Every successful non-hook vector was replayed through the real `PoolManager`: 2,656/2,656 match exactly (`forge test`).

## Summary

**Swap amounts are right everywhere once the fee is right.** Given the correct total fee, all five engines return the same swap amounts as v4-core, to the wei, in all but a few edge cases: KyberSwap's deliberate float64 shortcut after 16 empty bitmap words, and Tycho's exact-out step, which its public API doesn't expose. Remaining differences are outside the amounts:
- returned-state ticks, partial-fill reporting and refusals to quote (per-target sections below);
- a handful of unit-level rounding and overflow cases that real-sized swaps don't reach.

**Four of five engines mishandle protocol fees: two have bugs (ParaSwap, KyberSwap) and two lack the feature (both SDKs). Tycho handles them correctly.** Uniswap governance proposal 100 (executed 27 Jul 2026) switched on v4 protocol fees on Ethereum, Arbitrum, Base, BNB Chain, Polygon, OP Mainnet and Robinhood Chain. In v4 the protocol fee is charged **on top of** the LP fee (`swapFee = pf + lp − pf·lp/1e6`, `ProtocolFeeLibrary.calculateSwapFee`). In v3 the protocol took a cut of the LP fee, so the trader's price didn't change. Code ported from v3 therefore gets v4 quotes wrong.

| Target (pinned) | Protocol-fee defect | Size | Kind |
|---|---|---|---|
| `@uniswap/v4-sdk` 2.4.1 (TS, official) | No protocol-fee input at all; `Pool` passes the LP fee alone to `v3Swap` (`pool.ts:317-327`) | Overquotes exact-in output by ≈ pf/100 bps (+5.0 bps at pf=500) | Missing feature |
| `uniswap-v4-sdk` 2.0.0 (Rust) | Same; the chain loader discards `slot0.protocolFee` (`extensions/pool.rs:87`) | +10.0 bps at pf=1000 | Missing feature |
| ParaSwap `paraswap-dex-lib` @291393f0 | The `ProtocolFeeUpdated` event handler writes the packed protocol fee into **`lpFee`** (`uniswap-v4-pool-math.ts:511-513`) | Depends on the packed value. ≤1000 (one direction only, or fee off): +27.6 to +92.8 bps overquote, persists. 4096 to 999,999: underquote (−2,024 bps at 50/50), heals at the next Swap. ≥1,000,000, which includes Proposal 100's 500/500: **+522 bps overquote** and exact-out throws, heals at the next Swap | **Bug** |
| KyberSwap `kyberswap-dex-lib` v0.134.47 | Uses the 0→1 protocol fee for both directions (`pool_tracker.go:131-133`). Hook fee overrides drop the protocol fee (`pool_simulator.go:195-200`) | ±10 bps on asymmetric fees; +5 bps on dynamic-fee hook pools | **Bug** |

| Propeller Heads `tycho-simulation` v0.258.0 | **None for protocol fees.** Fees are applied per direction, the v4 way, and every exact-in quote with the fee on matches. Other issues: dynamic-fee pools are quoted at a 0 LP fee unless the hook returns an override (`state.rs:117-124`, ~30 bps overquote); the returned state has stale ticks; refuses to quote when in-range liquidity is 0; one rounding-direction slip in `get_amount0_delta` | ~30 bps on affected dynamic-fee pools; the rest are wei-level or liveness issues | Missing feature / low |

Tycho shows that the protocol-fee bug class is avoidable. The vectors do not flag its protocol-fee handling.

## Impact under the live fee schedule (Proposal 100)

Proposal 100 sets one protocol fee per static pool by LP tier, e.g. 1 bp LP fee → 0.25 bp, 5 bp → 1.25 bp, 30 bp → 5 bp, 100 bp → 10 bp. Aggregator hook pools get flat fees of 10 bp (3 bp on Base). Re-measured with those values:

| Target | Effect on a 30 bp pool with a 5 bp protocol fee | Duration |
|---|---|---|
| Uniswap TS SDK, Rust SDK | exact-in output overquoted by +5.0 bps (+1.25 bps on 5 bp pools, +10 bps on 100 bp pools) | Permanent, on every fee-on pool |
| ParaSwap | After `ProtocolFeeUpdated`, `lpFee` becomes 2,048,500 (packed 500/500, which is over 100%). Exact-in is overquoted by **+522 bps** and exact-out throws. Output is in `harnesses/paraswap/report-live-schedule.txt`, from `harness/live_schedule.ts`; expected values come from the v4-core Oracle | From each fee activation until the next Swap event fails replay and forces a re-fetch (verified). Persists if a fee is ever set on one direction only, or switched off |
| KyberSwap | Direction bug dormant while fees are symmetric. Hook-override bug drops the protocol fee on dynamic-fee hook pools in a fee family (+5 bps per 5 bps of fee) | Permanent on those pools |
| Tycho | none for protocol fees | n/a |

## Fixes prepared

`patches/` holds tested fixes in each repo's own test style. Neither patch needs RPC to test.
- `paraswap-protocol-fee-updated.patch`: the one-line field fix plus `BigInt()` on the event argument. Ethers decodes uint24 as a number, so without it the next Swap event would throw. Adds 4 jest cases using v4-core expected amounts.
- `kyberswap-directional-protocol-fee.patch`: stores the packed protocol fee and LP fee in Extra, but only while the fee is on, so other pools' Extra is unchanged. Computes the fee per direction and keeps the protocol fee under hook overrides. Go tests use v4-core expected amounts. The existing package tests pass.

Uniswap's own routing (`smart-order-router`) is not affected: it reads slot0 but takes v4 amounts from the on-chain V4Quoter. Third parties that quote off-chain with the SDKs, and the aggregators above, are affected.

## Per target

### ParaSwap (`src/dex/uniswap-v4/`, commit `291393f0f489b9fe9b0e2ddc3313724f4dbb5cd2`)

**P1 (HIGH): the ProtocolFeeUpdated handler corrupts the LP fee.**
- `setProtocolFee` does `poolState.slot0.lpFee = protocolFee` and never sets `slot0.protocolFee`. It is called from `handleProtocolFeeUpdatedEvent` (`uniswap-v4-pool.ts:244-251`).
- Who is affected: any pool already being tracked when governance turns the fee on, changes it, or turns it off.
- If the packed fee is ≤ 1000 (one direction only, or fee switched off), later Swap events replay without error and the wrong fee persists.
  - Oracle-backed repro: lpFee 3000, tickSpacing 60, sell 1e18 with pf 250/0. It overquotes by +30.1 bps (0→1) and +27.6 bps (1→0).
  - Vector `swap-1-2900` overquotes by +92.8 bps.
- If oneForZero is non-zero, the packed value is ≥ 4096 (50/50 pips becomes a 20.5% fee). Quotes come out about 2,000 bps too low until the next Swap event fails to replay and forces a re-fetch.
- Fix: one line, `poolState.slot0.protocolFee = protocolFee`.

**P2 (LOW–MEDIUM): no guard when a swap runs past the fetched tick-bitmap window.**
- Words that were never fetched read as empty (`TickBitMap.ts:65,77`), so the pool keeps using liquidity that has actually ended.
- The v3 integration has a guard for this. v4 declares `OUT_OF_RANGE_ERROR_POSTFIX` but never uses it.
- This assumes the StateMulticall returns ±12/±24 words relative to the current tick. Confirm on-chain.

**P3 (LOW, liveness):** `swapFromEvent` throws on about 27% of valid Swap events (direction is taken from `amount0 < 0`, among other causes). The state is then re-fetched by RPC, which costs RPC load but never gives a wrong quote.

**P4/P5 (LOW):** v4's int128/uint160 overflow checks are missing. One `getNextSqrtPriceFromAmount0RoundingUp` overflow fallback is absent; no swap reaches it.

### KyberSwap (`pkg/liquidity-source/uniswap/v4`, commit `ec21cb6b8a811198dda0dcbe274f51dd1aac1241`)

**K1 (HIGH where fees are asymmetric): wrong direction's protocol fee.**
- The code uses `slot0.protocolFee & 0xfff` (the 0→1 fee) for 1→0 swaps as well. v4 uses `>> 12` for 1→0.
- Repro: full range at price 1, 30 bps, protocol fee 0 (0→1) / 1000 (1→0), exact-in 1e18 token1. Kyber gives 996999005991991025; v4 gives 996002007979012046, so Kyber overquotes by +10.01 bps.
- The repo's own dualpool hook does this correctly (`hooks/dualpool/math.go:172-187`).
- Exposure depends on whether live pools set different fees per direction. Not yet verified on-chain.

**K2 (MEDIUM): dynamic-fee override replaces the whole fee.**
- When a hook reports an LP fee, the simulator uses it as the entire swap fee and drops the protocol fee. v4 adds the protocol fee on top.
- Repro: override 3000 with pf 500/500 overquotes by +5 bps.
- An override of 0 is ignored, which underquotes by about 30 bps.
- Real Renzo and Alphix hook adapters report fees this way.

**K3–K5 (LOW):**
- With a zero price limit, MIN+1 is substituted without checking it against the current price.
- `MaxSqrtRatioU256` is v4's max − 1, so the standard limit errors in the float word walk.
- `CalcAmountInWithPriceLimit` claims the full output on a partial fill.

**K6 (INFO, deliberate):** a float64 word walk after 16 empty words. It underquotes by about 1e-14 to 1e-11 relative, and disabling it gives exact parity.

### Uniswap TS SDK (`@uniswap/v4-sdk@2.4.1`, `@uniswap/v3-sdk@3.31.5`; Uniswap/sdks `ca94e682`)

**U1 (HIGH for off-chain quoters): no protocol fee.**
- Repro: 30 bps pool, 5 bps protocol fee, exact-in 1e18. v4 gives 1005508485868436630; the SDK gives 1006011492375058864 (+5.003 bps).
- It matches to the wei with `fee = 3499`, but that changes `poolKey`/`poolId`.
- It also quotes swaps that v4 reverts (`InvalidFeeForExactOut`).

**U2 (MEDIUM): dynamic-fee pools whose hook has no swap flags.**
- These pools are quoted with fee = 0x800000 = 8,388,608 pips. Exact-in 1e18 returns 7.52e18 out, and exact-out returns a negative input.
- v4-core allows this hook address (`Hooks.isValidHookAddress`), and its real fee is `slot0.lpFee`.

**U3 (LOW–MEDIUM):** `getOutputAmount`/`getInputAmount` can't report a partial fill (the remaining amount is dropped in `v3swap.ts:130-135`).

**U4 (LOW):** missing int128/uint160 checks; LP fee 1e6 (valid in v4) is rejected.

### Rust SDK (`uniswap-v4-sdk 2.0.0`, `uniswap-v3-sdk 7.0.0`, `uniswap_v3_math 0.6.2`)

**R1 (HIGH): no protocol fee.**
- `Pool` has one `fee`. `extensions/pool.rs:87` reads slot0 and discards protocolFee.
- Repro: 30 bps, pf 1000, exact-in 1e18. v4 gives 995011965097726768; the SDK gives 996006981039903216 (+10 bps).
- All 725 mode-A mismatches are this.
- With protocol fees off: 0 mismatches over 3,000 swaps.

**R2 (MEDIUM):** `from_pool_key` uses fee 0x800000 for dynamic pools. The fee subtraction wraps, so these pools can't be quoted (`swap_math.rs:57`).

**R3 (LOW):** LP fee 1e6 panics. A 100% fee in an empty range returns MulDivOverflow, where v4 special-cases it.

**R4 (LOW):** no int128 check on results. `uniswap_v3_math` returns prices ≥ 2^160 where v4 reverts.

**R5 (LOW–MEDIUM):** the pool returned by `get_output_amount` has tick T instead of T−1 when a zeroForOne swap ends exactly on an initialized tick. Chaining a second quote on it errors with `AddDeltaOverflow`.

### Tycho (`tycho-simulation` v0.258.0, commit `092ffc62`)

The harness uses a copy of the crate whose only changes widen visibility (`vis.patch`; setup with `setup.sh`). Protocol fees are correct: all 236 api-mode vectors with the fee on match exactly.
- **T1 (MEDIUM):** dynamic-fee pools get LP fee 0 unless beforeSwap returns an override. `updateDynamicLPFee` emits no event, and the decoder only reads the PoolKey fee.
- **T2 (LOW):** the returned state's tick is stale after a swap that ends inside a range (`state.rs:256-259`). As a result, 66 of 870 chained quotes come out 1–5 wei high. The same pattern is in its v3 code.
- **T3 (LOW, missed routes):** when in-range liquidity is 0, it reports "No liquidity" instead of swapping through to the next range (`state.rs:183`). This accounts for 689 target errors in raw mode, 165 of them on vectors where v4 returns non-zero output, and 109 in API mode, 40 of them non-zero.
- **T4 (INFO):** past the outermost tick, quotes come back as an error that carries the correct partial amount; on min/max-price fills, the unused input isn't reported.
- **T5 (INFO):** the round-down `get_amount0_delta` uses a round-up step (`sqrt_price_math.rs:58`). It is off by 1 wei on a crafted case, with no hits in the vectors.
- **T6 (INFO):** the exact-out step uses `>` where v4 uses `>=`. This can't be reached from its exact-in public API.

## Not yet verified

- The exact count of fee-on pools, and the volume they carry, per chain. Proposal 100 gives the schedule, but this container has no chain RPC access to read `ProtocolFeeUpdated` events from each PoolManager.
- Whether any live dynamic-fee pool has a hook with no swap flags (U2, R2).

## Disclosure

Reported to each maintainer on <DATE>: <LINKS>.
