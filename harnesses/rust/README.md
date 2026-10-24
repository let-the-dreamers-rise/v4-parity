# Rust harness (uniswap-v4-sdk 2.0.0 / uniswap-v3-sdk 7.0.0 / uniswap_v3_math 0.6.2)

```sh
D=$(git rev-parse --show-toplevel)   # repo root
cd $D/harnesses/rust/harness && cargo build --release     # versions pinned with = in Cargo.toml, Cargo.lock included
cd $D/harnesses/rust
B=./harness/target/release/v4parity-rust
$B swaps $D/vectors/swaps.json      report-swaps.json
$B swaps $D/vectors-nopf/swaps.json report-swaps-nopf.json
$B units $D/vectors/units.json      report-units.json
$B swaps minimal.json                          report-minimal.json   # hand-built repros (expect from real v4-core)
$B probe                                                              # chained-quote / dynamic-fee / 1e6-fee probes
```

`report.json` combines the three main reports. Each swap report has these sections: `modeA_integrator` (fee = PoolKey lpFee; the SDK has no protocol-fee input), `modeB_fee_field_set_to_v4_swapFee`, and `highLevelAPI_*`. Each section lists counts, every mismatch (id, field, expected, got), target errors and unsupported cases.

To regenerate `minimal.json` against the real v4-core Oracle, run:
```sh
anvil --port 8987 --gas-limit 1000000000000 --code-size-limit 1000000 --silent &
ADDR=$(cast send --rpc-url http://127.0.0.1:8987 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --create $(cat oracle.bin) --json | python3 -c "import json,sys;print(json.load(sys.stdin)['contractAddress'])")
python3 -I make_minimal.py cast http://127.0.0.1:8987 $ADDR minimal.json
```
(`oracle.bin` is the bytecode from `out/Oracle.sol/Oracle.json` (run `forge build` at the repo root).)
