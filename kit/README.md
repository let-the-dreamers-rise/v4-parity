# Run v4-parity against your own quoter

v4-parity checks that an off-chain Uniswap v4 quoter gives the same answer as the real `PoolManager`.
The 6,000 swap vectors were produced by executing v4-core (commit `46c68346`), and every one is
re-checked against `PoolManager` in this repo's CI. Since Proposal 100 turned protocol fees on
(27 Jul 2026), most live v4 swaps go through fee-on pools, so `swaps` (fees on) is the set to run.

You write one small adapter, and the check runs in your CI on every commit.

## 1. Write an adapter (any language)

The adapter is called as `<command> <vectors.json> <results.jsonl>`. For each vector it builds a
pool from `v.pool`, which is exactly what an indexer reads on-chain, runs the swap in `v.swap`
through your quoter, and writes one JSON line:

```json
{"id":"swap-1-0","amountOut":"1840274"}
{"id":"swap-1-1","amountIn":"99173","sqrtPriceX96":"7922816251426433759354395033","tick":-3}
{"id":"swap-1-2","error":"insufficient liquidity"}
{"id":"swap-1-3","unsupported":"hook LP-fee override"}
```

- Exact input (`amountSpecified < 0`, the v4 sign): give `amountOut`. Exact output: give `amountIn`.
  Both are unsigned decimal strings. The other side and the post-swap `sqrtPriceX96`, `tick` and
  `liquidity` are checked when you give them.
- `error` means your quoter refused the swap. That passes when `PoolManager` reverts too.
- `unsupported` means the quoter can't express this pool (for example a hook override you never route). It is not a failure.

The pool fields are `tickSpacing`, `lpFee`, `protocolFeeZeroForOne` and `protocolFeeOneForZero`
(the two halves of `slot0.protocolFee`), plus `sqrtPriceX96`, `tick`, `liquidity` and `positions`.
`positions` gives the initialized ticks: `liquidityNet[lower] += L`, `liquidityNet[upper] -= L`.
`swap.lpFeeOverride` is non-zero when a `beforeSwap` hook overrides the LP fee. The full format is
in [`harnesses/BRIEF.md`](../harnesses/BRIEF.md).

Examples:
- [`adapters/uniswap-v4-sdk/adapter.mjs`](adapters/uniswap-v4-sdk/adapter.mjs) covers `@uniswap/v4-sdk` in about 60 lines.
  Copy it and replace `quote()` with your own quoter.
- Full harnesses for KyberSwap (Go), ParaSwap (TS), the Rust v4 SDK and Tycho (Rust) are in [`harnesses/`](../harnesses).

## 2. Add the GitHub Action (about 10 lines)

```yaml
# .github/workflows/v4-parity.yml
name: v4-parity
on: [push, pull_request]
jobs:
  parity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: let-the-dreamers-rise/v4-parity@v1
        with:
          command: node scripts/v4-parity-adapter.mjs   # or: go run ./cmd/v4parity, cargo run --bin v4parity ...
          vectors: swaps                                # protocol fees on; swaps-nopf = fees off
```

The job summary shows how many vectors match and groups the failures into classes, each with an
example id, the expected value, what you returned and the error in bps.

## 3. Adopt it with known failures (optional)

If you can't fix everything at once, record the current failures and fail only on new ones:

```sh
node kit/check.mjs --vectors vectors/swaps.json --run "node your-adapter.mjs" --allow-unsupported --write-baseline v4-parity-known.json
```

Commit the file and add `baseline: v4-parity-known.json` to the Action. Delete ids from it as you
fix them. The `@uniswap/v4-sdk` example runs this way in this repo's own CI:
[`known-swaps.json`](adapters/uniswap-v4-sdk/known-swaps.json) holds 591 fee-on vectors the SDK cannot get right yet, because it has no protocol-fee input.

## Run it locally

```sh
git clone https://github.com/let-the-dreamers-rise/v4-parity && cd v4-parity
node kit/check.mjs --vectors vectors/swaps.json --run "node /path/to/your-adapter.mjs" --allow-unsupported
```

The checker needs only Node 18 or later and has no dependencies.

## Using it?

Please open an issue or a PR adding your project to the list below, so the vectors can grow
toward the pools you actually route (hook fee paths, unusual tick spacings, and so on).

| Project | Since | Set |
|---|---|---|
| (your project) | | |
