// COVERS: src/**/*.ts scripts/**/*.ts prisma/contract-pending/20260926000000_client_id_not_null/migration.sql
//
// STRUCTURAL GATE — precondition for the contract-pending NOT NULL migration
// (contract v1.1 A12, review Q "cross-branch precondition"): every Prisma write
// that creates a row in `addresses`, `deposits` or `webhook_deliveries` must
// set client_id. A site that omits it is a NULL row the day NOT NULL lands —
// or, after it lands, a write that throws in production.
//
// HOW IT READS (TypeScript AST, not grep): every call `<x>.address|deposit|
// webhookDelivery.create|createMany|upsert(...)`. The row object — `data` for
// create/createMany, `create` for upsert — must be an OBJECT LITERAL with a
// `clientId` (or `client`) property. Anything it cannot prove is a FAIL, never
// a pass: `data: someVariable`, a spread with no explicit clientId. Raw SQL in
// a string/template literal that INSERTs into one of the three tables must
// name client_id.
//
// SCOPE. PRODUCTION WRITERS = src/** and scripts/** except verify fixtures
// (scripts/verify-*.ts, scripts/lib/**, scripts/throwaway-sandbox.ts). Those
// GATE (exit 1). FIXTURES are listed as FIXTURE lines and do not gate: they run
// only on throwaway databases and fail loudly (not silently) once NOT NULL
// lands, but they still need client_id before the contract step.
// ALLOW: a comment `client-id-gate: allow <reason>` on the line above (or the
// same line) exempts one site; the reason is printed.
//
// CONTROLS: (1) a detector self-test on inline snippets — a site WITHOUT
// clientId must be flagged and one WITH it must pass, else VOID; (2) the
// population of production sites must be > 0, else VOID.
//
// USAGE (no database, no heavy slot needed):
//   ./node_modules/.bin/tsx scripts/verify-client-id-writes.ts              # the working tree
//   ./node_modules/.bin/tsx scripts/verify-client-id-writes.ts --ref=origin/p0/g2   # a committed tree, read via git
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const MODELS = new Set(["address", "deposit", "webhookDelivery"]);
const METHODS = new Set(["create", "createMany", "upsert"]);
const RAW_INSERT = /INSERT\s+INTO\s+"?(addresses|deposits|webhook_deliveries)"?/i;
const ALLOW = /client-id-gate:\s*allow\s+(\S.*)$/m;

export interface Site { file: string; line: number; call: string; verdict: "ok" | "missing" | "unprovable" | "allowed"; why: string }

function propNames(o: ts.ObjectLiteralExpression): { names: Set<string>; spread: boolean } {
  const names = new Set<string>();
  let spread = false;
  for (const p of o.properties) {
    if (ts.isSpreadAssignment(p)) spread = true;
    else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) names.add(p.name.text);
  }
  return { names, spread };
}

function judgeRow(expr: ts.Expression | undefined): { verdict: Site["verdict"]; why: string } {
  if (!expr) return { verdict: "unprovable", why: "no row object" };
  if (ts.isArrayLiteralExpression(expr)) {
    const bad = expr.elements.map((e) => judgeRow(e)).find((j) => j.verdict !== "ok");
    return bad ?? { verdict: "ok", why: "every array element sets clientId" };
  }
  if (!ts.isObjectLiteralExpression(expr)) return { verdict: "unprovable", why: `row is \`${expr.getText().slice(0, 40)}\`, not an object literal` };
  const { names, spread } = propNames(expr);
  if (names.has("clientId") || names.has("client")) return { verdict: "ok", why: "sets clientId" };
  return spread ? { verdict: "unprovable", why: "spread without an explicit clientId" } : { verdict: "missing", why: "no clientId" };
}

export function scanSource(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const sites: Site[] = [];
  const allowed = (line: number) => ALLOW.exec(lines[line] ?? "") ?? ALLOW.exec(lines[line - 1] ?? "");
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && METHODS.has(n.expression.name.text)) {
      const target = n.expression.expression;
      const model = ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
      if (model && MODELS.has(model)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
        const arg = n.arguments[0];
        let row: ts.Expression | undefined;
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const key = n.expression.name.text === "upsert" ? "create" : "data";
          const prop = arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === key);
          row = prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
        }
        const j = arg && !ts.isObjectLiteralExpression(arg) ? { verdict: "unprovable" as const, why: "argument is not an object literal" } : judgeRow(row);
        const a = j.verdict === "ok" ? null : allowed(line);
        sites.push({ file, line: line + 1, call: `${model}.${n.expression.name.text}`, verdict: a ? "allowed" : j.verdict, why: a ? `allowed: ${a[1]}` : j.why });
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) {
      const raw = n.getText();
      const m = RAW_INSERT.exec(raw);
      if (m) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line;
        const ok = /client_id/.test(raw);
        const a = ok ? null : allowed(line);
        sites.push({ file, line: line + 1, call: `raw INSERT ${m[1]}`, verdict: ok ? "ok" : a ? "allowed" : "missing", why: ok ? "names client_id" : a ? `allowed: ${a[1]}` : "raw INSERT without client_id" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

const isFixture = (f: string) => /^scripts\/(verify-[^/]+\.ts|lib\/.+|throwaway-sandbox\.ts)$/.test(f);

function listFiles(ref: string | undefined): Array<{ file: string; text: string }> {
  if (ref) {
    const names = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "src", "scripts"], { encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".ts"));
    return names.map((file) => ({ file, text: execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) }));
  }
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) out.push({ file: p, text: readFileSync(p, "utf8") }); } };
  walk("src"); walk("scripts");
  return out;
}

function main(): number {
  const refArg = process.argv.find((a) => a.startsWith("--ref="));
  const ref = refArg?.slice("--ref=".length);
  if (ref !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) { console.error(`REFUSING: --ref ${JSON.stringify(ref)} is not a plain git ref`); return 2; }
  console.log(`client_id write gate — ${ref ? `git ref ${ref} (${execFileSync("git", ["rev-parse", "--short", ref], { encoding: "utf8" }).trim()})` : "working tree"}`);

  // CONTROL 1: the detector must flag an omission and pass a proper write.
  const probe = [
    scanSource("probe-bad.ts", `await tx.address.create({ data: { keyId, chain, reference } });`),
    scanSource("probe-good.ts", `await tx.deposit.create({ data: { keyId, clientId, chain } });`),
    scanSource("probe-var.ts", `await prisma.webhookDelivery.create({ data: row });`),
    scanSource("probe-raw.ts", "await tx.$executeRawUnsafe(`INSERT INTO \"addresses\" (id, key_id) VALUES ($1, $2)`);"),
  ];
  const detectorOk = probe[0]?.[0]?.verdict === "missing" && probe[1]?.[0]?.verdict === "ok" && probe[2]?.[0]?.verdict === "unprovable" && probe[3]?.[0]?.verdict === "missing";
  console.log(`  ${detectorOk ? "PASS" : "VOID"}  CONTROL: detector flags an omitted clientId, a non-literal row and a raw INSERT, and passes a proper write — ${probe.map((p) => p[0]?.verdict ?? "none").join("/")}`);

  const sites = listFiles(ref).flatMap(({ file, text }) => scanSource(file, text));
  const prod = sites.filter((s) => !isFixture(s.file));
  const fixtures = sites.filter((s) => isFixture(s.file));
  for (const s of prod) console.log(`  ${s.verdict === "ok" ? "PASS" : s.verdict === "allowed" ? "ALLOW" : "FAIL"}  ${s.file}:${s.line} ${s.call} — ${s.why}`);
  const fixBad = fixtures.filter((s) => s.verdict !== "ok" && s.verdict !== "allowed");
  for (const s of fixBad) console.log(`  FIXTURE  ${s.file}:${s.line} ${s.call} — ${s.why} (does not gate; fix before the contract step)`);
  const failed = prod.filter((s) => s.verdict === "missing" || s.verdict === "unprovable");
  console.log(`\nproduction writers: ${prod.length} site(s), ${failed.length} FAIL, ${prod.filter((s) => s.verdict === "allowed").length} ALLOW · fixtures: ${fixtures.length} site(s), ${fixBad.length} without client_id`);
  if (!detectorOk) { console.log("*** VOID — the detector self-test failed; this run proves nothing ***"); return 1; }
  if (prod.length === 0) { console.log("*** VOID — population 0: no production write site found; this run proves nothing ***"); return 1; }
  console.log(failed.length === 0 ? "GREEN — every production create of addresses/deposits/webhook_deliveries sets client_id" : "RED — the contract-pending NOT NULL migration must not be applied yet");
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("verify-client-id-writes.ts")) process.exit(main());
