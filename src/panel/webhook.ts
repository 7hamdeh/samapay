// The webhook target a merchant controls, and the secret that signs what goes
// to it. Two properties this file exists to hold:
//
// 1. URL AND SECRET MOVE TOGETHER, or not at all. panel-survey §5 refusal 11 is
//    "a URL set without a secret" — a delivery that then signs with the OLD
//    secret, or with none, to an address the merchant just supplied. There is
//    no code path here that writes `webhookUrl` without writing a freshly
//    generated, AEAD-stored secret in the same transaction.
//
// 2. EVERY TARGET IS GUARDED AT SAVE *AND* AT SEND. src/keys/webhook-secret.ts
//    validates shape only (https, or http to loopback, no credentials) — it does
//    not resolve DNS and has no private-range blocklist, so a merchant can
//    point the gateway at 169.254.169.254 or at a co-located internal service
//    and read the outcome off the delivery log's status/last_error, which is a
//    port scanner through our own egress (pay-dashboard-review.md, SSRF answer).
//    The guard is the ported MNTAD one (src/net/), and the loopback exception is
//    OPERATOR config, never merchant input.
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { decryptWebhookSecret, encryptWebhookSecret, generateWebhookSecret } from "@/keys/webhook-secret.js";
import { assertWebhookTargetUrl } from "@/net/webhook-target.js";
import { visibleClientIds } from "./keys.js";
import { membershipFor } from "./accounts.js";

export type WebhookRefusal =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "not_owner" }
  | { ok: false; code: "target_refused"; reason: string }
  // R2/R3 (pay-dashboard review 2026-09-27): the key's provenance, not the
  // caller's role, is what refuses. See PANEL_WRITABLE_WEBHOOK_VIA below.
  | { ok: false; code: "webhook_locked"; createdVia: string };

/** The only provenance whose webhook the panel may write. Anything else —
 *  `cli`, the struck `samaprime_admin_action`, a value nobody has invented yet —
 *  is a key Ibrahim minted, and on this estate THAT key is the store's crediting
 *  address: `applyTerms` sets the client's fee and limits around it, MNTAD's
 *  receiver is the URL it carries, and a merchant who re-points it stops being
 *  credited until reconcile notices days later.
 *
 *  The HIGH fix (a delivery goes to its OWN key's webhook, 17967b9) closed
 *  re-pointing by MINTING a new key. It says nothing about editing the CLI key
 *  in place, which is what an account owner with a handoff session can do —
 *  the re-review's RESIDUAL line (pay-dashboard-review-0927.txt:49) names it, and
 *  requires it closed before the MNTAD issuer ships. An ALLOWLIST, so the next
 *  provenance value is locked by default rather than by somebody remembering to
 *  add a case. */
const PANEL_WRITABLE_WEBHOOK_VIA: readonly string[] = ["panel_owner"];

/** Provenance is decided AFTER tenancy and role, never before: to an account
 *  that cannot see the key, a locked key must stay indistinguishable from a key
 *  that does not exist, or the refusal itself becomes the existence oracle
 *  panel-survey §5 refusal 5 refuses to open. */
async function refuseUnlessPanelWritten(input: { accountId: string; keyId: string; createdVia: string }): Promise<WebhookRefusal | null> {
  if (PANEL_WRITABLE_WEBHOOK_VIA.includes(input.createdVia)) return null;
  await appendAudit(prisma, {
    keyId: input.keyId, actor: `account:${input.accountId}`, action: "panel.webhook.refused_locked",
    subjectId: input.keyId, params: { created_via: input.createdVia },
  });
  return { ok: false, code: "webhook_locked", createdVia: input.createdVia };
}

/** Returns the PLAINTEXT secret exactly once, in this result. The row keeps the
 *  "v1:" ciphertext (src/keys/webhook-secret.ts) and the dispatcher refuses to
 *  sign with anything that does not decrypt, so a rotation that half-applied is
 *  a delivery that goes `exhausted` rather than one sent with a stale key. */
export async function panelSetWebhook(input: {
  accountId: string; keyId: string; url: string; allowedHostnames?: readonly string[];
}): Promise<{ ok: true; webhookSecret: string; webhookUrl: string } | WebhookRefusal> {
  const key = await prisma.clientKey.findUnique({ where: { id: input.keyId }, select: { clientId: true, active: true, createdVia: true } });
  if (!key || !(await visibleClientIds(input.accountId)).includes(key.clientId)) return { ok: false, code: "not_found" };
  if ((await membershipFor(input.accountId, key.clientId))?.role !== "owner") return { ok: false, code: "not_owner" };
  const locked = await refuseUnlessPanelWritten({ accountId: input.accountId, keyId: input.keyId, createdVia: key.createdVia });
  if (locked) return locked;

  const guard = await assertWebhookTargetUrl(input.url, { allowHostnames: input.allowedHostnames ?? [] });
  if (!guard.ok) return { ok: false, code: "target_refused", reason: guard.code };

  const plaintext = generateWebhookSecret();
  const ciphertext = encryptWebhookSecret(plaintext);
  const url = guard.normalizedUrl ?? input.url.trim();
  await prisma.$transaction(async (tx) => {
    // The conditional update is the atomicity: one row, both columns, one write.
    await tx.clientKey.update({
      where: { id: input.keyId },
      data: { webhookUrl: url, webhookSecret: ciphertext, webhookUpdatedAt: new Date() },
    });
    await appendAudit(tx, {
      keyId: input.keyId, actor: `account:${input.accountId}`, action: "panel.webhook.url_set",
      subjectId: input.keyId, params: { url_host: hostOf(url), secret_rotated: true },
    });
  });
  return { ok: true, webhookSecret: plaintext, webhookUrl: url };
}

/** Only the host, never the path or query: a webhook URL can carry a token in
 *  its path and the audit chain is not a place to put a merchant's secret. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "unparseable"; }
}

export async function panelClearWebhook(input: { accountId: string; keyId: string }): Promise<{ ok: true } | WebhookRefusal> {
  const key = await prisma.clientKey.findUnique({ where: { id: input.keyId }, select: { clientId: true, createdVia: true } });
  if (!key || !(await visibleClientIds(input.accountId)).includes(key.clientId)) return { ok: false, code: "not_found" };
  if ((await membershipFor(input.accountId, key.clientId))?.role !== "owner") return { ok: false, code: "not_owner" };
  const locked = await refuseUnlessPanelWritten({ accountId: input.accountId, keyId: input.keyId, createdVia: key.createdVia });
  if (locked) return locked;
  await prisma.$transaction(async (tx) => {
    await tx.clientKey.update({ where: { id: input.keyId }, data: { webhookUrl: null, webhookSecret: null, webhookUpdatedAt: new Date() } });
    await appendAudit(tx, { keyId: input.keyId, actor: `account:${input.accountId}`, action: "panel.webhook.cleared", subjectId: input.keyId });
  });
  return { ok: true };
}

export const TEST_EVENT_TYPE = "webhook.test";

/** The panel's "send a test" button. It goes through THE SAME delivery path as
 *  a real event — the row is written, then `attemptDelivery` claims, signs and
 *  POSTs it — because a test that exercises a different code path proves
 *  nothing about the path that matters.
 *
 *  It is marked `testOnly` on the row and typed `webhook.test`, and MNTAD's
 *  receiver refuses anything that is not payment_intent.* or deposit.confirmed
 *  (lib/samapay/webhook.ts:144-149, measured), so a test can never credit a
 *  store on the other side. That refusal is the reason this is safe to expose.
 *
 *  SCOPE, stated so silence is not approval: this one is NOT locked to
 *  panel_owner the way set and clear are (R2/R3). A test sends to the URL the
 *  key already carries — it changes nothing, rotates nothing, and the row it
 *  writes is marked testOnly. What it does cost is one request to the store's
 *  endpoint and one line in that client's delivery log, throttled to one per key
 *  per minute by the route. */
export async function panelTestWebhook(input: { accountId: string; keyId: string; allowedHostnames?: readonly string[] }): Promise<{ ok: true; deliveryId: string; status: number | null; outcome: string } | WebhookRefusal> {
  const key = await prisma.clientKey.findUnique({
    where: { id: input.keyId },
    select: { clientId: true, webhookUrl: true, webhookSecret: true, keyPrefix: true },
  });
  if (!key || !(await visibleClientIds(input.accountId)).includes(key.clientId)) return { ok: false, code: "not_found" };
  if ((await membershipFor(input.accountId, key.clientId))?.role !== "owner") return { ok: false, code: "not_owner" };
  if (!key.webhookUrl || !key.webhookSecret) return { ok: false, code: "target_refused", reason: "no_webhook_target" };

  // Re-guard at send time. A URL that was safe when saved may resolve
  // somewhere else now — that is the whole argument for checking both ends.
  // The SAME allowlist as at save: an operator-allowlisted loopback target must
  // not pass at save and then be refused by the test button.
  const guard = await assertWebhookTargetUrl(key.webhookUrl, { allowHostnames: input.allowedHostnames ?? [] });
  if (!guard.ok) return { ok: false, code: "target_refused", reason: guard.code };

  const eventId = `test_${randomBytes(8).toString("hex")}`;
  const payload = {
    id: eventId,
    type: TEST_EVENT_TYPE,
    created_at: new Date().toISOString(),
    data: { object: { kind: "webhook_test", key_prefix: key.keyPrefix, note: "Sent from the MNTAD Pay panel. This is not a payment." } },
  } as unknown as Prisma.InputJsonObject;
  const delivery = await prisma.webhookDelivery.create({
    data: { keyId: input.keyId, clientId: key.clientId, eventType: TEST_EVENT_TYPE, eventId, payload, testOnly: true, nextAttemptAt: new Date() },
    select: { id: true },
  });
  // THE REAL PATH: attemptDelivery claims the row under the same 60 s lease,
  // decrypts the secret, signs and POSTs with redirect:"manual". A test that
  // used a different code path would prove nothing about the one that credits.
  const { attemptDelivery } = await import("@/webhooks/dispatch.js");
  const outcome = await attemptDelivery(delivery.id);
  const row = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id }, select: { lastStatusCode: true, status: true } });
  await appendAudit(prisma, {
    keyId: input.keyId, actor: `account:${input.accountId}`, action: "panel.webhook.test_sent",
    subjectId: delivery.id, params: { url_host: hostOf(key.webhookUrl), outcome: outcome.outcome },
  });
  // The merchant sees the HTTP status their endpoint answered, or the reason it
  // was not reached. `suppressed`/`exhausted` are outcomes, never a silent 200.
  return { ok: true, deliveryId: delivery.id, status: row?.lastStatusCode ?? null, outcome: outcome.outcome };
}

export async function panelListDeliveries(input: { accountId: string; clientId: string; limit?: number; status?: string; testOnly?: boolean }) {
  if (!(await visibleClientIds(input.accountId)).includes(input.clientId)) return null;
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      clientId: input.clientId,
      ...(input.status ? { status: input.status as never } : {}),
      ...(input.testOnly === undefined ? {} : { testOnly: input.testOnly }),
    },
    select: {
      id: true, keyId: true, eventType: true, eventId: true, attempts: true, status: true,
      nextAttemptAt: true, lastStatusCode: true, lastError: true, createdAt: true, deliveredAt: true, testOnly: true,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
  });
  return rows;
}

/** For the "is my secret still readable?" banner: a merchant needs to know a
 *  rotation half-applied, and this is the only honest way to say it — try to
 *  decrypt and report only whether it worked. */
export function panelSecretReadable(stored: string | null): boolean {
  if (!stored) return false;
  try { decryptWebhookSecret(stored); return true; } catch { return false; }
}
