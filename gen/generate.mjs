// Generates conformance vectors by executing the real v4-core code (via src/Oracle.sol) on a local anvil node.
// Usage: node gen/generate.mjs [--seed N] [--swaps N] [--units N] [--out vectors]
// Deterministic: same seed + same v4-core commit => byte-identical output.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []),
);
const SEED = BigInt(args.seed ?? 1);
const N_SWAPS = Number(args.swaps ?? 3000);
const N_UNITS = Number(args.units ?? 2000);
const OUT = args.out ?? "vectors";
const NO_PF = args.protocolfee === "off"; // isolate core swap math from protocol-fee handling
const ANVIL = process.env.ANVIL ?? "anvil";
const PORT = 8600 + Number(SEED % 300n);

// ---------- deterministic PRNG (splitmix64) ----------
let st = SEED;
const M64 = (1n << 64n) - 1n;
function next64() {
  st = (st + 0x9e3779b97f4a7c15n) & M64;
  let z = st;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}
const rint = (lo, hi) => lo + Number(next64() % BigInt(hi - lo + 1)); // inclusive, small ranges
const rbig = (bits) => {
  let v = 0n;
  for (let b = 0; b < bits; b += 64) v = (v << 64n) | next64();
  return v & ((1n << BigInt(bits)) - 1n);
};
const pick = (xs) => xs[rint(0, xs.length - 1)];
const chance = (p) => Number(next64() % 10000n) < p * 10000;
// log-uniform magnitude in [1, 2^maxBits)
const rmag = (maxBits) => {
  const bits = rint(1, maxBits);
  return (rbig(bits) | (1n << BigInt(bits - 1))) & ((1n << BigInt(maxBits)) - 1n) || 1n;
};

// ---------- v4 constants ----------
const MIN_TICK = -887272, MAX_TICK = 887272;
const MIN_SQRT = 4295128739n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
const DYN_OVERRIDE = 0x400000;
const minUsable = (ts) => Math.ceil(MIN_TICK / ts) * ts; // matches TickMath.minUsableTick (rounds toward zero)
const maxUsable = (ts) => Math.floor(MAX_TICK / ts) * ts;
const minUsableTrunc = (ts) => Math.trunc(MIN_TICK / ts) * ts;
const maxUsableTrunc = (ts) => Math.trunc(MAX_TICK / ts) * ts;

// ---------- anvil + oracle ----------
const art = JSON.parse(readFileSync(new URL("../out/Oracle.sol/Oracle.json", import.meta.url)));
const abi = art.abi;
const anvil = spawn(ANVIL, ["--port", String(PORT), "--gas-limit", "1000000000000", "--code-size-limit", "1000000", "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
const rpc = `http://127.0.0.1:${PORT}`;
const transport = http(rpc, { retryCount: 0, timeout: 120000 });
const pub = createPublicClient({ chain: foundry, transport });
const acct = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const wal = createWalletClient({ chain: foundry, transport, account: acct });
for (let i = 0; ; i++) {
  try { await pub.getBlockNumber(); break; } catch { if (i > 100) throw new Error("anvil did not start"); await new Promise((r) => setTimeout(r, 100)); }
}
const hash = await wal.deployContract({ abi, bytecode: art.bytecode.object });
const { contractAddress: ORACLE } = await pub.waitForTransactionReceipt({ hash });

async function call(fn, a) {
  const data = encodeFunctionData({ abi, functionName: fn, args: a });
  try {
    const raw = await pub.request({ method: "eth_call", params: [{ to: ORACLE, data, gas: "0xE8D4A51000" }, "latest"] });
    return { ok: decodeFunctionResult({ abi, functionName: fn, data: raw }) };
  } catch (e) {
    const d = e?.cause?.data ?? e?.data ?? e?.cause?.cause?.data ?? e?.details;
    const m = typeof d === "string" ? d.match(/0x[0-9a-fA-F]{8,}/) : null;
    let sel = m ? m[0].slice(0, 10) : "unknown";
    let name = null;
    try { name = decodeErrorResult({ abi, data: m[0] }).errorName; } catch {}
    return { revert: sel, name };
  }
}

// ---------- scenario generation ----------
const TICK_SPACINGS = [1, 1, 10, 10, 60, 60, 200, 200, 2000, 16384, 32767];
const LP_FEES = [0, 100, 500, 3000, 3000, 10000, 100000, 500000, 999999, 1000000];
// realistic protocol fees per direction (pips): live v4 fee switch values plus the cap (1000)
const PROTO_FEES = [0, 0, 0, 1, 50, 100, 250, 300, 500, 1000];

function genPositions(ts) {
  const lo = minUsable(ts), hi = maxUsable(ts);
  const n = rint(1, 6);
  const out = [];
  for (let i = 0; i < n; i++) {
    let a, b;
    const kind = rint(0, 9);
    if (kind === 0) { a = lo; b = hi; } // full range
    else if (kind <= 5) { // narrow-ish around zero region
      const c = rint(-2000, 2000) * ts;
      a = Math.max(lo, c - rint(1, 50) * ts); b = Math.min(hi, c + rint(1, 50) * ts);
    } else { // anywhere
      a = rint(Math.ceil(lo / ts), Math.floor(hi / ts) - 1) * ts;
      b = Math.min(hi, a + rint(1, 5000) * ts);
    }
    if (a >= b) { a = lo; b = hi; }
    const liq = pick([1n, 1000n, rmag(64), rmag(80), rmag(80), rmag(96), rmag(96), rmag(110), 10n ** 18n, 10n ** 18n]);
    out.push({ tickLower: a, tickUpper: b, liquidity: liq });
  }
  return out;
}

function maxLiqPerTick(ts) {
  const minT = minUsableTrunc(ts), maxT = maxUsableTrunc(ts);
  const n = BigInt((maxT - minT) / ts + 1);
  return ((1n << 128n) - 1n) / n;
}

// ~40% of scenarios mirror live pools: standard tiers, protocol fee switch on
const LIVE = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
function genScenario(i) {
  const live = chance(0.4);
  const tier = pick(LIVE);
  const ts = live ? tier[1] : pick(TICK_SPACINGS);
  const positions = genPositions(ts);
  // keep per-tick gross liquidity under the cap so setup doesn't revert
  const cap = maxLiqPerTick(ts) / 7n;
  for (const p of positions) if (p.liquidity > cap) p.liquidity = cap > 0n ? cap : 1n;

  let sqrtPriceX96;
  const pk = rint(0, 9);
  const anchor = pick(positions);
  if (pk <= 2) sqrtPriceX96 = null; // exactly on an initialized tick boundary (filled below)
  else if (pk <= 7) {
    const t = rint(Math.max(MIN_TICK + 1, anchor.tickLower - 3 * ts), Math.min(MAX_TICK - 1, anchor.tickUpper + 3 * ts));
    sqrtPriceX96 = { tick: t, jitter: true };
  } else sqrtPriceX96 = { tick: rint(-100000, 100000), jitter: chance(0.5) };

  const lpFee = live ? tier[0] : chance(0.25) ? rint(0, 1000000) : pick(LP_FEES);
  const p0 = live ? pick([0, 50, 100, 250, 500, 1000]) : chance(0.3) ? rint(0, 1000) : pick(PROTO_FEES);
  const p1 = chance(0.5) ? p0 : (chance(0.3) ? rint(0, 1000) : pick(PROTO_FEES));
  const protocolFee = NO_PF ? 0 : (p1 << 12) | p0;
  const zeroForOne = chance(0.5);
  const exactIn = chance(0.6);
  const mag = pick([1n, 2n, 3n, rmag(32), rmag(64), rmag(96), rmag(126), (1n << 127n) - 1n]);
  const amountSpecified = exactIn ? -mag : mag;
  const lim = rint(0, 3);
  const lpFeeOverride = !live && chance(0.15) ? (DYN_OVERRIDE | (chance(0.7) ? pick(LP_FEES) : rint(0, 1000000))) : 0;
  return { ts, positions, sqrtPriceX96, lpFee, protocolFee, zeroForOne, amountSpecified, lim, lpFeeOverride, anchor };
}

async function resolvePrice(s) {
  if (s.sqrtPriceX96 === null) {
    const t = pick([s.anchor.tickLower, s.anchor.tickUpper]);
    return (await call("getSqrtPriceAtTick", [Math.max(MIN_TICK, Math.min(MAX_TICK, t))])).ok;
  }
  const base = (await call("getSqrtPriceAtTick", [s.sqrtPriceX96.tick])).ok;
  if (!s.sqrtPriceX96.jitter) return base;
  const nxt = (await call("getSqrtPriceAtTick", [Math.min(MAX_TICK, s.sqrtPriceX96.tick + 1)])).ok;
  const span = nxt - base;
  return span > 1n ? base + (rbig(160) % span) : base;
}

async function resolveLimit(s, price) {
  if (s.lim === 0) return s.zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n;
  if (s.lim === 1) {
    // a few ticks away
    const t = (await call("getTickAtSqrtPrice", [price])).ok;
    // price == MAX_SQRT_PRICE (pool at the top usable tick) is uninitializable; setup will reject it and regenerate
    if (t === undefined) return s.zeroForOne ? MIN_SQRT + 1n : MAX_SQRT - 1n;
    const tt = s.zeroForOne ? Math.max(MIN_TICK + 1, t - rint(1, 20) * s.ts) : Math.min(MAX_TICK - 1, t + rint(1, 20) * s.ts);
    const p = (await call("getSqrtPriceAtTick", [tt])).ok;
    return p;
  }
  if (s.lim === 2) return s.zeroForOne ? price - 1n : price + 1n; // 1 wei of price room
  // random within bounds
  return s.zeroForOne ? MIN_SQRT + 1n + (rbig(160) % (price - MIN_SQRT - 1n || 1n)) : price + 1n + (rbig(160) % (MAX_SQRT - price - 1n || 1n));
}

const s = (v) => (typeof v === "bigint" ? v.toString() : v);
mkdirSync(OUT, { recursive: true });

// ---------- swap vectors ----------
const swaps = [];
let ok = 0, rev = 0, setupRev = 0;
for (let i = 0; i < N_SWAPS; i++) {
  const g = genScenario(i);
  const price = await resolvePrice(g);
  const limit = await resolveLimit(g, price);
  const scen = {
    tickSpacing: g.ts, sqrtPriceX96: price, lpFee: g.lpFee, protocolFee: g.protocolFee,
    positions: g.positions, zeroForOne: g.zeroForOne, amountSpecified: g.amountSpecified,
    sqrtPriceLimitX96: limit, lpFeeOverride: g.lpFeeOverride,
  };
  const setup = await call("stateAfterSetup", [scen]);
  if (setup.revert) { setupRev++; i--; continue; } // regenerate invalid setups
  const r = await call("swap", [scen]);
  const vec = {
    id: `swap-${SEED}-${i}`,
    pool: {
      tickSpacing: g.ts, lpFee: g.lpFee,
      protocolFeeZeroForOne: g.protocolFee & 0xfff, protocolFeeOneForZero: g.protocolFee >> 12,
      sqrtPriceX96: s(price), tick: setup.ok[0], liquidity: s(setup.ok[1]),
      positions: g.positions.map((p) => ({ tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: s(p.liquidity) })),
    },
    swap: {
      zeroForOne: g.zeroForOne, amountSpecified: s(g.amountSpecified), sqrtPriceLimitX96: s(limit),
      lpFeeOverride: g.lpFeeOverride,
    },
  };
  if (r.ok) {
    ok++;
    const o = r.ok;
    vec.expect = {
      amount0: s(o.amount0), amount1: s(o.amount1), amountToProtocol: s(o.amountToProtocol), swapFee: o.swapFee,
      sqrtPriceX96: s(o.sqrtPriceX96), tick: o.tick, liquidity: s(o.liquidity),
    };
  } else { rev++; vec.expect = { revert: r.name ?? r.revert }; }
  swaps.push(vec);
}
writeFileSync(`${OUT}/swaps.json`, JSON.stringify({ generator: "v4-parity", seed: s(SEED), v4core: process.env.V4CORE_COMMIT ?? "unknown", conventions: "amountSpecified<0 means exact input (v4); amounts are pool deltas from the swapper's view: negative = paid into pool, positive = received", vectors: swaps }, null, 1));

// ---------- unit vectors ----------
const units = [];
const someTick = () => pick([MIN_TICK, MAX_TICK, 0, -1, 1, rint(MIN_TICK, MAX_TICK), rint(-1000, 1000)]);
const somePrice = () => pick([MIN_SQRT, MAX_SQRT - 1n, 1n << 96n, MIN_SQRT + rbig(160) % (MAX_SQRT - MIN_SQRT)]);
const someLiq = () => pick([0n, 1n, rmag(64), rmag(128), (1n << 128n) - 1n]);
for (let i = 0; i < N_UNITS; i++) {
  const kind = i % 8;
  let fn, a;
  if (kind === 0) { fn = "getSqrtPriceAtTick"; a = [someTick()]; }
  else if (kind === 1) { fn = "getTickAtSqrtPrice"; a = [somePrice()]; }
  else if (kind === 2) { fn = "getAmount0Delta"; a = [somePrice(), somePrice(), someLiq(), chance(0.5)]; }
  else if (kind === 3) { fn = "getAmount1Delta"; a = [somePrice(), somePrice(), someLiq(), chance(0.5)]; }
  else if (kind === 4) { fn = "getNextSqrtPriceFromInput"; a = [somePrice(), someLiq(), pick([0n, 1n, rmag(64), rmag(128), rmag(255)]), chance(0.5)]; }
  else if (kind === 5) { fn = "getNextSqrtPriceFromOutput"; a = [somePrice(), someLiq(), pick([0n, 1n, rmag(64), rmag(128)]), chance(0.5)]; }
  else if (kind === 6) {
    fn = "computeSwapStep";
    const c = somePrice(), t = somePrice();
    const m = pick([1n, rmag(64), rmag(128), rmag(200)]);
    a = [c, t, someLiq(), chance(0.5) ? -m : m, chance(0.3) ? rint(0, 1000000) : pick(LP_FEES)];
  } else { fn = "calculateSwapFee"; a = [chance(0.3) ? rint(0, 1000) : pick(PROTO_FEES), chance(0.3) ? rint(0, 1000000) : pick(LP_FEES)]; }
  const r = await call(fn, a);
  units.push({ fn, args: a.map(s), expect: r.ok !== undefined ? (Array.isArray(r.ok) ? r.ok.map(s) : s(r.ok)) : { revert: r.name ?? r.revert } });
}
writeFileSync(`${OUT}/units.json`, JSON.stringify({ generator: "v4-parity", seed: s(SEED), vectors: units }, null, 1));
console.log(JSON.stringify({ seed: s(SEED), swaps: swaps.length, swapOk: ok, swapRevert: rev, regeneratedSetups: setupRev, units: units.length }));
anvil.kill();
process.exit(0);
