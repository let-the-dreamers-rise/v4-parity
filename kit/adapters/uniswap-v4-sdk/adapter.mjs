// Example v4-parity adapter: quotes every vector with @uniswap/v4-sdk the way integrators use it.
// Usage: node adapter.mjs <vectors.json> <results.jsonl>
// Copy this file and swap `quote()` for your own quoter: build your pool object from `v.pool`
// (exactly what an indexer reads on-chain), run the swap in `v.swap`, write amountIn/amountOut.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const JSBI = require("jsbi");
const { Token, CurrencyAmount } = require("@uniswap/sdk-core");
const { Tick, TickListDataProvider } = require("@uniswap/v3-sdk");
const { Pool } = require("@uniswap/v4-sdk");

const [vecPath, outPath] = process.argv.slice(2);
const data = JSON.parse(readFileSync(vecPath, "utf8"));
const vectors = data.vectors ?? data;
const T0 = new Token(1, "0x0000000000000000000000000000000000000001", 18, "T0");
const T1 = new Token(1, "0x0000000000000000000000000000000000000002", 18, "T1");

// v.pool.positions -> initialized ticks (liquidityNet / liquidityGross), as an indexer would hold them
function ticks(positions) {
  const m = new Map();
  for (const p of positions) {
    const L = BigInt(p.liquidity);
    for (const [t, net] of [[p.tickLower, L], [p.tickUpper, -L]]) {
      const c = m.get(t) ?? { net: 0n, gross: 0n };
      c.net += net; c.gross += L; m.set(t, c);
    }
  }
  return [...m].sort((a, b) => a[0] - b[0]).map(([index, c]) => new Tick({ index, liquidityGross: c.gross.toString(), liquidityNet: c.net.toString() }));
}

async function quote(v) {
  const { pool: p, swap: s } = v;
  // The SDK has no protocol-fee input and only simulates hookless pools: report what it can't express.
  if (s.lpFeeOverride !== 0) return { unsupported: "dynamic-fee hook override" };
  if (p.lpFee >= 1000000) return { unsupported: "lpFee 100% rejected by Pool constructor" };
  const pool = new Pool(T0, T1, p.lpFee, p.tickSpacing, "0x0000000000000000000000000000000000000000",
    p.sqrtPriceX96, p.liquidity, p.tick, new TickListDataProvider(ticks(p.positions), p.tickSpacing));
  const amt = BigInt(s.amountSpecified); // v4: negative = exact input
  const limit = JSBI.BigInt(s.sqrtPriceLimitX96);
  if (amt < 0n) {
    const [out, after] = await pool.getOutputAmount(CurrencyAmount.fromRawAmount(s.zeroForOne ? T0 : T1, (-amt).toString()), limit);
    return { amountOut: out.quotient.toString(), sqrtPriceX96: after.sqrtRatioX96.toString(), tick: after.tickCurrent };
  }
  const [inp, after] = await pool.getInputAmount(CurrencyAmount.fromRawAmount(s.zeroForOne ? T1 : T0, amt.toString()), limit);
  return { amountIn: inp.quotient.toString(), sqrtPriceX96: after.sqrtRatioX96.toString(), tick: after.tickCurrent };
}

const lines = [];
for (const v of vectors) {
  let r;
  try { r = await quote(v); } catch (e) { r = { error: e.message || String(e) }; }
  lines.push(JSON.stringify({ id: v.id, ...r }));
}
writeFileSync(outPath, lines.join("\n") + "\n");
