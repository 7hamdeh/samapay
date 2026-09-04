// Issuing and revoking keys. Called by the CLI (his hand) and by the admin
// route (SamaPrime's admin key, scope keys.issue). Returns the plaintext
// ONCE; nothing stores it.
import type { KeyEnvironment } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { isScope, type Scope } from "@/http/scopes.js";
import { generatePlaintextKey, hashKey, keyLast4Of, keyPrefixOf } from "./generate.js";

export interface IssueKeyInput {
  clientId: string;
  name: string;
  scopes: string[];
  environment?: KeyEnvironment;
  issuedBy: string;   // 'ibrahim' | 'samaprime_admin:<userId>'
  issuedVia: "cli" | "samaprime_admin_action";
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
          scopes, environment, issuedBy: input.issuedBy, issuedVia: input.issuedVia, webhookUrl: input.webhookUrl ?? null,
        },
        select: { id: true, clientId: true, name: true, keyPrefix: true, keyLast4: true, scopes: true, environment: true, createdAt: true },
      });
      await appendAudit(tx, { keyId: created.id, actor: input.issuedVia === "cli" ? `cli:${input.issuedBy}` : `admin:${input.issuedBy}`, action: "key.issued", subjectId: created.id, params: { scopes, environment, name: input.name } });
      return created;
    });
    return { ...row, plaintext };
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
