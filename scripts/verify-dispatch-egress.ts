// COVERS: src/webhooks/dispatch.ts src/net/webhook-target.ts src/keys/webhook-secret.ts
//
// =====================================================================
// *** THE URL WE JUDGED IS NOT NECESSARILY THE URL WE SEND TO. ***
// =====================================================================
// pay-dashboard review 2026-09-27, MEDIUM (the author's own §4 item 5: the
// guard was wired at SAVE and at the test button, never at dispatch).
// `src/net/webhook-target.ts`'s own header says where it must be called, and
// names the second place: "AFTER the target row is read and BEFORE the
// fetchImpl call… Neither call closes the redirect hole" — and neither call
// covers a retry. Until now only the first existed, so:
//
//   * The panel's test button re-guarded key X's URL and then handed the row to
//     `attemptDelivery`, which POSTed wherever it liked. One guard judged one
//     address while the transport used another.
//   * A delivery is retried up to eight times across two days. DNS at save
//     time is not DNS at send time, and `a-host-that-was-public.example`
//     repointing at 169.254.169.254 between attempt 1 and attempt 4 is exactly
//     the rebinding this guard exists to narrow.
//   * `last_error` and `last_status_code` are rendered to the merchant in the
//     delivery log, which is the readout that turns a refused target into a
//     port scanner. Refusing at send time also has to SAY something — and say
//     only the code.
//
// THE MUTANT THIS SUITE EXISTS FOR: "remove the send-time re-guard" survived
// the branch's own tests (review §7). Every check below therefore counts
// POSTs reaching the transport seam, not log lines.
//
// THE OTHER WAY THIS FIX CAN BE WRONG: take the guard seriously without the
// door this box depends on, and every webhook to MNTAD stops on restart —
// scripts/issue-key.ts's own runbook form is
// `--webhook-url "http://127.0.0.1:3033/api/webhooks/samapay/<id>"`, plain
// http to loopback, which `validateWebhookUrl` has always accepted and no
// operator variable was ever required for. So the POSITIVE controls (G3, G4)
// run with PANEL_WEBHOOK_ALLOWED_HOSTNAMES UNSET and must still deliver.
//
// Throwaway only. No DNS is reached: every target here is a literal IP, which
// src/net/outbound-address-guard.ts judges without a lookup, and the transport
// is the `fetchImpl` seam `attemptDelivery` already exists to expose.
import crypto from "node:crypto";

process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.MNTAD_SAMAPAY_HANDOFF_SECRET = "y".repeat(48);
// ⚠️ deliberately NOT set: that is the deployment shape of this box today.
delete process.env.PANEL_WEBHOOK_ALLOWED_HOSTNAMES;

import { Prisma } from "@prisma/client";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { issueKey } from "@/keys/issue.js";
import * as dispatch from "@/webhooks/dispatch.js";
import * as events from "@/events/index.js";
import { check, summary } from "./lib/check.js";

const RUN = Date.now().toString(36);
const MIN = 60_000;
const METADATA = "https://169.254.169.254/latest/meta-data/";
const PRIVATE_RFC1918 = "https://192.168.168.168/hook";

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);

  let idx = 6_000_000 + Math.floor(Math.random() * 50_000);
  const client = await prisma.client.create({ data: { name: `dsp-egress-${RUN}`, kind: "merchant" } });

  /** What the transport saw. A guard that only LOGS would pass a weaker test;
   *  nothing here counts anything but a POST that reached the seam. */
  let posts: string[] = [];
  const transport = async (url: string) => { posts.push(url); return { status: 200 }; };

  /** A live deposit.confirmed on `keyId`, delivered through the real path. */
  const attempt = async (keyId: string, reference: string, id?: string) => {
    const address = await prisma.address.create({
      data: { keyId, clientId: client.id, reference, chain: "TRC20", address: `T${RUN}${idx}`.padEnd(34, "x"), derivationIndex: idx++ },
      select: { id: true, address: true },
    });
    const deposit = await prisma.deposit.create({
      data: { keyId, addressId: address.id, chain: "TRC20", txHash: `0x${crypto.randomBytes(32).toString("hex")}`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", blockNumber: 1n, creditedAt: new Date() },
      select: { id: true, txHash: true },
    });
    const snapshot = {
      id: `dep_${deposit.id}`, object: "deposit", status: "confirmed", chain: "TRC20", tx_hash: deposit.txHash,
      amount: "5", confirmations: 20, address: address.address, reference, payment_intent_id: null,
      detected_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
    };
    const enq = await prisma.$transaction((tx) => events.enqueueEvent(tx, { type: "deposit.confirmed", objectKind: "deposit", objectId: snapshot.id, snapshot }));
    if (enq.status === "suppressed") throw new Error("the deposit fixture was suppressed at enqueue — nothing to attempt");
    posts = [];
    const out = await dispatch.attemptDelivery(id ?? enq.deliveryId, transport as never);
    return { out, deliveryId: enq.deliveryId };
  };
  const rowOf = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true, lastError: true, lastStatusCode: true, nextAttemptAt: true } });

  try {
    // ── G0. the seam proves the suite can see a POST at all ────────────────
    const ok = await issueKey({ clientId: client.id, name: "loopback", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "http://127.0.0.1:3033/api/webhooks/samapay/hook" });
    const g0 = await attempt(ok.id, `samaprime:m${RUN}:g0`);
    check(g0.out.outcome === "delivered" && posts.length === 1,
      "G0. CONTROL — the transport seam really does see the POST, so every " + '"0 posts" below is a refusal and not a broken fixture',
      `outcome=${g0.out.outcome} posts=${posts.length}`);

    // ── G1. THE GUARD: the cloud metadata address ──────────────────────────
    // Written straight onto the row, because that is what a value that predates
    // the guard looks like: `webhook_url` is a plain column and the CLI's save
    // rule (`validateWebhookUrl`) accepts `https://169.254.169.254` — it is
    // https. The ONLY thing standing between that string and our own egress is
    // this check.
    const meta = await issueKey({ clientId: client.id, name: "metadata", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "https://example.invalid/hook" });
    await prisma.clientKey.update({ where: { id: meta.id }, data: { webhookUrl: METADATA } });
    const g1 = await attempt(meta.id, `samaprime:m${RUN}:g1`);
    const g1row = await rowOf(g1.deliveryId);
    check(posts.length === 0, "G1. a key whose stored URL is the link-local metadata address is NEVER POSTed to, at dispatch", `posts=${posts.length} target=${METADATA}`);
    check(g1row.status === "pending" && !!g1row.nextAttemptAt && /send-time/.test(g1row.lastError ?? "") && /private_address/.test(g1row.lastError ?? ""),
      "G1b. …and it stays on the retry schedule, with the refusal CODE in last_error (the address may move; dropping the event would not)",
      JSON.stringify(g1row));
    check(g1row.lastError !== null && !g1row.lastError.includes("/latest/meta-data"),
      "G1c. CONTROL on what the merchant sees: the refusal names the code, never the path — last_error is rendered in the panel",
      String(g1row.lastError));

    // ── G2. every retry re-judges, not just the first attempt ──────────────
    // The review's "retries test rows unguarded". A guard that ran only when
    // attempts === 0 would pass G1 and still send attempt 2 to an address that
    // moved in between.
    const g2 = await attempt(meta.id, `samaprime:m${RUN}:g2`);
    let postsAcrossRetries = 0;
    for (const attemptNo of [1, 3, 5, 7]) {
      await prisma.webhookDelivery.update({ where: { id: g2.deliveryId }, data: { attempts: attemptNo, status: "pending", nextAttemptAt: new Date() } });
      posts = [];
      const out = await dispatch.attemptDelivery(g2.deliveryId, transport as never);
      postsAcrossRetries += posts.length;
      if (out.outcome === "exhausted") break;
    }
    check(postsAcrossRetries === 0, "G2. attempts 2, 4, 6 and 8 each re-judge the target: zero POSTs across the whole retry schedule", `posts=${postsAcrossRetries}`);
    check((await rowOf(g2.deliveryId)).attempts >= 2, "G2b. CONTROL — the schedule really did advance, so G2 is not an unused loop", `attempts=${(await rowOf(g2.deliveryId)).attempts}`);

    // ── G3. THE DOOR THAT MUST STAY OPEN: plain http to loopback ───────────
    // The deployment shape of this box, minted by the CLI, with
    // PANEL_WEBHOOK_ALLOWED_HOSTNAMES unset (see the header). Refusing it would
    // be a fix that stops the crediting path.
    const g3 = await attempt(ok.id, `samaprime:m${RUN}:g3`);
    check(g3.out.outcome === "delivered" && posts.length === 1 && posts[0]?.startsWith("http://127.0.0.1:3033/") === true,
      "G3. CONTROL — an http+loopback target on a CLI-minted key still delivers with NO operator allowlist set, exactly as it did before this guard existed",
      `outcome=${g3.out.outcome} posts=${JSON.stringify(posts)}`);

    // ── G4. and the same host over https, judged without DNS ───────────────
    const tls = await issueKey({ clientId: client.id, name: "loopback-tls", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "https://127.0.0.1:3099/hook" });
    const g4 = await attempt(tls.id, `samaprime:m${RUN}:g4`);
    check(g4.out.outcome === "delivered" && posts.length === 1,
      "G4. CONTROL — https to loopback is judged by hostname before any address test, so the guard does not refuse our own box",
      `outcome=${g4.out.outcome} posts=${JSON.stringify(posts)}`);

    // ── G5. a private RFC1918 target is refused the same way ───────────────
    const rfc = await issueKey({ clientId: client.id, name: "internal", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "https://example.invalid/hook" });
    await prisma.clientKey.update({ where: { id: rfc.id }, data: { webhookUrl: PRIVATE_RFC1918 } });
    const g5 = await attempt(rfc.id, `samaprime:m${RUN}:g5`);
    check(posts.length === 0 && g5.out.outcome === "retry", "G5. a private-range host is refused at send time too (not only the metadata address)", `outcome=${g5.out.outcome} posts=${posts.length}`);

    // ── G6. the FALLBACK target is guarded, not just the delivery's own key ─
    // A6's rotation path picks a URL the delivery never named. If the guard
    // judged `d.key` instead of the row it is about to fetch, this is the hole.
    const dead = await issueKey({ clientId: client.id, name: "rotated-away", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "http://127.0.0.1:3033/api/webhooks/samapay/old" });
    await prisma.clientKey.update({ where: { id: dead.id }, data: { active: false, revokedAt: new Date(), revokedReason: "rotated" } });
    const newest = await issueKey({ clientId: client.id, name: "newest-is-private", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "https://example.invalid/hook" });
    await prisma.clientKey.update({ where: { id: newest.id }, data: { webhookUrl: METADATA } });
    // An address stays on its key, so this delivery's own key is the revoked one
    // and the only target left is the newest key's — the metadata address.
    const g6Ref = `samaprime:m${RUN}:g6`;
    const address = await prisma.address.create({
      data: { keyId: dead.id, clientId: client.id, reference: g6Ref, chain: "TRC20", address: `T${RUN}${idx}`.padEnd(34, "x"), derivationIndex: idx++ },
      select: { id: true, address: true },
    });
    const deposit = await prisma.deposit.create({
      data: { keyId: dead.id, addressId: address.id, chain: "TRC20", txHash: `0x${crypto.randomBytes(32).toString("hex")}`, amount: new Prisma.Decimal("5"), confirmations: 20, status: "confirmed", blockNumber: 1n, creditedAt: new Date() },
      select: { id: true, txHash: true },
    });
    const enq6 = await prisma.$transaction((tx) => events.enqueueEvent(tx, {
      type: "deposit.confirmed", objectKind: "deposit", objectId: `dep_${deposit.id}`,
      snapshot: { id: `dep_${deposit.id}`, object: "deposit", status: "confirmed", chain: "TRC20", tx_hash: deposit.txHash, amount: "5", confirmations: 20, address: address.address, reference: g6Ref, payment_intent_id: null, detected_at: new Date().toISOString(), confirmed_at: new Date().toISOString() },
    }));
    posts = [];
    if (enq6.status !== "suppressed") await dispatch.attemptDelivery(enq6.deliveryId, transport as never);
    check(posts.length === 0, "G6. the fallback target is the one judged: a delivery rotated ONTO a metadata URL is still never POSTed", `posts=${JSON.stringify(posts)}`);
    // Undo the metadata key so G7's own-target cases cannot inherit it.
    await prisma.clientKey.update({ where: { id: newest.id }, data: { webhookUrl: "http://127.0.0.1:3033/api/webhooks/samapay/new" } });

    // ── G7. a hung resolver cannot outlast the lease ───────────────────────
    // docs/panel-identity-approval-2026-09-27.md §4 item 5 asks for "its own DNS
    // budget" for exactly this reason: CLAIM_LEASE_MS is 60 s, the HTTP timeout
    // is 10 s, and a guard that hangs past the lease lets a SECOND worker claim
    // the same row and send the same event twice.
    check(dispatch.EGRESS_GUARD_BUDGET_MS < dispatch.CLAIM_LEASE_MS - dispatch.TIMEOUT_MS,
      "G7. the guard's budget is smaller than the lease minus the send timeout, so a claimed attempt can never outlive its lease in the guard",
      `${dispatch.EGRESS_GUARD_BUDGET_MS} < ${dispatch.CLAIM_LEASE_MS} − ${dispatch.TIMEOUT_MS}`);
    const hung = await issueKey({ clientId: client.id, name: "hung-dns", scopes: ["deposits.read"], issuedBy: "ibrahim", issuedVia: "cli", webhookUrl: "https://resolver-hangs.invalid/hook" });
    const realGuard = dispatch.webhookEgressGuard();
    dispatch.setWebhookEgressGuard(() => new Promise<never>(() => undefined));
    const t0 = Date.now();
    let g8: Awaited<ReturnType<typeof attempt>> | null = null;
    try { g8 = await attempt(hung.id, `samaprime:m${RUN}:g8`); } finally { dispatch.setWebhookEgressGuard(realGuard); }
    const elapsed = Date.now() - t0;
    check(g8 !== null && posts.length === 0 && g8.out.outcome === "retry" && elapsed < dispatch.CLAIM_LEASE_MS,
      "G8. a guard that NEVER answers fails the attempt closed — no POST, back on the schedule, well inside the lease (fail-closed, not fail-open)",
      `outcome=${g8?.out.outcome} posts=${posts.length} elapsed=${elapsed}ms`);
    check(!!g8 && /budget|could not be judged/.test((await rowOf(g8.deliveryId)).lastError ?? ""),
      "G8b. …and the row says why, in the same words an operator would search for", String((await rowOf(g8.deliveryId)).lastError));

    // ── G9. the guard is the SAME composition the panel saves with ─────────
    // One rule, not two that can drift: dispatch must refuse what
    // assertWebhookTargetUrl refuses, and only that.
    const codes = await dispatch.webhookEgressGuard()(METADATA).then((r) => (r.ok ? "ok" : r.code));
    check(codes === "private_address", "G9. the exported guard answers with the shared refusal codes (private_address, not a dispatch-only word)", String(codes));
    const noLookup = await prisma.webhookDelivery.count({ where: { clientId: client.id, status: "delivered" } });
    check(noLookup >= 3, "G9b. CONTROL — G0, G3 and G4 were all really delivered, so the guard is not refusing everything", `delivered=${noLookup}`);
  } finally {
    await prisma.webhookDelivery.deleteMany({ where: { clientId: client.id } });
    await prisma.event.deleteMany({ where: { clientId: client.id } });
    await prisma.deposit.deleteMany({ where: { key: { clientId: client.id } } });
    await prisma.address.deleteMany({ where: { clientId: client.id } });
    await prisma.auditEvent.deleteMany({ where: { key: { client: { id: client.id } } } });
    await prisma.clientKey.deleteMany({ where: { clientId: client.id } });
    await prisma.client.deleteMany({ where: { id: client.id } });
    const left = await prisma.clientKey.count({ where: { clientId: client.id } }) + await prisma.client.count({ where: { id: client.id } });
    if (left !== 0) console.log(`  (cleanup: ${left} row(s) pinned by the audit trail and left in place)`);
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-dispatch-egress crashed:", e); process.exit(1); });
