At tag v0.134.47 (ec21cb6b):

1. **1→0 swaps use the 0→1 protocol fee.** `pkg/liquidity-source/uniswap/v4/pool_tracker.go:131-133` builds one `SwapFee` from `slot0.protocolFee & 0xfff` (the zeroForOne fee) and uses it for both directions. v4-core uses `protocolFee >> 12` for oneForZero swaps (`Pool.sol:286-287`, `ProtocolFeeLibrary.getOneForZeroFee`).
   - Repro: full-range pool at price 1, 30 bps LP fee, protocol fee 0 (0→1) / 1000 (1→0), exact-in 1e18 of token1. Kyber returns 996999005991991025; v4-core returns 996002007979012046 (**+10.0 bps**). With the fees reversed, Kyber underquotes by 10 bps.
   - Your dualpool hook already handles direction correctly (`hooks/dualpool/math.go:172-187`).

2. **Hook fee overrides drop the protocol fee.** In `pool_simulator.go:195-200` and `:341-346`, when a hook returns a dynamic LP fee, it replaces the whole swap fee and the protocol fee is lost. v4 adds the protocol fee on top of the override (`Pool.sol:301-307`).
   - Repro: override 3000 with protocol fee 500/500 overquotes by **+5 bps**.
   - An override of 0 is ignored because of the `SwapFee > 0` check, which underquotes by about 30 bps on a 30 bps pool.

Expected values come from the real v4-core code executed on anvil. Harness and repros: https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/kyber-go (`go run ./repro` from `harness/`).

Minor, from the same run:
- `MaxSqrtRatioU256` is v4's MAX_SQRT_PRICE − 1, so `GetTickAtSqrtRatio` rejects the valid standard limit inside the float word walk.
- `CalcAmountInWithPriceLimit` reports the full output when the limit stops an exact-out swap early.

A tested, backward-compatible patch (Extra gains `pF`/`lpF` only while the protocol fee is on) is in https://github.com/let-the-dreamers-rise/v4-parity/blob/main/patches/kyberswap-directional-protocol-fee.patch, and I am happy to open it as a PR. Note: with today's symmetric Proposal 100 fees, item 1 is dormant; item 2 affects dynamic-fee hook pools with a protocol fee.

Found with v4-parity: https://github.com/let-the-dreamers-rise/v4-parity
