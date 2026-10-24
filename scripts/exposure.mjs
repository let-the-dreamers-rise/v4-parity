// Live exposure scan: which v4 pools have a protocol fee since Proposal 100, with what values,
// and what share of recent v4 swaps hit them. Read-only, no dependencies (Node 18+).
// Usage: node scripts/exposure.mjs [chain ...]        e.g. node scripts/exposure.mjs ethereum base
// Override an RPC with env, e.g. RPC_BASE=https://... ; output: exposure/<chain>.json + exposure/SUMMARY.md
import { mkdirSync, writeFileSync } from "node:fs";

// PoolManager addresses: verify against https://docs.uniswap.org/contracts/v4/deployments before relying on results.
const CHAINS = {
  ethereum: { pm: "0x000000000004444c5dc75cB358380D2e3dE08A90", rpcs: ["https://eth.drpc.org", "https://eth.llamarpc.com", "https://1rpc.io/eth", "https://ethereum-rpc.publicnode.com"] },
  base: { pm: "0x498581fF718922c3f8e6A244956aF099B2652b2b", rpcs: ["https://base.drpc.org", "https://mainnet.base.org", "https://base.llamarpc.com", "https://1rpc.io/base", "https://base-rpc.publicnode.com"] },
  arbitrum: { pm: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32", rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org", "https://1rpc.io/arb", "https://arbitrum-one-rpc.publicnode.com"] },
  optimism: { pm: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3", rpcs: ["https://mainnet.optimism.io", "https://optimism.drpc.org", "https://1rpc.io/op", "https://optimism-rpc.publicnode.com"] },
  polygon: { pm: "0x67366782805870060151383F4BbFF9daB53e5cD6", rpcs: ["https://polygon.drpc.org", "https://polygon-rpc.com", "https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"] },
  bnb: { pm: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF", rpcs: ["https://bsc.drpc.org", "https://1rpc.io/bnb", "https://bsc-rpc.publicnode.com"] },
};
const TOPIC_PROTOCOL_FEE = "0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9"; // ProtocolFeeUpdated(bytes32,uint24)
const TOPIC_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"; // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
const PROP100_EXECUTED = Date.UTC(2026, 6, 27, 15, 20) / 1000; // 27 Jul 2026 15:20 UTC

let rpcId = 0;
async function rpc(url, method, params, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      if (i >= tries || /range|limit|too many|exceed|10000|block|archive|token|pruned|key|auth|forbidden/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}
const hex = (n) => "0x" + n.toString(16);

const NO_HISTORY = /archive|token|pruned|api key|unauthori|forbidden|not available|missing trie|header not found/i;

// Binary search in a window around a block-time estimate, so pruned nodes are never asked for ancient blocks.
async function blockAtOrAfter(url, ts) {
  const head = Number(await rpc(url, "eth_blockNumber", []));
  const tsOf = async (n) => {
    const b = await rpc(url, "eth_getBlockByNumber", [hex(n), false]);
    if (!b) throw new Error(`history unavailable: block ${n} returned null`);
    return Number(b.timestamp);
  };
  const tHead = await tsOf(head), back = Math.min(head - 1, 100_000), tBack = await tsOf(head - back);
  const perBlock = Math.max((tHead - tBack) / back, 0.05);
  const est = Math.max(1, Math.round(head - (tHead - ts) / perBlock));
  let lo = Math.max(1, est - Math.ceil(86400 / perBlock)), hi = Math.min(head, est + Math.ceil(86400 / perBlock));
  while (lo > 1 && (await tsOf(lo)) >= ts) lo = Math.max(1, lo - Math.ceil(86400 / perBlock));
  while (hi < head && (await tsOf(hi)) < ts) hi = Math.min(head, hi + Math.ceil(86400 / perBlock));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await rpc(url, "eth_getBlockByNumber", [hex(mid), false]);
    if (b == null) throw new Error(`history unavailable: block ${mid} returned null`);
    if (Number(b.timestamp) < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// getLogs over [from, to] with an adaptive window: halve on provider range errors, grow on success.
async function logs(url, address, topic0, from, to, onProgress) {
  const out = [];
  let win = 5_000;
  for (let a = from; a <= to; ) {
    const b = Math.min(to, a + win - 1);
    try {
      out.push(...(await rpc(url, "eth_getLogs", [{ address, topics: [topic0], fromBlock: hex(a), toBlock: hex(b) }])));
      a = b + 1;
      win = Math.min(win * 2, 500_000);
      onProgress?.(a, to);
    } catch (e) {
      if (NO_HISTORY.test(e.message) || win <= 100) throw e;
      win = Math.floor(win / 2);
    }
  }
  return out;
}

export function decodeProtocolFee(log) {
  const fee = Number(BigInt(log.data) & 0xffffffn);
  return { pool: log.topics[1], block: Number(log.blockNumber), fee, zeroForOne: fee & 0xfff, oneForZero: fee >> 12 };
}

async function scan(name, { pm, rpcs }) {
  const list = process.env[`RPC_${name.toUpperCase()}`] ? [process.env[`RPC_${name.toUpperCase()}`]] : rpcs;
  const errors = [];
  for (const url of list) {
    try {
      return await scanWith(name, pm, url);
    } catch (e) {
      process.stderr.write(`\n${name}: ${url} failed: ${e.message}\n`);
      errors.push(`${new URL(url).host}: ${e.message.slice(0, 80)}`);
    }
  }
  throw new Error(errors.join("; "));
}

async function scanWith(name, pm, url) {
  const head = Number(await rpc(url, "eth_blockNumber", []));
  const start = await blockAtOrAfter(url, PROP100_EXECUTED - 86400); // a day early, to catch the activation itself
  process.stderr.write(`${name}: ${new URL(url).host} blocks ${start}..${head}\n`);
  const feeLogs = (await logs(url, pm, TOPIC_PROTOCOL_FEE, start, head, (a, t) => process.stderr.write(`\r${name} fees ${Math.round((100 * (a - start)) / (t - start))}%`))).map(decodeProtocolFee);
  process.stderr.write("\n");
  const latest = new Map();
  for (const e of feeLogs) latest.set(e.pool, e); // logs come in block order
  const now = [...latest.values()];
  const on = now.filter((e) => e.fee !== 0);
  const values = {};
  for (const e of on) values[`${e.zeroForOne}/${e.oneForZero}`] = (values[`${e.zeroForOne}/${e.oneForZero}`] ?? 0) + 1;
  // swap share over the last ~24h
  const dayAgo = await blockAtOrAfter(url, Math.floor(Date.now() / 1000) - 86400);
  const swaps = await logs(url, pm, TOPIC_SWAP, dayAgo, head);
  const onSet = new Set(on.map((e) => e.pool));
  const swapsOnFeePools = swaps.filter((l) => onSet.has(l.topics[1])).length;
  const res = {
    chain: name, poolManager: pm, rpc: new URL(url).host, fromBlock: start, toBlock: head,
    protocolFeeUpdatedEvents: feeLogs.length, poolsEverSet: latest.size, poolsFeeOnNow: on.length,
    poolsSetBackToZero: now.length - on.length,
    symmetric: on.filter((e) => e.zeroForOne === e.oneForZero).length,
    asymmetric: on.filter((e) => e.zeroForOne !== e.oneForZero).length,
    packedAtLeast1e6: on.filter((e) => e.fee >= 1_000_000).length, // ParaSwap: overquote branch
    packedUpTo1000: on.filter((e) => e.fee <= 1000).length, // ParaSwap: persistent branch
    feeValues: values,
    swapsLast24h: swaps.length, swapsLast24hOnFeeOnPools: swapsOnFeePools,
    firstEventBlock: feeLogs[0]?.block ?? null, lastEventBlock: feeLogs.at(-1)?.block ?? null,
  };
  return res;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("exposure.mjs")) {
  const pick = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHAINS);
  mkdirSync("exposure", { recursive: true });
  const rows = [];
  for (const c of pick) {
    try {
      const r = await scan(c, CHAINS[c]);
      writeFileSync(`exposure/${c}.json`, JSON.stringify(r, null, 1));
      rows.push(r);
      console.log(JSON.stringify(r));
    } catch (e) {
      console.error(`${c}: FAILED ${e.message}`);
      rows.push({ chain: c, error: e.message });
    }
  }
  const md = ["| chain | pools fee-on now | symmetric | asymmetric | set back to 0 | packed ≥1e6 | swaps 24h | on fee-on pools |", "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => r.error ? `| ${r.chain} | error: ${r.error} |||||||` : `| ${r.chain} | ${r.poolsFeeOnNow} | ${r.symmetric} | ${r.asymmetric} | ${r.poolsSetBackToZero} | ${r.packedAtLeast1e6} | ${r.swapsLast24h} | ${r.swapsLast24hOnFeeOnPools} |`)];
  writeFileSync("exposure/SUMMARY.md", `# v4 protocol-fee exposure (generated ${new Date().toISOString()})\n\n${md.join("\n")}\n`);
  console.log(md.join("\n"));
}
