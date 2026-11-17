#!/usr/bin/env node
// v4-parity check: compares a quoter's results with what the real v4-core PoolManager did.
// Zero dependencies (Node 18+).
//
//   node kit/check.mjs --vectors vectors/swaps.json --results results.jsonl
//                      [--baseline known.json] [--allow-unsupported] [--summary out.md] [--report out.json]
//   node kit/check.mjs --vectors vectors/swaps.json --run "node my-adapter.mjs"   # runs the adapter for you
//
// Results: a JSON array or JSON lines, one object per vector id (see kit/README.md):
//   {"id":"swap-1-0","amountIn":"123","amountOut":"456"}      quoted (decimal strings, unsigned)
//   {"id":"swap-1-0","error":"..."}                            quoter refused / threw
//   {"id":"swap-1-0","unsupported":"..."}                      quoter cannot express this pool (not a failure)
// Optional extra fields compared when present: sqrtPriceX96, tick, liquidity (state after the swap).
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const flag = (k) => argv.includes(`--${k}`);
const VEC = opt("vectors");
let RES = opt("results");
const RUN = opt("run");
if (!VEC || (!RES && !RUN)) {
  console.error("usage: check.mjs --vectors <swaps.json> (--results <file> | --run \"<adapter command>\") [--baseline f] [--allow-unsupported] [--summary f] [--report f]");
  process.exit(2);
}

if (RUN) {
  RES ??= join(mkdtempSync(join(tmpdir(), "v4p-")), "results.jsonl");
  const r = spawnSync(`${RUN} ${JSON.stringify(resolve(VEC))} ${JSON.stringify(resolve(RES))}`, {
    shell: true, stdio: "inherit", env: { ...process.env, V4P_VECTORS: resolve(VEC), V4P_RESULTS: resolve(RES) },
  });
  if (r.status !== 0) { console.error(`adapter exited with ${r.status}`); process.exit(2); }
}

const data = JSON.parse(readFileSync(VEC, "utf8"));
const vectors = data.vectors ?? data;
const raw = readFileSync(RES, "utf8").trim();
const list = raw.startsWith("[") ? JSON.parse(raw) : raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const results = new Map(list.map((r) => [r.id, r]));
const baseline = new Set(opt("baseline") ? JSON.parse(readFileSync(opt("baseline"), "utf8")).known ?? [] : []);

// What the swapper pays (amountIn) and receives (amountOut), from v4's BalanceDelta (negative = paid).
function expected(v) {
  const e = v.expect;
  if (e.revert) return { revert: e.revert };
  const [inS, outS] = v.swap.zeroForOne ? [e.amount0, e.amount1] : [e.amount1, e.amount0];
  return { amountIn: (-BigInt(inS)).toString(), amountOut: BigInt(outS).toString(), sqrtPriceX96: e.sqrtPriceX96, tick: e.tick, liquidity: e.liquidity, swapFee: e.swapFee };
}

const counts = { PASS: 0, MISMATCH: 0, ERROR: 0, UNSUPPORTED: 0, MISSING: 0, KNOWN: 0 };
const failures = [];
const unsupported = {};
for (const v of vectors) {
  const r = results.get(v.id);
  const exp = expected(v);
  const exactIn = BigInt(v.swap.amountSpecified) < 0n;
  let verdict, detail;
  if (!r) { verdict = "MISSING"; }
  else if (r.unsupported !== undefined) { verdict = "UNSUPPORTED"; const k = String(r.unsupported).split(":")[0]; unsupported[k] = (unsupported[k] ?? 0) + 1; }
  else if (exp.revert) {
    if (r.error !== undefined) verdict = "PASS";
    else { verdict = "MISMATCH"; detail = { field: "revert", expected: `PoolManager reverts (${exp.revert})`, got: `quoted ${["amountIn","amountOut"].filter((k) => r[k] !== undefined).map((k) => `${k}=${r[k]}`).join(" ")}` }; }
  } else if (r.error !== undefined) { verdict = "ERROR"; detail = { field: "error", expected: `in=${exp.amountIn} out=${exp.amountOut}`, got: String(r.error).slice(0, 200) }; }
  else {
    // The calculated side must be present; the specified side and post-swap state are checked when given.
    const required = exactIn ? "amountOut" : "amountIn";
    const fields = ["amountIn", "amountOut", "sqrtPriceX96", "tick", "liquidity"].filter((f) => f === required || r[f] !== undefined);
    const bad = fields.filter((f) => String(r[f]) !== String(exp[f]));
    if (!bad.length) verdict = "PASS";
    else {
      verdict = "MISMATCH";
      const f = bad[0];
      detail = { field: f, expected: String(exp[f]), got: String(r[f]) };
      if ((f === "amountIn" || f === "amountOut") && r[f] !== undefined && exp[f] !== "0") {
        const d = BigInt(r[f]) - BigInt(exp[f]);
        detail.diff = d.toString();
        detail.bps = Number((d * 1000000n) / BigInt(exp[f])) / 100;
      }
      if (bad.length > 1) detail.alsoWrong = bad.slice(1);
    }
  }
  if ((verdict === "MISMATCH" || verdict === "ERROR" || verdict === "MISSING") && baseline.has(v.id)) { counts.KNOWN++; continue; }
  counts[verdict]++;
  if (verdict === "MISMATCH" || verdict === "ERROR" || verdict === "MISSING") {
    failures.push({ id: v.id, verdict, pool: { lpFee: v.pool.lpFee, protocolFee: v.swap.zeroForOne ? v.pool.protocolFeeZeroForOne : v.pool.protocolFeeOneForZero, lpFeeOverride: v.swap.lpFeeOverride, tickSpacing: v.pool.tickSpacing }, exactIn, zeroForOne: v.swap.zeroForOne, ...detail });
  }
}

// Group failures into classes a maintainer can act on.
const classOf = (f) => {
  if (f.verdict === "MISSING") return "no result for this vector";
  if (f.field === "revert") return "quoted a swap the PoolManager rejects";
  if (f.verdict === "ERROR") return "threw on a swap the PoolManager executes";
  const fee = f.pool.protocolFee ? "protocol fee on" : "protocol fee off";
  const hook = f.pool.lpFeeOverride ? ", hook LP-fee override" : "";
  const dir = f.diff === undefined ? "" : BigInt(f.diff) > 0n ? (f.field === "amountOut" ? ", overquotes output" : ", overstates input") : (f.field === "amountOut" ? ", underquotes output" : ", understates input");
  return `${f.field} differs (${fee}${hook}${dir})`;
};
const classes = {};
for (const f of failures) (classes[classOf(f)] ??= []).push(f);

const failed = failures.length > 0 || (!flag("allow-unsupported") && counts.UNSUPPORTED > 0);
const total = vectors.length;
let md = `## v4-parity: ${failed ? "❌" : "✅"} ${counts.PASS} of ${total} vectors match PoolManager\n\n`;
md += `| PASS | MISMATCH | ERROR | MISSING | UNSUPPORTED | KNOWN (baseline) |\n|---|---|---|---|---|---|\n| ${counts.PASS} | ${counts.MISMATCH} | ${counts.ERROR} | ${counts.MISSING} | ${counts.UNSUPPORTED} | ${counts.KNOWN} |\n\n`;
md += `Vectors: \`${VEC}\` (${data.v4core ? `v4-core ${String(data.v4core).slice(0, 8)}, ` : ""}seed ${data.seed ?? "?"}).\n\n`;
if (Object.keys(classes).length) {
  md += `### Failure classes\n\n| Class | Count | Example | Expected | Got |\n|---|---|---|---|---|\n`;
  for (const [c, fs] of Object.entries(classes).sort((a, b) => b[1].length - a[1].length)) {
    const e = fs[0];
    md += `| ${c} | ${fs.length} | \`${e.id}\` | ${e.expected ?? ""} | ${e.got ?? ""}${e.bps !== undefined ? ` (${e.bps > 0 ? "+" : ""}${e.bps} bps)` : ""} |\n`;
  }
  md += `\nTo accept the current failures and only catch new ones: \`node kit/check.mjs ... --write-baseline known.json\`, commit it, pass \`baseline: known.json\`.\n`;
}
if (Object.keys(unsupported).length) md += `\nUnsupported: ${Object.entries(unsupported).map(([k, n]) => `${k} (${n})`).join("; ")}${flag("allow-unsupported") ? " (allowed)" : ". Pass --allow-unsupported to accept these."}\n`;

console.log(md);
if (opt("summary")) appendFileSync(opt("summary"), md + "\n");
if (opt("report")) writeFileSync(opt("report"), JSON.stringify({ vectors: VEC, counts, classes: Object.fromEntries(Object.entries(classes).map(([c, fs]) => [c, fs.length])), failures, unsupported }, null, 1));
if (opt("write-baseline")) {
  writeFileSync(opt("write-baseline"), JSON.stringify({ note: "v4-parity vectors this quoter is known to fail; remove ids as they are fixed", vectors: VEC, known: [...baseline, ...failures.map((f) => f.id)].sort() }, null, 1) + "\n");
  console.log(`wrote baseline with ${failures.length + baseline.size} ids to ${opt("write-baseline")}`);
  process.exit(0);
}
process.exit(failed ? 1 : 0);
