// THE REFERENCE FORMAT — his three properties as ASSERTIONS, not adjectives.
// Pure; no database, no network. `client:tenant:kind:id`.
import { buildReference, parseReference, isValidReference, tenantPrefix, InvalidReference, MAX_SEGMENT_LENGTH } from "@/reference/index.js";
let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }

// ── READABLE ────────────────────────────────────────────────────────────
const example = buildReference({ client: "samaprime", tenant: "samacard", kind: "user", id: "abc123" });
check(example === "samaprime:samacard:user:abc123", "1. READABLE — his own example round-trips to the string he wrote", example);
const back = parseReference(example);
check(back.client === "samaprime" && back.tenant === "samacard" && back.kind === "user" && back.id === "abc123", "1b. and parses back to the same four parts");

// ── SORTABLE ────────────────────────────────────────────────────────────
const refs = [
  buildReference({ client: "samaprime", tenant: "samacard", kind: "user", id: "b" }),
  buildReference({ client: "dahabi", tenant: "storeb", kind: "user", id: "a" }),
  buildReference({ client: "samaprime", tenant: "alpha", kind: "order", id: "z" }),
  buildReference({ client: "samaprime", tenant: "samacard", kind: "order", id: "a" }),
];
const sorted = [...refs].sort();
check(sorted[0]!.startsWith("dahabi:"), "2. SORTABLE — lexicographic sort groups by CLIENT first", sorted[0]!);
check(sorted[1]!.startsWith("samaprime:alpha") && sorted[2]!.startsWith("samaprime:samacard") && sorted[3]!.startsWith("samaprime:samacard"), "2b. then by TENANT, then by KIND within a tenant", sorted.slice(1).join(" | "));

// ── COLLISION-FREE — THE ONE THAT MUST BE PROVEN ────────────────────────
// The classic delimiter collision: ("a:b","c") vs ("a","b:c") produce the
// same string in any scheme that ALLOWS the delimiter inside a segment.
let refusedLeft = false, refusedRight = false;
try { buildReference({ client: "sama:prime", tenant: "card", kind: "user", id: "x" }); } catch (e) { refusedLeft = e instanceof InvalidReference && e.reason === "illegal_character"; }
try { buildReference({ client: "sama", tenant: "prime:card", kind: "user", id: "x" }); } catch (e) { refusedRight = e instanceof InvalidReference && e.reason === "illegal_character"; }
check(refusedLeft && refusedRight, "3. COLLISION-FREE — both halves of the classic delimiter collision are REFUSED at build time", `left=${refusedLeft} right=${refusedRight}`);
// ⚠️ THE CONTROL THAT MAKES IT A PROOF RATHER THAN TWO EXAMPLES: had the
// delimiter been allowed, these two DISTINCT tuples would be one string.
const wouldCollideA = ["sama:prime", "card", "user", "x"].join(":");
const wouldCollideB = ["sama", "prime:card", "user", "x"].join(":");
check(wouldCollideA === wouldCollideB, "3b. CONTROL — and they WOULD collide if the delimiter were permitted, which is why it is not", wouldCollideA);
// exhaustive over a small alphabet: no two distinct tuples share a string
const alphabet = ["a", "b", "ab"];
const seen = new Map<string, string>(); let collisions = 0, built = 0;
for (const c of alphabet) for (const t of alphabet) for (const k of alphabet) for (const i of alphabet) {
  const s = buildReference({ client: c, tenant: t, kind: k, id: i }); const tuple = JSON.stringify([c, t, k, i]); built++;
  const prev = seen.get(s); if (prev !== undefined && prev !== tuple) collisions++; seen.set(s, tuple);
}
check(built === 81 && collisions === 0 && seen.size === 81, "3c. EXHAUSTIVE — 81 distinct tuples produce 81 distinct strings, 0 collisions", `built=${built} distinct=${seen.size}`);

// ── REFUSALS ────────────────────────────────────────────────────────────
check(!isValidReference("samaprime:samacard:user"), "4. three segments refused", "wrong_segment_count");
check(!isValidReference("samaprime:samacard:user:a:b"), "4b. five segments refused");
check(!isValidReference("samaprime::user:abc"), "4c. an empty segment refused");
check(!isValidReference("samaprime:sama card:user:abc"), "4d. whitespace inside a segment refused");
check(!isValidReference(`samaprime:${"x".repeat(MAX_SEGMENT_LENGTH + 1)}:user:abc`), "4e. an over-long segment refused");
check(isValidReference("samaprime:samacard:user:abc123"), "4f. CONTROL — a well-formed reference is ACCEPTED (the validator is not refusing everything)");

// ── PREFIX AGGREGATION ──────────────────────────────────────────────────
const p = tenantPrefix("samaprime", "sama");
check(p === "samaprime:sama:", "5. tenantPrefix ends with the delimiter", p);
check(!buildReference({ client: "samaprime", tenant: "samacard", kind: "user", id: "x" }).startsWith(p),
  "5b. ⚠️ AND THAT TRAILING DELIMITER IS LOAD-BEARING — `samaprime:sama:` does NOT prefix-match tenant `samacard`, so a reconciliation cannot silently swallow a different tenant");

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail === 0) { console.log("*** VOID — no check executed. NOT a pass. ***"); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
