// The verify harness, shared. Same contract as SamaPrime's: a check is
// PASS or FAIL; a check whose subject can be ABSENT is VOID, counted
// separately and reported in the headline — "0 failed" alone is satisfied
// by the subject never existing.
let passed = 0;
let failed = 0;
let voided = 0;

export function check(ok: boolean, label: string, detail = ""): void {
  if (ok) { passed += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failed += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

export function voidCheck(label: string, why: string): void {
  voided += 1;
  console.log(`  VOID  ${label} — ${why}`);
}

/** An emptiness claim must carry its population; population 0 is VOID, never PASS. */
export function checkOver(population: number, ok: boolean, label: string, detail = ""): void {
  if (population === 0) { voidCheck(label, "population 0 — this asserted nothing"); return; }
  check(ok, label, `${detail}${detail ? ", " : ""}over ${population} row(s)`);
}

/** Prints the headline and returns the exit code. VOID makes the run inconclusive (non-zero). */
export function summary(): number {
  console.log(`\n${passed} passed / ${failed} failed / ${voided} VOID${voided ? "   *** INCONCLUSIVE ***" : ""}`);
  return failed === 0 && voided === 0 ? 0 : 1;
}

/** Runs fn and returns what it threw (constructor name + the error), or "NO THROW". Every refusal names its class. */
export async function thrown(fn: () => Promise<unknown>): Promise<{ name: string; err?: unknown }> {
  try { await fn(); return { name: "NO THROW" }; }
  catch (e) { return { name: (e as { constructor?: { name?: string } })?.constructor?.name ?? String(e), err: e }; }
}
