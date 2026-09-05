// STEP 2, RED-FIRST. Drives the REAL Hono app in-process (app.request — no
// port, no PM2) against the sandbox database.
//
// ⚠️ THE ADMIN KEYS ROUTE IS NOT MOUNTED IN v1 (model correction, 2026-09-04:
// SamaPrime is ONE client with ONE key, minted from the CLI). So the issuing
// checks below exercise the CLI path — issueKey()/revokeKey() — and the AUTH
// checks drive a mounted route (/balance). Nothing here tests handlers that
// no longer have a caller; when SamaPay's own registration site mounts
// admin-keys, it brings its own suite. Refuses any other database.
//
// The RED run is the guard itself: until samapay_sandbox exists this script
// exits 1 with "REFUSING TO RUN", which is the only honest state for it.
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { buildApp } from "@/http/app.js";
import { issueKey, IssueKeyError, revokeKey } from "@/keys/issue.js";
import { computeAuditHash, GENESIS_HASH } from "@/audit/append.js";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const RUN = Date.now();

async function main() {
  const db = await assertSandboxDatabase();
  console.log(`database: ${db}`);
  const app = buildApp();
  const made = { clients: [] as string[], keys: [] as string[] };
  try {
    const platform = await prisma.client.create({ data: { name: `verify-platform-${RUN}`, kind: "platform" } });
    const partner = await prisma.client.create({ data: { name: `verify-partner-${RUN}`, kind: "partner" } });
    made.clients.push(platform.id, partner.id);

    // The admin key is minted by the CLI path only.
    const admin = await issueKey({ clientId: platform.id, name: "admin", scopes: ["keys.issue"], issuedBy: "verify", issuedVia: "cli" });
    made.keys.push(admin.id);
    check(/^sk_live_[a-z2-7]{40}$/.test(admin.plaintext), "1. key shape sk_live_ + 40 base32 chars", admin.plaintext.slice(0, 12) + "…");
    const stored = await prisma.clientKey.findUniqueOrThrow({ where: { id: admin.id }, select: { keyHash: true, keyPrefix: true, keyLast4: true } });
    check(!stored.keyHash.includes(admin.plaintext) && stored.keyHash.startsWith("$argon2"), "2. the plaintext is NOT stored; an argon2 hash is", stored.keyHash.slice(0, 10));
    check(stored.keyPrefix === admin.plaintext.slice(0, 12) && stored.keyLast4 === admin.plaintext.slice(-4), "2b. prefix and last4 match the plaintext", `${stored.keyPrefix} …${stored.keyLast4}`);

    // 3. the CLI path issues a client key for another client; plaintext once
    const client = await issueKey({ clientId: partner.id, name: "store key", scopes: ["balance.read"], environment: "test", issuedBy: "verify", issuedVia: "cli" });
    made.keys.push(client.id);
    check(client.plaintext.startsWith("sk_test_") && client.scopes.join() === "balance.read", "3. the CLI issues a client key for another client, plaintext returned once", `${client.keyPrefix}… scopes=${client.scopes.join()}`);

    // 4. wrong secret with a real prefix, and an unknown prefix, are BOTH 401 with the SAME body (no oracle)
    // ⚠️ A WELL-FORMED key with the RIGHT prefix and the WRONG secret. The
    // first version appended 40 chars to a 12-char slice, producing a 44-char
    // body that failed the FORMAT regex — so it got the "malformed header"
    // message and the test failed for the wrong reason. That is a probe
    // interrogating a sibling of its subject: the oracle under test is
    // "does this key EXIST", not "is your header shaped correctly".
    // DERIVED FROM THE STRING, not from my arithmetic about it: keep the real
    // 12-char prefix and replace every remaining character, so the result has
    // the SAME LENGTH and the SAME PREFIX and a wrong secret. My first two
    // attempts both computed the padding by hand and both produced a
    // wrong-LENGTH key, which the format regex rejected before the lookup —
    // the probe was failing upstream of the thing it tests.
    const wrong = client.plaintext.slice(0, 12) + "z".repeat(client.plaintext.length - 12);
    const r4 = await app.request("/balance", { headers: { authorization: `Bearer ${wrong}` } });
    const r4b = await app.request("/balance", { headers: { authorization: "Bearer sk_live_" + "b".repeat(40) } });
    const t4 = await r4.text(); const t4b = await r4b.text();
    check(r4.status === 401 && r4b.status === 401 && t4 === t4b, "4. wrong secret and unknown prefix both 401 with the SAME body (no oracle)", `${r4.status}/${r4b.status} · wrongSecret=${t4} · unknownPrefix=${t4b}`);

    // 5. a key without the scope is refused 403, with the scope named
    const noScope = await issueKey({ clientId: partner.id, name: "no scope", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli" });
    made.keys.push(noScope.id);
    const r5 = await app.request("/balance", { headers: { authorization: `Bearer ${noScope.plaintext}` } });
    const b5 = (await res5json(r5)) as { error?: { code: string; details?: { scope?: string } } };
    check(r5.status === 403 && b5.error?.code === "insufficient_scope" && b5.error.details?.scope === "balance.read", "5. a key missing the scope is refused 403, scope named", `status=${r5.status} code=${b5.error?.code}`);

    // 6. CONTROL — keys.issue can be minted by the CLI ONLY: the admin path refuses
    let refusedEscalation = false;
    try { await issueKey({ clientId: partner.id, name: "escalate", scopes: ["keys.issue"], issuedBy: "verify", issuedVia: "samaprime_admin_action" }); }
    catch (e) { refusedEscalation = e instanceof IssueKeyError && e.code === "keys_issue_not_via_admin"; }
    check(refusedEscalation, "6. CONTROL — keys.issue is refused unless it comes from the CLI (his hand), so no admin path can mint an admin key");

    // 7. revoke, then the revoked key is 401 on its next request
    const revoked = await revokeKey(client.id, "verify", "revoked by the suite");
    const r7b = await app.request("/balance", { headers: { authorization: `Bearer ${client.plaintext}` } });
    check(revoked === 1 && r7b.status === 401, "7. a revoked key is 401 on its next request", `revoked=${revoked} status=${r7b.status}`);

    const rows = await prisma.auditEvent.findMany({ orderBy: { at: "asc" }, select: { at: true, keyId: true, actor: true, action: true, subjectId: true, idempotencyKey: true, params: true, prevHash: true, hash: true } });
    let prev = GENESIS_HASH, broken = 0;
    for (const r of rows) {
      const h = computeAuditHash(prev, { at: r.at.toISOString(), keyId: r.keyId, actor: r.actor, action: r.action, subjectId: r.subjectId, idempotencyKey: r.idempotencyKey, params: r.params });
      if (r.prevHash !== prev || r.hash !== h) broken++;
      prev = r.hash;
    }
    const ours = rows.filter((r) => made.keys.includes(r.keyId ?? ""));
    check(rows.length >= 3 && broken === 0 && ours.some((r) => r.action === "key.issued") && ours.some((r) => r.action === "key.revoked"), "8. audit chain re-hashed end to end: 0 broken links; key.issued and key.revoked present", `${rows.length} rows, ${broken} broken`);
    // 8b. NEGATIVE CONTROL — the chain check can fail: tamper one field in memory
    const tampered = rows.length ? computeAuditHash(GENESIS_HASH, { ...rows[0]!, at: rows[0]!.at.toISOString(), params: { x: RUN } }) : "";
    check(rows.length > 0 && tampered !== rows[0]!.hash, "8b. CONTROL — a tampered field changes the hash (the check can go red)");
    // 9. the append-only trigger refuses a delete
    let refused = false;
    try { await prisma.auditEvent.deleteMany({ where: { keyId: { in: made.keys } } }); } catch (e) { refused = /append-only|restrict_violation/i.test(String((e as Error).message)); }
    check(refused, "9. audit_events refuses DELETE (append-only trigger from the first migration)");
  } catch (err) {
    // ⚠️ WITHOUT THIS, A CRASH REPORTS AS A CLEAN ZERO. `process.exit()` in
    // the `finally` below runs BEFORE the exception propagates and discards
    // it — the first run of this suite against a real sandbox printed
    // "0 passed, 0 failed" and exited 0 while main() was throwing on its
    // second statement. A suite that cannot fail loudly is the defect this
    // whole repository is about, and it was in the harness rather than the
    // assertions.
    fail++;
    console.error(`\n*** THE SUITE THREW — nothing below this point ran ***\n`, err);
  } finally {
    // audit rows are permanent by design (trigger); keys/clients are not.
    await prisma.clientKey.deleteMany({ where: { id: { in: made.keys } } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => undefined);
    // ⚠️ AN AUDITED ACTOR IS PERMANENTLY UNDELETABLE, AND THAT IS THE DESIGN.
    // audit_events is append-only (trigger) and its key_id FK is Restrict, so
    // any key that ever appeared in an audit row pins itself forever — exactly
    // what SamaPrime records about audit_logs pinning its fixture actors.
    // So the assertion is NOT "zero residue"; it is "every leftover row is
    // leftover FOR THAT REASON". A key with no audit rows that survived
    // deletion is a broken cleanup and still fails.
    const leftKeys = await prisma.clientKey.findMany({ where: { id: { in: made.keys } }, select: { id: true, _count: { select: { audit: true } } } });
    const leftClients = await prisma.client.count({ where: { id: { in: made.clients } } });
    const unexplained = leftKeys.filter((k) => k._count.audit === 0).length;
    console.log(`\n${pass} passed, ${fail} failed · ${leftKeys.length} key(s) + ${leftClients} client(s) left behind — ${unexplained} UNEXPLAINED (audited actors are undeletable by design; unexplained means the cleanup broke)`);
    if (unexplained !== 0) fail++;
    await prisma.$disconnect();
    // ⚠️ ZERO CHECKS IS **VOID**, NEVER A PASS. "0 passed, 0 failed" is the
    // reassuring shape of a suite that never reached its assertions.
    if (pass + fail === 0) { console.log("*** VOID — no check executed. This is NOT a pass. ***"); process.exit(1); }
    process.exit(fail === 0 ? 0 : 1);
  }
}
async function res5json(r: Response) { try { return await r.json(); } catch { return {}; } }
main().catch((e) => { console.error("verify-auth-and-keys crashed:", e); process.exit(1); });
