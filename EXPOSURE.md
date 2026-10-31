# Live protocol-fee exposure (measured 25 Oct 2026)

Every `ProtocolFeeUpdated` event since Proposal 100 was read from each chain's v4 PoolManager, together with every v4 `Swap` in the 24 hours before the scan. The scan is `scripts/exposure.mjs`, run by the `exposure` workflow in this repo's public GitHub Actions. Per-chain JSON is in the run artifacts.

| Chain | Pools with fee on | Per-direction fee ≥ 245 pips (packed ≥ 1e6) | Asymmetric fees | Fee set back to 0 | v4 swaps, last 24h | Swaps through fee-on pools |
|---|---|---|---|---|---|---|
| Ethereum | 132,758 | 126,347 | 0 | 3 | 118,797 | 78,460 (66%) |
| Arbitrum | 20,156 | 18,827 | 0 | 0 | 33,605 | 32,381 (96%) |
| OP Mainnet | 9,994 | 8,623 | 0 | 0 | 36,297 | 18,785 (52%) |
| **Total** | **162,908** | **153,797 (94%)** | **0** | **3** | **188,699** | **129,626 (69%)** |

Base, BNB Chain and Polygon are not in the table yet. Their free public RPCs refuse logs this old or rate-limit the scan. Adding an `RPC_<CHAIN>` repository secret (any free archive endpoint) makes the weekly run cover them. Robinhood Chain isn't in the scanner yet.

The most common values per direction are 1000 pips (10 bp; 117,098 pools on Ethereum), 500, 25 and 125, which matches Proposal 100's tiers. Every pool sets the same fee in both directions.

## What this means for each finding

- **Uniswap TS v4 SDK and Rust v4 SDK.** They have no protocol-fee input, so every quote through a fee-on pool overquotes. That covers 69% of the last day's v4 swaps on these three chains.
- **ParaSwap.** In production the handler stores the fee as a JS number, so after the fee event every quote for a pool it was already tracking throws and the pool drops out of ParaSwap's routing (FINDINGS.md, correction of 31 Oct 2026). For every fee-on pool here the packed value is ≥ 4096, so the pool comes back after its next swap: busy pools return quickly, quiet pools stay out longer. The 3 pools whose fee was set back to 0 hit the branch where the next swap does not trigger a re-read, so they stay out until their state is reloaded.
- **KyberSwap direction bug (K1).** No live pool has asymmetric fees, so K1 has no effect today. The fix still matters before any governance change that sets the two directions differently. The hook-override bug (K2) is separate and is not measured by this scan.
