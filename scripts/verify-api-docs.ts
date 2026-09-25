// COVERS: docs/API.md src/http/app.ts src/http/routes/payment-intents.ts src/http/routes/deposits.ts src/http/routes/events.ts src/http/routes/addresses.ts src/http/routes/balance.ts src/http/routes/health.ts src/http/errors.ts src/http/scopes.ts src/http/auth.ts src/http/idempotency.ts src/render/deposit.ts src/intents/render.ts src/intents/create.ts src/events/envelope.ts src/webhooks/sign.ts src/webhooks/dispatch.ts src/chain/impl/config.ts prisma/schema.prisma
//
// docs/API.md CANNOT DRIFT FROM THE CODE. Every route, status, error code (with
// its HTTP status), scope, event type, header, JSON example's field set and
// numeric constant the doc states is compared with src/ — in BOTH directions
// where the doc claims completeness (every /v1 route, every public error code,
// every status, every event type). Values are READ from the code (imports or
// the source text), never copied into this file.
//
// No database: this reads files and calls pure renderers, so there is nothing
// for the sandbox guard to protect. Run: ./node_modules/.bin/tsx scripts/verify-api-docs.ts
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { renderDeposit } from "@/render/deposit.js";
import { renderPaymentIntent } from "@/intents/render.js";
import { EXPIRES_DEFAULT_SEC, EXPIRES_MAX_SEC, EXPIRES_MIN_SEC } from "@/intents/create.js";
import { API_VERSION, EVENT_TYPES, buildEnvelope } from "@/events/envelope.js";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, TOLERANCE_SECONDS } from "@/webhooks/sign.js";
import { MAX_ATTEMPTS, RETRY_SCHEDULE_MS, TIMEOUT_MS } from "@/webhooks/dispatch.js";
import { MAINNET_CONFIRMATION_FLOOR } from "@/chain/impl/config.js";
import { FAILED_VERIFY_BURST } from "@/http/auth.js";
import { IDEMPOTENCY_TTL_MS } from "@/http/idempotency.js";
import { SCOPES } from "@/http/scopes.js";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const read = (p: string) => readFileSync(p, "utf8");
const DOC = read(process.env.API_DOC_PATH ?? "docs/API.md");
const missing = (want: Iterable<string>, have: Set<string>) => [...want].filter((w) => !have.has(w));
const ticked = (s: string) => `\`${s}\``;

// ── 1. ROUTES: every documented `METHOD /v1/…` exists, and every mounted /v1 route is documented ──
const app = read("src/http/app.ts");
const importFile = new Map<string, string>(); // exported router name → route file
for (const m of app.matchAll(/import \{ ([A-Za-z]+) \} from "\.\/routes\/([a-z-]+)\.js";/g)) importFile.set(m[1] as string, `src/http/routes/${m[2]}.ts`);
const actual = new Set<string>();
for (const m of app.matchAll(/v1\.route\("(\/[a-z-]+)", ([A-Za-z]+)\);/g)) {
  const [mount, name] = [m[1] as string, m[2] as string];
  const file = importFile.get(name);
  if (!file) continue;
  for (const r of read(file).matchAll(new RegExp(`\\b${name}\\.(get|post)\\("([^"]*)"`, "g"))) {
    const sub = r[2] as string;
    actual.add(`${(r[1] as string).toUpperCase()} /v1${mount}${sub === "/" ? "" : sub}`);
  }
}
const documented = new Set([...DOC.matchAll(/`(GET|POST) (\/v1\/[^`\s?]+)`/g)].map((m) => `${m[1]} ${m[2]}`));
check(actual.size >= 8, "routes: the /v1 surface was read from src/http/app.ts + the route files", [...actual].sort().join(" · "));
check(missing(documented, actual).length === 0, "routes: every documented route exists in src", missing(documented, actual).join(", "));
check(missing(actual, documented).length === 0, "routes: every mounted /v1 route is documented", missing(actual, documented).join(", "));

// ── 2. ERRORS: every row's code exists with THAT HTTP status; every public code has a row ──
const errorsSrc = read("src/http/errors.ts");
const statusBlock = errorsSrc.slice(errorsSrc.indexOf("const STATUS"), errorsSrc.indexOf("};", errorsSrc.indexOf("const STATUS")));
const srcStatus = new Map([...statusBlock.matchAll(/([a-z_]+): (\d{3})/g)].map((m) => [m[1] as string, Number(m[2])]));
const wire = new Map([...errorsSrc.matchAll(/([a-z_]+): "([a-z_]+)"/g)].map((m) => [m[1] as string, m[2] as string]));
// Not public: a legacy spelling that goes out as its wire code, and a withdrawal-only code (no withdrawal route in Phase 0).
const INTERNAL = new Set([...wire.keys(), "allowance_exceeded"]);
const rows = [...DOC.matchAll(/^\| (\d{3}) \| `([a-z_]+)` \|/gm)].map((m) => ({ http: Number(m[1]), code: m[2] as string }));
check(srcStatus.size >= 15 && rows.length >= 15, "errors: codes read from src/http/errors.ts and from the doc's table", `src ${srcStatus.size}, doc ${rows.length}`);
const wrong = rows.filter((r) => srcStatus.get(r.code) !== r.http || INTERNAL.has(r.code));
check(wrong.length === 0, "errors: every documented code exists in src with the documented HTTP status", wrong.map((r) => `${r.code}:${r.http}≠${srcStatus.get(r.code)}`).join(", "));
const publicCodes = [...srcStatus.keys()].filter((c) => !INTERNAL.has(c));
check(missing(publicCodes, new Set(rows.map((r) => r.code))).length === 0, "errors: every public code in src has a row in the doc", missing(publicCodes, new Set(rows.map((r) => r.code))).join(", "));

// ── 3. STATUSES: the schema's enums, both ways ──
const schema = read("prisma/schema.prisma");
const enumValues = (name: string) => (schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))?.[1] ?? "").split("\n").map((l) => l.replace(/\/\/.*/, "").trim()).filter(Boolean);
const intentStatuses = enumValues("PaymentIntentStatus"), depositStatuses = enumValues("DepositStatus");
check(intentStatuses.length === 6 && depositStatuses.length >= 2, "statuses: read from prisma/schema.prisma", `${intentStatuses.join(",")} | ${depositStatuses.join(",")}`);
// The PaymentIntent status table only: from "Statuses:" to the next blank-line paragraph.
const statusSection = DOC.slice(DOC.indexOf("Statuses:"), DOC.indexOf("- **On time"));
const statusRows = new Set([...statusSection.matchAll(/^\| `([a-z_]+)` \| /gm)].map((m) => m[1] as string));
check(missing(intentStatuses, statusRows).length === 0 && missing(statusRows, new Set(intentStatuses)).length === 0, "statuses: the PaymentIntent status table equals the enum", `table ${[...statusRows].join(",")}`);
check(depositStatuses.every((s) => DOC.includes(ticked(s))), "statuses: every Deposit status is documented", missing(depositStatuses, new Set(depositStatuses.filter((s) => DOC.includes(ticked(s))))).join(","));

// ── 4. SCOPES: every documented scope exists; every scope a route requires is documented ──
const scopeRows = [...DOC.matchAll(/^\| `([a-z_.]+)` \| /gm)].map((m) => m[1] as string).filter((s) => s.includes("."));
const routeScopes = new Set<string>();
for (const f of importFile.values()) for (const m of read(f).matchAll(/(?:scope|requireScope\(key), ?"([a-z_.]+)"\)|scope\("([a-z_.]+)"\)/g)) routeScopes.add((m[1] ?? m[2]) as string);
check(scopeRows.length > 0 && scopeRows.every((s) => (SCOPES as readonly string[]).includes(s)), "scopes: every documented scope is in src/http/scopes.ts", scopeRows.join(","));
check(missing(routeScopes, new Set(scopeRows)).length === 0, "scopes: every scope a mounted route requires is documented", `routes need ${[...routeScopes].join(",")}; missing ${missing(routeScopes, new Set(scopeRows)).join(",")}`);

// ── 5. EVENTS + HEADERS ──
check(EVENT_TYPES.every((t) => DOC.includes(ticked(t))), "events: every event type in src/events/envelope.ts is documented", EVENT_TYPES.join(","));
check(DOC.includes(`"api_version": "${API_VERSION}"`), "events: the example carries the current API_VERSION", API_VERSION);
check([SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_HEADER].every((h) => DOC.includes(ticked(h))), "webhooks: the three header names are the ones src/webhooks/sign.ts sends");

// ── 6. JSON EXAMPLES: exactly the field set the renderers produce ──
const jsonBlocks = [...DOC.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] as string);
const exampleOf = (object: string) => { for (const b of jsonBlocks) { try { const j = JSON.parse(b.replace(/…/g, "")) as Record<string, unknown>; if (j.object === object) return j; } catch { /* the error example has a placeholder */ } } return null; };
const sameKeys = (a: object | null, b: object) => !!a && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort());
const D = new Prisma.Decimal(1), now = new Date();
const dep = renderDeposit({ id: "x", chain: "TRC20", txHash: "t", amount: D, confirmations: 1, status: "confirmed", detectedAt: now, creditedAt: now, address: { reference: "r", address: "a", intent: null } });
const pi = renderPaymentIntent({ id: "pi_x", clientId: "c", keyId: "k", chain: "TRC20", amount: D, reference: "r", status: "requires_payment", expiresAt: now, succeededAt: null, expiredAt: null, createdAt: now, address: { address: "a", deposits: [] } } as unknown as Parameters<typeof renderPaymentIntent>[0], 19);
const evt = buildEnvelope("evt_x", "deposit.confirmed", now, {});
const addrSrc = read("src/http/routes/addresses.ts").match(/return \{ (object: "address"[^}]*)\}/)?.[1] ?? "";
const addrKeys = Object.fromEntries(addrSrc.split(",").map((p) => [p.split(":")[0]?.trim(), 1]).filter(([k]) => k));
const balSrc = read("src/http/routes/balance.ts").match(/return \{ (object: "balance"[^}]*)\}/)?.[1] ?? "";
const balKeys = Object.fromEntries(balSrc.split(",").map((p) => [p.split(":")[0]?.trim(), 1]).filter(([k]) => k));
check(sameKeys(exampleOf("payment_intent"), pi), "objects: the PaymentIntent example has exactly renderPaymentIntent's fields", Object.keys(pi).join(","));
check(sameKeys(exampleOf("deposit"), dep), "objects: the Deposit example has exactly renderDeposit's fields", Object.keys(dep).join(","));
check(sameKeys(exampleOf("event"), evt), "objects: the Event example has exactly buildEnvelope's fields", Object.keys(evt).join(","));
check(Object.keys(addrKeys).length === 4 && sameKeys(exampleOf("address"), addrKeys), "objects: the Address example has exactly the route's fields", Object.keys(addrKeys).join(","));
check(Object.keys(balKeys).length >= 4 && sameKeys(exampleOf("balance"), balKeys), "objects: the Balance example has exactly balanceBody's fields", Object.keys(balKeys).join(","));

// ── 7. CONSTANTS ──
const human = (ms: number) => (ms >= 3_600_000 ? `${ms / 3_600_000} h` : `${ms / 60_000} m`);
const schedule = RETRY_SCHEDULE_MS.map(human);
const scheduleText = `${schedule.slice(0, -1).join(", ")} and ${schedule.at(-1)}`;
const rpsDefault = schema.match(/rpsLimit\s+Int\s+@default\((\d+)\)/)?.[1];
const idemMax = read("src/http/idempotency.ts").match(/\{1,(\d+)\}/)?.[1];
const constants: Array<[string, string]> = [
  [`retry schedule "${scheduleText}"`, scheduleText],
  [`${MAX_ATTEMPTS} attempts`, `${MAX_ATTEMPTS} attempts in total`],
  [`timeout ${TIMEOUT_MS / 1000} s`, `within **${TIMEOUT_MS / 1000} seconds**`],
  [`signature tolerance ${TOLERANCE_SECONDS} s`, `> ${TOLERANCE_SECONDS} s`],
  [`idempotency TTL ${IDEMPOTENCY_TTL_MS / 3_600_000} h`, `**${IDEMPOTENCY_TTL_MS / 3_600_000} hours**`],
  [`Idempotency-Key 1–${idemMax}`, `1–${idemMax} printable ASCII`],
  [`rps default ${rpsDefault}`, `default **${rpsDefault} requests/s**`],
  [`brake after ${FAILED_VERIFY_BURST} failures`, `after ${FAILED_VERIFY_BURST} failures`],
  [`expires_in_sec ${EXPIRES_MIN_SEC}…${EXPIRES_MAX_SEC}, default ${EXPIRES_DEFAULT_SEC}`, `${EXPIRES_MIN_SEC} … ${EXPIRES_MAX_SEC}. Default ${EXPIRES_DEFAULT_SEC}.`],
  ...Object.entries(MAINNET_CONFIRMATION_FLOOR).map(([c, n]) => [`${c} confirmations ${n}`, `| ${c} | ${n} |`] as [string, string]),
];
for (const [label, text] of constants) check(DOC.includes(text), `constants: ${label} (from src) is what the doc says`, DOC.includes(text) ? "" : `doc lacks: ${text}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail === 0) { console.log("*** VOID — no check executed. This is NOT a pass. ***"); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
