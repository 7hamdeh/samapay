// Fixture for the allowance suites: a client, a key, an address, and
// deposits under that key — created in the SANDBOX only (the guard is the
// caller's first statement), deleted and COUNTED at the end.
import { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";

export const STAMP = `${Date.now().toString(36)}`;
export const D = (v: unknown) => new Prisma.Decimal(String(v ?? 0));

const madeClients: string[] = [];
const madeKeys: string[] = [];

export async function makeKey(tag: string): Promise<{ clientId: string; keyId: string }> {
  const client = await prisma.client.create({
    data: { name: `verify-allowance ${STAMP} ${tag}`, kind: "platform" },
    select: { id: true },
  });
  madeClients.push(client.id);
  const key = await prisma.clientKey.create({
    data: {
      clientId: client.id,
      name: `verify ${tag}`,
      keyPrefix: `vfy_${STAMP}_${tag}`.slice(0, 12).padEnd(12, "x") + tag.slice(0, 3),
      keyHash: "not-a-real-hash",
      keyLast4: "0000",
      scopes: ["withdrawals.write", "balance.read"],
      environment: "test",
      issuedBy: "verify-script",
      issuedVia: "cli",
    },
    select: { id: true },
  });
  madeKeys.push(key.id);
  return { clientId: client.id, keyId: key.id };
}

/** A CONFIRMED deposit under `keyId` for `amount` — the only thing that can raise an allowance. */
export async function plantConfirmedDeposit(keyId: string, amount: string, tag: string): Promise<string> {
  const idx = 900_000 + (Number.parseInt(STAMP.slice(-5), 36) % 90_000) + madeKeys.indexOf(keyId) * 10 + (tag.length % 10);
  const address = await prisma.address.create({
    data: { keyId, reference: `cust-${tag}`, chain: "BEP20", address: `0xvfy${STAMP}${tag}`.padEnd(42, "0").slice(0, 42), derivationIndex: idx },
    select: { id: true },
  });
  const dep = await prisma.deposit.create({
    data: { keyId, addressId: address.id, chain: "BEP20", txHash: `0xvfydep${STAMP}${tag}`, amount: D(amount), confirmations: 30, status: "confirmed", creditedAt: new Date() },
    select: { id: true },
  });
  return dep.id;
}

/** Deletes everything the fixture made, in FK order, and returns what is LEFT (counted, not assumed). */
export async function cleanupAndCount(): Promise<number> {
  await prisma.reservation.deleteMany({ where: { keyId: { in: madeKeys } } });
  await prisma.withdrawal.deleteMany({ where: { keyId: { in: madeKeys } } });
  await prisma.deposit.deleteMany({ where: { keyId: { in: madeKeys } } });
  await prisma.address.deleteMany({ where: { keyId: { in: madeKeys } } });
  await prisma.auditEvent.deleteMany({ where: { keyId: { in: madeKeys } } }).catch(() => undefined);
  await prisma.clientKey.deleteMany({ where: { id: { in: madeKeys } } });
  await prisma.client.deleteMany({ where: { id: { in: madeClients } } });
  return (
    (await prisma.clientKey.count({ where: { id: { in: madeKeys } } })) +
    (await prisma.client.count({ where: { id: { in: madeClients } } })) +
    (await prisma.withdrawal.count({ where: { keyId: { in: madeKeys } } })) +
    (await prisma.deposit.count({ where: { keyId: { in: madeKeys } } }))
  );
}
