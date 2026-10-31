Fixes ISSUE_URL

**Before:** after a `ProtocolFeeUpdated` event, `setProtocolFee` stores the fee in `slot0.lpFee`, as the JS number ethers v5 decodes for a uint24. Every quote for that pool then throws (`Cannot convert … to a BigInt` in `SwapMath.computeSwapStep`), `_getOutputs` returns null, and the pool drops out of routing. It comes back only when a later Swap replay fails and forces a re-fetch; for a fee set on 0→1 only, or switched off, the replay succeeds and the pool stays unquotable.

**After:** the fee is written to `slot0.protocolFee` as a bigint, and quotes on fee-on pools match v4-core.

**How:** one-line field fix in `uniswap-v4-pool-math.ts`, `BigInt(event.args.protocolFee)` in the handler, and a jest test (`uniswap-v4-protocol-fee.test.ts`, 4 cases) that decodes a real `ProtocolFeeUpdated` log, runs the handler and compares quotes with amounts from v4-core's `PoolManager.swap`. Expected values and the reproduction are in https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/paraswap.

The patch applies cleanly to current `master`; the tests were written and run against 291393f0.
