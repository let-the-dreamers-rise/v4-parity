# v4-parity harness: tycho-simulation `UniswapV4State`

Target: propeller-heads/tycho-simulation v0.258.0, commit `092ffc62af7f1e5509c3874b542481a0d6e69bd5`
(the tip of `main` on 2026-10-20; `git ls-remote origin HEAD` gives the same hash). Clone: `../tycho-simulation`.
Indexer source, used to check how the state is fed: propeller-heads/tycho-protocol-sdk `71923286296200af0a60d7233b8fc031e8a4df01`,
`substreams/ethereum-uniswap-v4` (sparse clone: `../tycho-protocol-sdk`).

## What is built
- `tycho-simulation-vis/` is a copy of the target. Its only changes make things public and add three thin
  wrapper methods. No logic changes. See `vis.patch`. The changes:
  - `utils/uniswap/{mod,sqrt_price_math,swap_math,tick_math,liquidity_math}.rs`: `pub(crate)`/`pub(super)` -> `pub`. This lets the unit vectors call the math helpers.
  - `uniswap_v4/state.rs`: adds `parity_swap` (calls the private `swap` unchanged), `parity_fee_pips`, `parity_state`.
- `src/main.rs` is the harness. It builds `UniswapV4State::new(liquidity, sqrtPriceX96, UniswapV4Fees::new(pf0, pf1, lpFee), tick, tickSpacing, ticks)`
  the same way `uniswap_v4/decoder.rs` does: net-liquidity ticks, zero-net ticks dropped, sorted, protocol fees per direction.
  Swap vectors run in three modes:
  - `api_get_amount_out`: the public `ProtocolSim::get_amount_out`. It is exact-in only and always uses the MIN+1/MAX-1 price limit. Vectors that are exact-out or set a custom limit count as UNSUPPORTED. A dynamic-fee override is passed in through a stub `HookHandler` that has the beforeSwap permission bit. Fields compared: amountOut, implied amountIn (= full amount), new sqrtPrice, tick and liquidity.
  - `raw_swap_decoder_ticks`: the private `swap()`. Covers exact-out and custom limits. Fields compared: amount0, amount1, swapFee, sqrtPrice, tick, liquidity.
  - `raw_swap_all_ticks`: the same as raw, but initialized ticks with zero net liquidity are kept.
- `tools/exactout_663.py` is an independent big-int re-run of vector swap-1-663 that confirms the exact-out root cause.

## Commands
```
cd harnesses/tycho
/root/.cargo/bin/cargo build --release            # ~7 min cold (builds revm/alloy/tycho deps; rfq feature disabled)
V=../..
./target/release/tycho-v4-parity $V/vectors/swaps.json      report-swaps-pf.json
./target/release/tycho-v4-parity $V/vectors-nopf/swaps.json report-swaps-nopf.json
./target/release/tycho-v4-parity $V/vectors/units.json      report-units.json
./target/release/tycho-v4-parity repro $V/vectors/swaps.json   # hand-built minimal repros R1-R5
python3 -I tools/exactout_663.py
```
`report.json`-style output: one JSON file per vector file (listed above). Each has per-mode counts and every mismatch (id, field, expected, got) and error.
