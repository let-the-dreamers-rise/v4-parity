Thanks for merging this and for the follow-up commits, @NgoKimPhu.

To catch the next regression of this kind (fee paths, hook overrides) before it ships: v4-parity now comes as a GitHub Action. It runs 3,000 swaps that were executed on the real v4-core PoolManager through your pool simulator and fails CI if any quote differs. The Go harness I used to find this bug already drives your uniswap-v4 simulator, so the adapter is ready.

Would you take a small PR that adds it as a CI check (one workflow file plus a small test adapter)? Known gaps can be baselined, so it only fails on new divergences. https://github.com/let-the-dreamers-rise/v4-parity/blob/main/kit/README.md
