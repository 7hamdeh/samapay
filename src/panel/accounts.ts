// Accounts and the ONLY path that connects a signed-in human to a Client.
//
// Ibrahim's rule, verbatim (CLAUDE.md, typed 2026-09-06): "KEYS ARE MINTED BY
// THE OWNER'S HAND OR BY THE CLIENT PANEL'S OWN SIGNED-IN OWNER FOR THEIR OWN
// ACCOUNT — NEVER BY AN OPERATOR ON SOMEONE ELSE'S BEHALF." Every function that
// resolves a target Client takes the SESSION's account id and nothing else; a
// route that receives a clientId from a body or a URL and hands it here is the
// bug this file exists to make impossible (panel-survey §5 refusal 13).
import type { AccountRole } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { normalizeEmail } from "./email.js";

export type AccountView = Readonly<{
  id: string; email: string; displayName: string | null;
  totpEnabled: boolean; disabled: boolean; createdAt: Date; lastSignInAt: Date | null;
}>;

function view(a: { id: string; email: string; displayName: string | null; totpEnabledAt: Date | null; disabledAt: Date | null; createdAt: Date; lastSignInAt: Date | null }): AccountView {
  return Object.freeze({
    id: a.id, email: a.email, displayName: a.displayName,
    totpEnabled: a.totpEnabledAt !== null, disabled: a.disabledAt !== null,
    createdAt: a.createdAt, lastSignInAt: a.lastSignInAt,
  });
}

export async function findAccountByEmail(email: string) {
  return prisma.account.findUnique({ where: { email: normalizeEmail(email) } });
}

/** Sign-up is idempotent per email, because "code sent, tab closed, try again"
 *  is the normal path and a second row would fork a merchant's ownership. */
export async function upsertAccount(input: { email: string; displayName?: string | null; mntadUserId?: string | null; mntadMerchantId?: string | null }) {
  const email = normalizeEmail(input.email);
  return prisma.account.upsert({
    where: { email },
    create: { email, displayName: input.displayName ?? null, mntadUserId: input.mntadUserId ?? null, mntadMerchantId: input.mntadMerchantId ?? null },
    update: {
      ...(input.displayName !== undefined && input.displayName !== null ? { displayName: input.displayName } : {}),
      ...(input.mntadUserId ? { mntadUserId: input.mntadUserId } : {}),
      ...(input.mntadMerchantId ? { mntadMerchantId: input.mntadMerchantId } : {}),
    },
  });
}

export async function touchSignIn(accountId: string) {
  return prisma.account.update({ where: { id: accountId }, data: { lastSignInAt: new Date() } });
}

export async function getAccount(accountId: string): Promise<AccountView | null> {
  const a = await prisma.account.findUnique({ where: { id: accountId } });
  return a ? view(a) : null;
}

/** The clients this account may act on. Empty is a legitimate answer — an
 *  account that was signed up but never provisioned simply has no dashboard
 *  yet, and the panel says so instead of inventing a client. */
export async function listMemberships(accountId: string) {
  const rows = await prisma.accountClient.findMany({
    where: { accountId },
    select: { clientId: true, role: true, createdAt: true, client: { select: { id: true, name: true, kind: true, feeBps: true, enabledChains: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({ ...r.client, role: r.role as AccountRole, memberSince: r.createdAt }));
}

export async function membershipFor(accountId: string, clientId: string) {
  return prisma.accountClient.findUnique({ where: { accountId_clientId: { accountId, clientId } }, select: { role: true } });
}

/** Idempotent on (accountId, clientId) but NOT on role: a role change is an
 *  explicit act, and silently "upserting" a viewer into an owner is exactly the
 *  privilege step the panel must never take on its own. */
export async function grantMembership(input: { accountId: string; clientId: string; role: AccountRole }) {
  return prisma.accountClient.upsert({
    where: { accountId_clientId: { accountId: input.accountId, clientId: input.clientId } },
    create: { accountId: input.accountId, clientId: input.clientId, role: input.role },
    update: {},
  });
}

export async function setDisplayName(accountId: string, displayName: string) {
  return prisma.account.update({ where: { id: accountId }, data: { displayName } });
}
