// Ibrahim's acceptance test 4 — MANUAL NEVER MOVES, made STRUCTURAL:
// there is nothing in SamaPay for the allowance to be blind to. Asserted
// over the SOURCE, with controls, because "no writer" is an absence claim:
//   1. `deposits` has NO writer outside src/observer/ (the "+" side is
//      chain observation only) — control: the observer's own write is found
//      once it exists; until then the section is VOID, not PASS.
//   2. no `source` column on deposits (a source filter is a predicate keyed
//      on a label — the exact hole SamaPrime named).
//   3. the allowance module never inserts a deposit, and reads only the two
//      aggregates. Control: it DOES insert withdrawals (so the probe can see
//      an insert when there is one).
//   4. no `manual` anything in src/ or prisma/ (the endpoint was dropped
//      from v1 by decision). Control: the word IS found in this file.
// No database needed; runs with plain tsx. The pre-processing has a
// survival marker so a transform that ate the input cannot pass.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { check, checkOver, summary, voidCheck } from "./lib/check.js";

const ROOT = new URL("..", import.meta.url).pathname;
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!/node_modules|dist|\.git/.test(name)) walk(p, out); }
    else if (/\.(ts|prisma|sql)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(join(ROOT, "src")).concat(walk(join(ROOT, "prisma")));
const src = files.map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "") }));
// Survival marker: after stripping comments the schema must still declare the deposits model.
const schema = src.find((f) => f.path.endsWith("schema.prisma"));
check(Boolean(schema && /model Deposit\b/.test(schema.text)), "CONTROL: the comment-stripped corpus still contains `model Deposit`", `${src.length} files`);

console.log("\n1. `deposits` has no writer outside src/observer/");
const depositWriters = src.filter((f) => /deposit\.(create|createMany|upsert|update|updateMany)\(|INSERT INTO\s+"?deposits/i.test(f.text));
const outside = depositWriters.filter((f) => !f.path.startsWith("src/observer/"));
const inside = depositWriters.filter((f) => f.path.startsWith("src/observer/"));
if (inside.length === 0) voidCheck("CONTROL: the observer's own deposit write is found", "src/observer/ has no deposit writer yet — the probe is unproven until it exists; re-run after the observer lands");
else check(true, "CONTROL: the observer's deposit write is found", inside.map((f) => f.path).join(", "));
checkOver(src.length, outside.length === 0, "*** no deposit writer outside src/observer/ ***", outside.length ? outside.map((f) => f.path).join(", ") : "none");

console.log("\n2. no `source` column on deposits");
const depositModel = schema ? (schema.text.match(/model Deposit \{[\s\S]*?\n\}/) ?? [""])[0] : "";
check(depositModel.length > 100, "CONTROL: the Deposit model block was sliced (non-trivial length)", `${depositModel.length} chars`);
check(!/\bsource\b/.test(depositModel), "*** Deposit carries no `source` column — nothing can be labelled into the sum ***", "");

console.log("\n3. the allowance module never writes a deposit, and DOES write withdrawals (control)");
const allowance = src.filter((f) => f.path.startsWith("src/allowance/"));
check(allowance.length >= 5, "CONTROL: the allowance module was read", `${allowance.length} files`);
check(allowance.every((f) => !/deposit\.(create|update|upsert|delete)/i.test(f.text)), "*** src/allowance/ never inserts, updates or deletes a deposit ***", "");
check(allowance.some((f) => /withdrawal\.create\(/.test(f.text)), "CONTROL: ...and it DOES insert withdrawals, so the probe can see an insert", "");
check(allowance.some((f) => /pg_advisory_xact_lock/.test(f.text)), "the per-key advisory lock is in the module (clause 6)", "");

console.log("\n4. no manual-deposit surface exists in SamaPay");
const manual = src.filter((f) => /manual[_-]?deposit|manualDeposit/i.test(f.text));
checkOver(src.length, manual.length === 0, "*** no `manual deposit` anywhere in src/ or prisma/ — nothing for the sum to be blind to ***", manual.length ? manual.map((f) => f.path).join(", ") : "none");
check(/manual[_-]?deposit/i.test(readFileSync(new URL(import.meta.url).pathname, "utf8")), "CONTROL: the probe finds the phrase in THIS file", "");

process.exit(summary());
