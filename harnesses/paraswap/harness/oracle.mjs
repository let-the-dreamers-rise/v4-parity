// Runs hand-built minimal scenarios through the v4-parity Oracle (real v4-core Pool.sol on anvil) and
// writes them in the swap-vector schema. Read-only use of ../../v4-parity/out and its node_modules.
// Usage: node harness/oracle.mjs <out.json>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const S = new URL("../../../", import.meta.url).pathname.replace(/\/$/, ""); // repo root
const viem = await import(`${S}/node_modules/viem/_esm/index.js`);
const { privateKeyToAccount } = await import(`${S}/node_modules/viem/_esm/accounts/index.js`);
const { foundry } = await import(`${S}/node_modules/viem/_esm/chains/index.js`);
const art = JSON.parse(readFileSync(`${S}/out/Oracle.sol/Oracle.json`));
const abi = art.abi;
const PORT = 8991;
const anvil = spawn(process.env.ANVIL ?? "anvil", ["--port", String(PORT), "--gas-limit", "1000000000000", "--code-size-limit", "1000000", "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
const transport = viem.http(`http://127.0.0.1:${PORT}`, { retryCount: 0, timeout: 120000 });
const pub = viem.createPublicClient({ chain: foundry, transport });
const wal = viem.createWalletClient({ chain: foundry, transport, account: privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") });
for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 100) throw 0; await new Promise(r => setTimeout(r, 100)); } }
const { contractAddress: O } = await pub.waitForTransactionReceipt({ hash: await wal.deployContract({ abi, bytecode: art.bytecode.object }) });
async function call(fn, a) {
  const data = viem.encodeFunctionData({ abi, functionName: fn, args: a });
  try { return { ok: viem.decodeFunctionResult({ abi, functionName: fn, data: await pub.request({ method: "eth_call", params: [{ to: O, data, gas: "0xE8D4A51000" }, "latest"] }) }) }; }
  catch (e) { return { revert: String(e.shortMessage ?? e).slice(0, 80) }; }
}
const MIN = 4295128739n, MAX = 1461446703485210103287273052203988822378723970342n;
const sqrtAt = async t => (await call("getSqrtPriceAtTick", [t])).ok;
const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
const pool3000 = { ts: 60, lpFee: 3000, price: Q96, pos: [{ tickLower: -6000, tickUpper: 6000, liquidity: 10n ** 24n }] };
const cases = [
  // F1: protocol fee only on zeroForOne (packed = 250) - realistic 30bps pool
  ["min-pf-250-0-z4o-in", pool3000, 250, true, -E18, MIN + 1n],
  ["min-pf-250-0-o4z-in", pool3000, 250, false, -E18, MAX - 1n],
  ["min-pf-250-0-z4o-out", pool3000, 250, true, E18, MIN + 1n],
  // F1: symmetric 50 pips both directions (packed = 50 | 50<<12 = 204850)
  ["min-pf-50-50-z4o-in", pool3000, 50 | (50 << 12), true, -E18, MIN + 1n],
  ["min-pf-50-50-o4z-out", pool3000, 50 | (50 << 12), false, E18, MAX - 1n],
  // reference without protocol fee (for the "fee switched off" case)
  ["min-pf-0-z4o-in", pool3000, 0, true, -E18, MIN + 1n],
  // F2: tick-bitmap window. ts=1 pool, liquidity ends at tick 7000 (27 words away) - swap up to tick 9000
  ["min-range-ts1", { ts: 1, lpFee: 100, price: Q96, pos: [{ tickLower: -100, tickUpper: 7000, liquidity: 10n ** 21n }] }, 0, false, -(10n ** 30n), await sqrtAt(9000)],
];
const out = [];
for (const [id, p, pf, zf, amt, lim] of cases) {
  const scen = { tickSpacing: p.ts, sqrtPriceX96: p.price, lpFee: p.lpFee, protocolFee: pf, positions: p.pos, zeroForOne: zf, amountSpecified: amt, sqrtPriceLimitX96: lim, lpFeeOverride: 0 };
  const setup = (await call("stateAfterSetup", [scen])).ok;
  const r = await call("swap", [scen]);
  const s = x => (typeof x === "bigint" ? x.toString() : x);
  out.push({ id, pool: { tickSpacing: p.ts, lpFee: p.lpFee, protocolFeeZeroForOne: pf & 0xfff, protocolFeeOneForZero: pf >> 12, sqrtPriceX96: s(p.price), tick: setup[0], liquidity: s(setup[1]), positions: p.pos.map(q => ({ ...q, liquidity: s(q.liquidity) })) },
    swap: { zeroForOne: zf, amountSpecified: s(amt), sqrtPriceLimitX96: s(lim), lpFeeOverride: 0 },
    expect: r.ok ? Object.fromEntries(Object.entries(r.ok).map(([k, v]) => [k, s(v)])) : { revert: r.revert } });
}
writeFileSync(process.argv[2], JSON.stringify({ generator: "paraswap-harness/oracle.mjs (v4-parity Oracle)", vectors: out }, null, 1));
console.log(JSON.stringify(out.map(v => [v.id, v.expect]), null, 0));
process.exit(0);
