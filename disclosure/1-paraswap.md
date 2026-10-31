At commit 291393f0, `setProtocolFee` in `src/dex/uniswap-v4/contract-math/uniswap-v4-pool-math.ts:511-513` does

```ts
poolState.slot0.lpFee = protocolFee;
```

It never updates `slot0.protocolFee`. It is called from `handleProtocolFeeUpdatedEvent` (`uniswap-v4-pool.ts:244-251`), which passes `event.args.protocolFee` through unconverted, and ethers v5 decodes a uint24 as a JS number. So any pool that is already being tracked when governance turns on, changes or turns off its v4 protocol fee ends up with a JS number in `slot0.lpFee`:

- **Every quote for that pool then throws** (`BigInt.asUintN` in `SwapMath.computeSwapStep`: "Cannot convert 2048500 to a BigInt"; exact-out hits "Invalid fee for exact out" first). `_getOutputs` catches the error and returns null (`uniswap-v4.ts:155-181`), so the pool silently drops out of routing.
- **At Proposal 100's live rates** (packed 500/500 = 2,048,500) and for any packed value ≥ 4096, the next Swap event fails replay, the state is re-fetched, and the pool comes back.
- **Fee set on 0→1 only, or switched off** (packed ≤ 1000): the next Swap replays without error, so the bad value stays and the pool remains unquotable until its state is re-read from chain.
- If the value were converted to bigint but still written to `lpFee`, the pool would be mispriced instead: +522 bps exact-in at 500/500, +27.6 to +30.1 bps at 250/0, and about −2,000 bps at 50/50.

Reproduction with the real ethers v5 decoding: `npx tsx harness/live_schedule_decoded.ts` (output in `report-live-decoded.txt`).

Expected values come from the real v4-core `Pool.sol` executed on anvil. The reproduction (oracle-backed vectors plus a harness that imports your files unmodified) is at https://github.com/let-the-dreamers-rise/v4-parity/tree/main/harnesses/paraswap (`npx tsx harness/repro_fee_event.ts`).

Suggested fix: `poolState.slot0.protocolFee = protocolFee;`, plus `BigInt(event.args.protocolFee)` in the handler. Without the `BigInt`, the next `getOneForZeroFee` (`>> 12n`) would throw a TypeError once the field is fixed. A tested patch with 4 jest cases is in https://github.com/let-the-dreamers-rise/v4-parity/blob/main/patches/paraswap-protocol-fee-updated.patch, and I'm happy to open it as a PR. The event tests in `uniswap-v4-events.test.ts` are currently commented out, which is why this wasn't caught.

Two smaller items from the same run, in case they are useful:
- `TickBitMap.ts:65,77` treats unfetched bitmap words as empty. Unlike the v3 integration, there is no out-of-range guard, even though `OUT_OF_RANGE_ERROR_POSTFIX` is declared.
- `swapFromEvent` infers the direction from `amount0 < 0n`, so valid Swap events with amount0 = 0 fail to replay and trigger a full re-fetch.

Found with v4-parity, a set of conformance vectors for Uniswap v4 swap math: https://github.com/let-the-dreamers-rise/v4-parity
