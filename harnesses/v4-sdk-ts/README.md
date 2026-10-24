# v4-parity harness: @uniswap/v4-sdk / @uniswap/v3-sdk (TypeScript)

Pinned: `@uniswap/v4-sdk@2.4.1`, `@uniswap/v3-sdk@3.31.5`, `@uniswap/sdk-core@7.19.4` (see package.json / package-lock.json). Node 22.

```sh
cd harnesses/v4-sdk-ts
npm ci
V=../..
node harness.mjs $V/vectors/swaps.json      --out report.swaps.json        # modes: integrator + fee-adjusted (default --mode both)
node harness.mjs $V/vectors-nopf/swaps.json --out report.nopf.swaps.json
node harness.mjs $V/vectors/units.json      --out report.units.json
node repro.mjs                                                            # minimal hand-built repros for FINDINGS F1-F3
```

- `integrator` mode: `new Pool(c0, c1, PoolKey.fee, tickSpacing, 0x0, sqrtPriceX96, liquidity, tick, ticks)`. This is how
  smart-order-router builds a pool. The SDK has no protocol-fee input.
- `fee-adjusted` mode: `fee = calculateSwapFee(protocolFee, lpFee or hook override)`.
- In the reports, `mismatchClasses.partialFillOnly` counts vectors where only the specified-side amount differs. These are swaps
  that v4 filled only partly; the SDK API cannot report a partial fill (FINDINGS F3).
- `pkgsrc/` holds the unpacked npm tarballs of smart-order-router, router-sdk and universal-router-sdk, and a sparse checkout of the
  `Uniswap/sdks` source at commit `ca94e682` (tag `@uniswap/v4-sdk@2.4.1`), for the source citations in FINDINGS.md. To recreate it:
  `npm pack <pkg>@<ver>`, and `git clone --depth 1 --filter=blob:none --sparse --branch '@uniswap/v4-sdk@2.4.1' https://github.com/Uniswap/sdks.git`.
