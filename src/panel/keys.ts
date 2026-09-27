// The panel's key surface: list, mint, revoke — always for the caller's OWN
// clients only.
//
// THE SCOPING RULE, in one sentence: the acting account comes from the session,
// the target client comes from an AccountClient row of THAT account, and never
// from a request parameter (panel-survey §5 refusal 13). Every function here
// therefore takes `accountId` and resolves clients from it; a route that has a
// clientId in its body calls these functions anyway and gets `not_found`, which
// is the same answer as "no such key" for every other reason.
import { Prisma, type KeyEnvironment } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { issueKey, IssueKeyError, revokeKey } from "@/keys/issue.js";
import { read as readAllowance } from "@/allowance/index.js";
import { SCOPES, type Scope } from "@/http/scopes.js";
import { membershipFor } from "./accounts.js";
import { assertWebhookTargetUrl } from "@/net/webhook-target.js";

/** `keys.issue` is not in this list and can never be. It is minted by the CLI
 *  only, and issueKey's own refusal (keys_issue_not_via_admin) is the backstop
 *  when a picker is wired wrong — a panel that could mint an admin key would
 *  make "keys come by his hand" false by degrees. */
export const PANEL_MINTABLE_SCOPES: readonly Scope[] = SCOPES.filter((s) => s !== "keys.issue");

export type PanelKeyRow = Readonly<{
  id: string; name: string; keyPrefix: string; keyLast4: string; scopes: string[];
  environment: KeyEnvironment; active: boolean; createdAt: Date; lastUsedAt: Date | null; lastUsedIp: string | null;
  revokedAt: Date | null; revokedReason: string | null; webhookUrl: string | null;
  hasWebhookSecret: boolean; webhookUpdatedAt: Date | null; createdVia: string; rpsLimit: number;
}>;

export type PanelRefusal =
  | { ok: false; code: "not_found" }
  | { ok: false; code: "not_owner" }
  | { ok: false; code: "scope_not_mintable"; scope: string }
  | { ok: false; code: "target_refused"; reason: string }
  | { ok: false; code: "revoke_blocked"; allowance: string; consumingWithdrawals: number };

const KEY_SELECT = {
  id: true, clientId: true, name: true, keyPrefix: true, keyLast4: true, scopes: true, environment: true,
  active: true, createdAt: true, lastUsedAt: true, lastUsedIp: true, revokedAt: true, revokedReason: true,
  webhookUrl: true, webhookSecret: true, webhookUpdatedAt: true, createdVia: true, rpsLimit: true,
} satisfies Prisma.ClientKeySelect;

type KeyRow = Prisma.ClientKeyGetPayload<{ select: typeof KEY_SELECT }>;

function toRow(k: KeyRow): PanelKeyRow {
  return Object.freeze({
    id: k.id, name: k.name, keyPrefix: k.keyPrefix, keyLast4: k.keyLast4, scopes: k.scopes,
    environment: k.environment, active: k.active, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt,
    lastUsedIp: k.lastUsedIp, revokedAt: k.revokedAt, revokedReason: k.revokedReason,
    webhookUrl: k.webhookUrl,
    // A BOOLEAN, not the ciphertext. The encrypted blob is not the merchant's
    // secret to hold twice, and handing it out would let a reader of the panel
    // response sign deliveries with a key they can no longer see.
    hasWebhookSecret: k.webhookSecret !== null,
    webhookUpdatedAt: k.webhookUpdatedAt, createdVia: k.createdVia, rpsLimit: k.rpsLimit,
  });
}

/** Clients the account can see, in membership order. */
export async function visibleClientIds(accountId: string): Promise<string[]> {
  const rows = await prisma.accountClient.findMany({ where: { accountId }, select: { clientId: true } });
  return rows.map((r) => r.clientId);
}

export async function panelListKeys(accountId: string, clientId: string): Promise<PanelKeyRow[] | null> {
  if (!(await visibleClientIds(accountId)).includes(clientId)) return null;
  const keys = await prisma.clientKey.findMany({ where: { clientId }, select: KEY_SELECT, orderBy: { createdAt: "desc" } });
  return keys.map(toRow);
}

/** One key, addressed by id — and answered with `not_found` unless the caller's
 *  account owns its client. A 403 here would confirm the id exists, which is
 *  the same existence oracle admin-keys.ts:52 refuses to give. */
export async function panelGetKey(accountId: string, keyId: string): Promise<PanelKeyRow | null> {
  const k = await prisma.clientKey.findUnique({ where: { id: keyId }, select: { ...KEY_SELECT, client: { select: { id: true } } } });
  if (!k) return null;
  if (!(await visibleClientIds(accountId)).includes(k.client.id)) return null;
  return toRow(k);
}

export interface MintInput {
  accountId: string;
  clientId: string;
  name: string;
  scopes: string[];
  environment?: KeyEnvironment;
  webhookUrl?: string | null;
  ip: string | null;
  /** Operator allowlist for the http+loopback exception. A mint that carries a
   *  webhook URL opens the same SSRF door as panelSetWebhook, so it must pass
   *  the same guard — shape validation alone accepts https://169.254.169.254. */
  allowedHostnames?: readonly string[];
}

/** Mints on the CALLER'S OWN client. `issuedVia: "panel_owner"` is a new value
 *  in that column on purpose — see src/keys/issue.ts's comment on why the
 *  panel must not reuse "cli": that union member is what unlocks `keys.issue`. */
export async function panelCreateKey(input: MintInput): Promise<
  | { ok: true; id: string; plaintext: string; webhookSecret: string | null; row: PanelKeyRow }
  | PanelRefusal
> {
  const membership = await membershipFor(input.accountId, input.clientId);
  if (!membership) return { ok: false, code: "not_found" };
  if (membership.role !== "owner") return { ok: false, code: "not_owner" };
  const wanted = input.scopes.filter((s) => !(PANEL_MINTABLE_SCOPES as readonly string[]).includes(s));
  if (wanted.length) return { ok: false, code: "scope_not_mintable", scope: wanted.join(",") };
  // A mint that carries a webhook URL opens the same egress door as a later
  // webhook set, so it is guarded here too — and the NORMALIZED url is what
  // reaches the row, never the raw string a client typed.
  let webhookUrl: string | null = null;
  if (input.webhookUrl) {
    const guard = await assertWebhookTargetUrl(input.webhookUrl, { allowHostnames: input.allowedHostnames ?? [] });
    if (!guard.ok) return { ok: false, code: "target_refused", reason: guard.code };
    webhookUrl = guard.normalizedUrl;
  }
  try {
    const issued = await issueKey({
      clientId: input.clientId,
      name: input.name,
      scopes: input.scopes,
      ...(input.environment ? { environment: input.environment } : {}),
      issuedBy: `account:${input.accountId}`,
      issuedVia: "panel_owner",
      createdVia: "panel_owner",
      createdFromIp: input.ip,
      webhookUrl,
    });
    const row = await panelGetKey(input.accountId, issued.id);
    if (!row) throw new Error("panel: minted a key we cannot read back — ownership resolution is broken");
    // `plaintext` and `webhookSecret` exist once, in this return value, and are
    // rendered into exactly one response body. Nothing here writes them to a
    // log, a row, or a cache.
    return { ok: true, id: issued.id, plaintext: issued.plaintext, webhookSecret: issued.webhookSecret, row };
  } catch (e) {
    if (e instanceof IssueKeyError && e.code === "unknown_client") return { ok: false, code: "not_found" };
    if (e instanceof IssueKeyError && e.code === "keys_issue_not_via_admin") return { ok: false, code: "scope_not_mintable", scope: "keys.issue" };
    throw e;
  }
}

/** Revocation refuses while the key still guards value. The webhook URL that
 *  credits a store lives on the key, and a key with a non-zero allowance is
 *  money that has arrived and not yet been accounted for: killing it is a way
 *  to strand funds, not to protect them (panel-survey §5 refusal 3). The
 *  refusal NAMES the numbers, because "you cannot" without a figure is a bug
 *  report the merchant cannot act on. */
export async function panelRevokeKey(input: { accountId: string; keyId: string; reason: string }): Promise<{ ok: true } | PanelRefusal> {
  const key = await prisma.clientKey.findUnique({ where: { id: input.keyId }, select: { clientId: true, active: true } });
  if (!key || !(await visibleClientIds(input.accountId)).includes(key.clientId)) return { ok: false, code: "not_found" }
  const membership = await membershipFor(input.accountId, key.clientId);
  if (membership?.role !== "owner") return { ok: false, code: "not_owner" }
  const pos = await readAllowance(input.keyId);
  if (!pos.allowance.isZero()) {
    return { ok: false, code: "revoke_blocked", allowance: pos.allowance.toString(), consumingWithdrawals: pos.withdrawalCount };
  }
  if (pos.withdrawalCount > 0) {
    return { ok: false, code: "revoke_blocked", allowance: pos.allowance.toString(), consumingWithdrawals: pos.withdrawalCount };
  }
  const count = await revokeKey(input.keyId, `account:${input.accountId}`, input.reason);
  if (count === 0) return { ok: false, code: "not_found" }
  return { ok: true };
}
