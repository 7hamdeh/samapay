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
import { issueKey } from "./issue.js";

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
}

export async function provisionClientKey(input: ProvisionInput) {
  if (!input.clientId && !input.clientName) throw new ProvisionError("client_selector_required", "give --client-id or --client");
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

  // ONE LIVE WEBHOOK KEY PER CLIENT. A second would split one merchant's
  // events across two secrets; rotation is revoke-then-provision, by hand.
  // Not race-proof against two concurrent CLI runs — this is a hand tool.
  const environment: KeyEnvironment = input.environment ?? "live";
  if (environment === "live" && input.webhookUrl) {
    const live = await prisma.clientKey.findFirst({ where: { clientId: client.id, environment: "live", active: true, revokedAt: null, webhookUrl: { not: null } }, select: { keyPrefix: true } });
    if (live) throw new ProvisionError("live_webhook_key_exists", `client ${client.id} already has an active live key with a webhook (${live.keyPrefix}…) — revoke it first`);
  }
  const key = await issueKey({ clientId: client.id, name: input.keyName, scopes: input.scopes, environment, issuedBy: input.issuedBy, issuedVia: "cli", webhookUrl: input.webhookUrl ?? null });
  return { client, key };
}
