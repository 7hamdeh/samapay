// PRE-PROVISIONED MERCHANT ACCOUNTS — decision #80 / S2 slice 1: one Client
// per merchant, one LIVE key per client carrying the webhook URL + secret.
// The only caller is scripts/issue-key.ts (Ibrahim's hand). Keys are minted
// by the owner's hand; nothing here is reachable over HTTP.
//
// Selecting the client: `clientId` exactly, or `clientName` — created when no
// client has that name, reused when exactly one does, REFUSED when more than
// one does (a name is not an identity; guessing between two accounts is how
// a key lands on the wrong merchant).
import type { ClientKind, KeyEnvironment } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { logger } from "@/log.js";
import { issueKey } from "./issue.js";
import { resolveTerms } from "./terms.js";

export type ProvisionErrorCode = "client_selector_required" | "client_not_found" | "client_ambiguous" | "client_kind_mismatch" | "live_webhook_key_exists";
export class ProvisionError extends Error {
  constructor(readonly code: ProvisionErrorCode, message: string) { super(message); this.name = "ProvisionError"; }
}

export interface ProvisionInput {
  clientId?: string;
  clientName?: string;
  kind: ClientKind;
  keyName: string;
  scopes: string[];
  issuedBy: string;
  environment?: KeyEnvironment;
  webhookUrl?: string | null;
  /**
   * Phase 0 account terms (src/keys/terms.ts): { feeBps?, minIntent?,
   * maxIntent?, enabledChains? }. Only the given fields change; absent ones
   * keep the client's current value (the column defaults for a new client).
   * Validated BEFORE any row is written — a bad fee creates no client.
   */
  terms?: unknown;
}

export async function provisionClientKey(input: ProvisionInput) {
  if (!input.clientId && !input.clientName) throw new ProvisionError("client_selector_required", "give --client-id or --client");
  // Shape-check the terms first (against the column defaults); re-checked
  // below against the selected client's own min/max.
  resolveTerms(input.terms ?? {}, { minIntent: "1", maxIntent: "10000" });
  let client: { id: string; name: string; kind: ClientKind; created: boolean };
  if (input.clientId) {
    const row = await prisma.client.findUnique({ where: { id: input.clientId }, select: { id: true, name: true, kind: true } });
    if (!row) throw new ProvisionError("client_not_found", `no client with id ${input.clientId}`);
    client = { ...row, created: false };
  } else {
    const rows = await prisma.client.findMany({ where: { name: input.clientName as string }, select: { id: true, name: true, kind: true }, take: 2 });
    if (rows.length > 1) throw new ProvisionError("client_ambiguous", `more than one client is named "${input.clientName}" — use --client-id`);
    client = rows[0]
      ? { ...rows[0], created: false }
      : { ...(await prisma.client.create({ data: { name: input.clientName as string, kind: input.kind }, select: { id: true, name: true, kind: true } })), created: true };
  }
  if (client.kind !== input.kind) throw new ProvisionError("client_kind_mismatch", `client ${client.id} is kind ${client.kind}, not ${input.kind}`);

  const terms = await applyTerms(client.id, input.terms ?? {}, input.issuedBy);

  // ONE LIVE WEBHOOK KEY PER CLIENT. A second would split one merchant's
  // events across two secrets; rotation is revoke-then-provision, by hand.
  // Not race-proof against two concurrent CLI runs — this is a hand tool.
  const environment: KeyEnvironment = input.environment ?? "live";
  if (environment === "live" && input.webhookUrl) {
    const live = await prisma.clientKey.findFirst({ where: { clientId: client.id, environment: "live", active: true, revokedAt: null, webhookUrl: { not: null } }, select: { keyPrefix: true } });
    if (live) throw new ProvisionError("live_webhook_key_exists", `client ${client.id} already has an active live key with a webhook (${live.keyPrefix}…) — revoke it first`);
  }
  const key = await issueKey({ clientId: client.id, name: input.keyName, scopes: input.scopes, environment, issuedBy: input.issuedBy, issuedVia: "cli", webhookUrl: input.webhookUrl ?? null });
  return { client, key, terms };
}

/**
 * Sets the given terms on the client and appends `client.terms_set` to the
 * audit chain in ONE transaction. Returns the client's terms as they stand
 * afterwards (unchanged when no term was given — then nothing is written).
 */
export async function applyTerms(clientId: string, rawTerms: unknown, by: string) {
  const select = { feeBps: true, minIntent: true, maxIntent: true, enabledChains: true } as const;
  return prisma.$transaction(async (tx) => {
    const current = await tx.client.findUnique({ where: { id: clientId }, select });
    if (!current) throw new ProvisionError("client_not_found", `no client with id ${clientId}`);
    const data = resolveTerms(rawTerms, current);
    if (Object.keys(data).length === 0) return current;
    const after = await tx.client.update({ where: { id: clientId }, data, select });
    const params = { before: termsJson(current), after: termsJson(after) };
    await appendAudit(tx, { actor: `cli:${by}`, action: "client.terms_set", subjectId: clientId, params });
    logger.info({ actor: `cli:${by}`, action: "client.terms_set", clientId, result: "ok", ...params }, "client terms set");
    return after;
  });
}

function termsJson(t: { feeBps: number; minIntent: { toString(): string }; maxIntent: { toString(): string }; enabledChains: string[] }) {
  return { fee_bps: t.feeBps, min_intent: t.minIntent.toString(), max_intent: t.maxIntent.toString(), enabled_chains: t.enabledChains };
}
