At v0.258.0 (092ffc62), dynamic-fee pools (PoolKey fee 0x800000) get an LP fee of 0 unless the hook's beforeSwap returns an override (`src/evm/protocol/uniswap_v4/state.rs:117-124`). On-chain, v4 charges `slot0.lpFee`, which a hook can set with `PoolManager.updateDynamicLPFee`. That call emits no event, and the decoder only reads the static `key_lp_fee`.

`delta_transition` reads a `"fee"` attribute that the v4 substream (`tycho-protocol-sdk` @71923286) never emits. As a result:
- dynamic pools whose hooks have no swap permissions, and
- hooks that update the fee instead of returning an override

are overquoted by their whole LP fee (about 30 bps at 3000 pips).

Smaller items from the same run, all checked against real v4-core:
- **Stale tick in the returned state** after a swap that ends inside a range. `state.sqrt_price` is updated before `sqrt_price_start` is recorded (`state.rs:256-259`), so the tick recompute at `:296` never runs. Chained quotes are then 1–5 wei high in 66 of 870 cases. The same pattern is in `uniswap_v3/state.rs:168-172`.
- **Zero in-range liquidity refuses to quote** (`state.rs:183`, "No liquidity"), where v4 swaps through to the next range.
- **Round-down `get_amount0_delta` rounds up** in one step (`sqrt_price_math.rs:58`). With a=2^96, b=2^96+1, L=2^96 it returns 1 where v4 returns 0.

Protocol fees are handled exactly right. Every fee-on vector matched. Thanks for that: it served as our control.

Harness: https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/tycho
