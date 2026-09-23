// COVERS: src/keys/webhook-secret.ts src/keys/issue.ts src/webhooks/dispatch.ts src/webhooks/sign.ts
//
// S2 slice 1, step 1 — RED-FIRST. The webhook secret is generated at issue
// time, returned ONCE, stored ONLY as AEAD ciphertext, and the dispatcher
// signs with the DECRYPTED secret so the receiver's verifySignature (the one
// MNTAD copies from src/webhooks/sign.ts) accepts it.
//
// THE DEFECT THIS PINS (S2-MAP §1 defect 2): dispatch.ts signed with the raw
// `webhook_secret` column. With the column holding ciphertext, a receiver
// holding the real secret rejects every delivery. Check 5 is that defect,
// observed through the receiver, not through the code.
//
// Throwaway test key material only: SEED_ENCRYPTION_KEY is generated in this
// process; no real key, seed or .env is read.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { issueKey } from "@/keys/issue.js";
import { decryptWebhookSecret, encryptWebhookSecret, generateWebhookSecret, WebhookSecretUnreadable } from "@/keys/webhook-secret.js";
import { attemptDelivery, enqueue, type FetchLike } from "@/webhooks/dispatch.js";
import { SIGNATURE_HEADER, verifySignature } from "@/webhooks/sign.js";
import { check, summary, thrown } from "./lib/check.js";

const RUN = Date.now().toString(36);

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const client = await prisma.client.create({ data: { name: `verify-whsec-${RUN}`, kind: "partner" }, select: { id: true } });
  const made: string[] = [];
  const deliveries: string[] = [];
  try {
    // 1-3. issue with a webhook URL: plaintext once, ciphertext at rest
    const issued = await issueKey({ clientId: client.id, name: "store", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli", webhookUrl: "https://store.example/api/webhooks/samapay/cred1" });
    made.push(issued.id);
    const plain = issued.webhookSecret ?? "";
    check(/^whsec_[A-Za-z0-9_-]{43}$/.test(plain), "1. issuing with a webhook URL returns the plaintext secret once (whsec_ + 43 base64url)", plain ? `${plain.slice(0, 9)}…` : "NO SECRET RETURNED");
    const row = await prisma.clientKey.findUniqueOrThrow({ where: { id: issued.id }, select: { webhookUrl: true, webhookSecret: true } });
    const stored = row.webhookSecret ?? "";
    check(stored.startsWith("v1:") && plain !== "" && !stored.includes(plain) && !stored.includes(plain.slice(6)), "2. the column holds v1 AEAD ciphertext and does not contain the plaintext", stored ? `${stored.slice(0, 12)}… (${stored.length} chars)` : "COLUMN EMPTY");
    let roundTrip = "";
    try { roundTrip = decryptWebhookSecret(stored); } catch (e) { roundTrip = `THREW ${(e as Error).name}`; }
    check(plain !== "" && roundTrip === plain, "3. the stored ciphertext decrypts to exactly the returned plaintext", roundTrip === plain ? "equal" : roundTrip.slice(0, 40));
    check(row.webhookUrl === "https://store.example/api/webhooks/samapay/cred1", "3b. the webhook URL is stored as given");

    // 4-5. THE DEFECT — plant a known secret as ciphertext, deliver, verify as the RECEIVER would
    const known = generateWebhookSecret();
    await prisma.clientKey.update({ where: { id: issued.id }, data: { webhookSecret: encryptWebhookSecret(known) } });
    const eventId = `evt_verify_${RUN}`;
    const deliveryId = await enqueue(issued.id, "deposit.confirmed", eventId, { reference: "x", amount: "1" });
    deliveries.push(deliveryId);
    const captured: { header?: string | undefined; body?: string; url?: string } = {};
    const fakeFetch: FetchLike = async (url, init) => { captured.url = url; captured.header = init.headers[SIGNATURE_HEADER]; captured.body = init.body; return { status: 200 }; };
    const out = await attemptDelivery(deliveryId, fakeFetch);
    check(out.outcome === "delivered" && captured.body !== undefined, "4. the delivery was attempted and marked delivered on 2xx", `outcome=${out.outcome}`);
    check(verifySignature(known, captured.body ?? "", captured.header), "5. THE RECEIVER VERIFIES: signature made with the DECRYPTED secret (was: signed with the raw column)", `header=${(captured.header ?? "none").slice(0, 24)}…`);
    const storedNow = (await prisma.clientKey.findUniqueOrThrow({ where: { id: issued.id }, select: { webhookSecret: true } })).webhookSecret ?? "";
    check(!verifySignature(storedNow, captured.body ?? "", captured.header), "5b. CONTROL — the same signature does NOT verify under the column's ciphertext (the check can tell the two apart)");
    const body = JSON.parse(captured.body ?? "{}") as { id?: string; type?: string };
    check(body.id === eventId && body.type === "deposit.confirmed", "5c. the body is the enqueued event (id, type)", JSON.stringify(body).slice(0, 80));

    // 6. a column that is NOT v1 ciphertext (a legacy raw value) is refused — no fallback to raw signing
    await prisma.clientKey.update({ where: { id: issued.id }, data: { webhookSecret: "whsec_legacy_raw_value_never_encrypted" } });
    const d2 = await enqueue(issued.id, "deposit.confirmed", `evt_verify_raw_${RUN}`, { reference: "y" });
    deliveries.push(d2);
    let called = 0;
    const out2 = await attemptDelivery(d2, async () => { called++; return { status: 200 }; });
    const d2row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d2 }, select: { status: true, lastError: true } });
    check(out2.outcome === "exhausted" && called === 0 && /unreadable/.test(d2row.lastError ?? ""), "6. a raw (non-ciphertext) column is REFUSED: nothing sent, delivery exhausted with the reason", `outcome=${out2.outcome} fetchCalls=${called} lastError=${d2row.lastError}`);

    // 7. a different SEED_ENCRYPTION_KEY cannot read it (AEAD authenticates)
    const blob = encryptWebhookSecret(known);
    const saved = process.env.SEED_ENCRYPTION_KEY;
    process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    const wrongKey = await thrown(async () => decryptWebhookSecret(blob));
    process.env.SEED_ENCRYPTION_KEY = saved;
    check(wrongKey.name === "WebhookSecretUnreadable", "7. a different SEED_ENCRYPTION_KEY cannot decrypt it (AEAD authentication)", wrongKey.name);
    const tampered = blob.slice(0, -4) + (blob.endsWith("AAAA") ? "BBBB" : "AAAA");
    const t = await thrown(async () => decryptWebhookSecret(tampered));
    check(t.err instanceof WebhookSecretUnreadable, "7b. a tampered blob is refused", t.name);

    // 8. no webhook URL → no secret generated, nothing returned
    const bare = await issueKey({ clientId: client.id, name: "bare", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli" });
    made.push(bare.id);
    const bareRow = await prisma.clientKey.findUniqueOrThrow({ where: { id: bare.id }, select: { webhookSecret: true, webhookUrl: true } });
    check(bareRow.webhookSecret === null && bareRow.webhookUrl === null && !bare.webhookSecret, "8. without a webhook URL no secret is generated or stored");

    // 9. a non-https, non-loopback URL is refused before anything is written
    const before = await prisma.clientKey.count({ where: { clientId: client.id } });
    const bad = await thrown(() => issueKey({ clientId: client.id, name: "bad", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli", webhookUrl: "http://store.example/hook" }));
    const after = await prisma.clientKey.count({ where: { clientId: client.id } });
    check(bad.name !== "NO THROW" && before === after, "9. plain-http webhook URL to a non-loopback host is refused; no key row written", `${bad.name}, keys ${before}→${after}`);
    const loop = await issueKey({ clientId: client.id, name: "loopback", scopes: ["deposits.read"], issuedBy: "verify", issuedVia: "cli", webhookUrl: "http://127.0.0.1:3033/api/webhooks/samapay/c1" });
    made.push(loop.id);
    check(true, "9b. plain http to 127.0.0.1 is accepted (slice 1: both services on one box)");
  } catch (err) {
    check(false, "THE SUITE THREW — nothing below this point ran", String(err instanceof Error ? err.stack : err));
  } finally {
    await prisma.webhookDelivery.deleteMany({ where: { id: { in: deliveries } } }).catch(() => undefined);
    await prisma.clientKey.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
    await prisma.client.deleteMany({ where: { id: client.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-webhook-secret-at-rest crashed:", e); process.exit(1); });
