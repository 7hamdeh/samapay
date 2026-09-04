// Hash-chained audit. Each row's hash = sha256(prev_hash + canonical JSON of
// the row's own fields). Append-only is enforced by triggers in the first
// migration; this module is the ONLY writer. Call inside the caller's
// transaction so the audit row commits with the change it describes.
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditInput {
  keyId?: string | null;
  actor: string;         // 'client' | 'admin:<who>' | 'observer' | 'sender' | 'reconciler' | 'cli:<who>'
  action: string;        // 'key.issued' | 'key.revoked' | 'address.issued' | ...
  subjectId?: string | null;
  idempotencyKey?: string | null;
  params?: Record<string, unknown> | null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

export function computeAuditHash(prevHash: string, fields: { at: string; keyId: string | null; actor: string; action: string; subjectId: string | null; idempotencyKey: string | null; params: unknown }): string {
  return createHash("sha256").update(prevHash + canonical(fields)).digest("hex");
}

export async function appendAudit(tx: Prisma.TransactionClient, input: AuditInput) {
  // Serialise chain appends: one advisory lock for the whole chain, so two
  // concurrent writers cannot both read the same prev_hash.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('audit_events_chain'))`;
  const last = await tx.auditEvent.findFirst({ orderBy: { at: "desc" }, select: { hash: true } });
  const prevHash = last?.hash ?? GENESIS_HASH;
  const at = new Date();
  const fields = {
    at: at.toISOString(),
    keyId: input.keyId ?? null,
    actor: input.actor,
    action: input.action,
    subjectId: input.subjectId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    params: input.params ?? null,
  };
  const hash = computeAuditHash(prevHash, fields);
  return tx.auditEvent.create({
    data: { at, keyId: fields.keyId, actor: fields.actor, action: fields.action, subjectId: fields.subjectId, idempotencyKey: fields.idempotencyKey, params: fields.params === null ? Prisma.JsonNull : (fields.params as Prisma.InputJsonValue), prevHash, hash },
  });
}
