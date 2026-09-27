// Issuing and revoking keys. Called by the CLI (his hand), by the admin route
// (retired, unmounted) and — since the phase-1 panel — by the signed-in OWNER
// of the account the key belongs to. Returns the plaintext ONCE; nothing stores
// it. Same for the webhook secret when a webhook URL is given: plaintext
// returned once, AEAD ciphertext stored (webhook-secret.ts).
//
// ⚠️ THE `keys.issue` REFUSAL BELOW IS DERIVED FROM `issuedVia !== "cli"`, so
// the value a caller passes is a privilege, not a label. That is precisely why
// the panel passes its OWN value: reusing "cli" for a panel mint would hand the
// panel the CLI's one unforgeable power (minting an admin key that can mint
// admin keys), silently and by accident of a string. See
// pay-dashboard.md B.6 step 9, which proposes keeping "cli" — implemented
// differently here, deliberately, and flagged for Ibrahim in the approval doc.
import type { KeyEnvironment } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { isScope, type Scope } from "@/http/scopes.js";
import { generatePlaintextKey, hashKey, keyLast4Of, keyPrefixOf } from "./generate.js";
import { encryptWebhookSecret, generateWebhookSecret, validateWebhookUrl } from "./webhook-secret.js";

export interface IssueKeyInput {
  clientId: string;
  name: string;
  scopes: string[];
  environment?: KeyEnvironment;
  // Provenance columns the panel fills in (EXPAND, 20261001000000_panel_identity).
  // Defaults keep every existing caller writing exactly what it wrote before.
  createdVia?: "cli" | "panel_owner";
  createdFromIp?: string | null;
  // 'ibrahim' | 'account:<accountId>' for a panel owner | a CLI operator name.
  issuedBy: string;
  // 'samaprime_admin_action' is STRUCK (CLAUDE.md 2026-09-06) but stays in the
  // union because rows carrying it exist; nothing may write it again.
  issuedVia: "cli" | "samaprime_admin_action" | "panel_owner";
  webhookUrl?: string | null;
}

export class IssueKeyError extends Error {
  constructor(readonly code: "unknown_client" | "invalid_scope" | "keys_issue_not_via_admin", message: string) { super(message); this.name = "IssueKeyError"; }
}

export async function issueKey(input: IssueKeyInput) {
  const bad = input.scopes.filter((s) => !isScope(s));
  if (bad.length) throw new IssueKeyError("invalid_scope", `unknown scope(s): ${bad.join(", ")}`);
  const scopes = input.scopes as Scope[];
  // keys.issue is minted by the CLI only — an admin key must not be able to
  // mint another admin key, or "keys by his hand" stops being true.
  if (scopes.includes("keys.issue") && input.issuedVia !== "cli") {
    throw new IssueKeyError("keys_issue_not_via_admin", "keys.issue can only be issued from the CLI");
  }
  const client = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true } });
  if (!client) throw new IssueKeyError("unknown_client", `client ${input.clientId} does not exist`);
  const environment: KeyEnvironment = input.environment ?? "live";
  // A webhook URL brings its own secret, generated HERE and nowhere else: the
  // plaintext is returned once (below) and the column only ever receives the
  // AEAD ciphertext. Validated BEFORE any row is written.
  const webhookUrl = input.webhookUrl ? validateWebhookUrl(input.webhookUrl) : null;
  const webhookSecret = webhookUrl ? generateWebhookSecret() : null;
  const webhookSecretCiphertext = webhookSecret ? encryptWebhookSecret(webhookSecret) : null;

  // Prefix collision is possible (12 chars, 4 random); loop rather than fail.
  for (let attempt = 0; attempt < 5; attempt++) {
    const plaintext = generatePlaintextKey(environment);
    const keyPrefix = keyPrefixOf(plaintext);
    const exists = await prisma.clientKey.findUnique({ where: { keyPrefix }, select: { id: true } });
    if (exists) continue;
    const keyHash = await hashKey(plaintext);
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.clientKey.create({
        data: {
          clientId: client.id, name: input.name, keyPrefix, keyHash, keyLast4: keyLast4Of(plaintext),
          scopes, environment, issuedBy: input.issuedBy, issuedVia: input.issuedVia, webhookUrl, webhookSecret: webhookSecretCiphertext,
          createdVia: input.createdVia ?? (input.issuedVia === "panel_owner" ? "panel_owner" : "cli"),
          createdFromIp: input.createdFromIp ?? null,
        },
        select: { id: true, clientId: true, name: true, keyPrefix: true, keyLast4: true, scopes: true, environment: true, createdAt: true },
      });
      const actor = input.issuedVia === "cli" ? `cli:${input.issuedBy}` : input.issuedVia === "panel_owner" ? input.issuedBy : `admin:${input.issuedBy}`;
      await appendAudit(tx, { keyId: created.id, actor, action: "key.issued", subjectId: created.id, params: { scopes, environment, name: input.name, webhookUrl } });
      return created;
    });
    // `webhookSecret` is the PLAINTEXT, returned once like `plaintext`; null when no URL was given.
    return { ...row, plaintext, webhookSecret };
  }
  throw new Error("could not allocate a unique key prefix after 5 attempts");
}

export async function revokeKey(keyId: string, revokedBy: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.clientKey.updateMany({ where: { id: keyId, active: true }, data: { active: false, revokedAt: new Date(), revokedReason: reason } });
    if (updated.count === 1) await appendAudit(tx, { keyId, actor: revokedBy, action: "key.revoked", subjectId: keyId, params: { reason } });
    return updated.count;
  });
}
