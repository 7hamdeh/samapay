// Ibrahim's acceptance test 1 — KEY ISOLATION: a deposit under key K
// raises K's allowance by EXACTLY the deposit and moves no other key's.
// "AND NOWHERE ELSE" is the assertion; "it landed at K" is satisfied by a
// system with no discrimination in it. RED-FIRST, sandbox only.
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { read } from "@/allowance/index.js";
import { check, summary } from "./lib/check.js";
import { D, makeKey, plantConfirmedDeposit, cleanupAndCount } from "./lib/allowance-fixture.js";

async function main() {
  console.log(`sandbox: ${await assertSandboxDatabase()}`);
  console.log("ALLOWANCE — KEY ISOLATION\n");
  const K = await makeKey("k");
  const L = await makeKey("l");
  const k0 = await read(K.keyId);
  const l0 = await read(L.keyId);
  check(k0.allowance.eq(0) && k0.received.eq(0) && k0.depositCount === 0, "K starts at zero, with a zero population", `received ${k0.received} over ${k0.depositCount} deposit(s)`);

  await plantConfirmedDeposit(K.keyId, "25", "k1");
  const k1 = await read(K.keyId);
  const l1 = await read(L.keyId);
  check(k1.received.eq(D("25")) && k1.allowance.eq(D("25")) && k1.depositCount === 1, "*** K's allowance rose by EXACTLY the deposit ***", `${k0.allowance} -> ${k1.allowance}`);
  check(l1.allowance.eq(l0.allowance) && l1.depositCount === l0.depositCount, "*** ...AND NOWHERE ELSE: L is unchanged ***", `${l0.allowance} -> ${l1.allowance}`);

  // CONTROL: a deposit under L moves L — the probe can see movement, so
  // the "unchanged" above is a measurement, not a blind instrument.
  await plantConfirmedDeposit(L.keyId, "3", "l1");
  const l2 = await read(L.keyId);
  const k2 = await read(K.keyId);
  check(l2.allowance.eq(D("3")), "CONTROL: a deposit under L moves L", `${l1.allowance} -> ${l2.allowance}`);
  check(k2.allowance.eq(k1.allowance), "CONTROL: ...and did not move K", `${k1.allowance} -> ${k2.allowance}`);

  // A DETECTED (unconfirmed) deposit counts for nothing until confirmed.
  const addr = await prisma.address.findFirst({ where: { keyId: K.keyId }, select: { id: true } });
  await prisma.deposit.create({ data: { keyId: K.keyId, addressId: addr!.id, chain: "BEP20", txHash: `0xvfyunconf${Date.now()}`, amount: D("999"), status: "detected" } });
  const k3 = await read(K.keyId);
  check(k3.allowance.eq(k2.allowance) && k3.depositCount === k2.depositCount, "an unconfirmed deposit raises NOTHING", `${k2.allowance} -> ${k3.allowance}`);
}

main()
  .catch((e) => { check(false, "the run itself threw", String(e)); })
  .finally(async () => {
    const left = await cleanupAndCount().catch((e) => { check(false, "cleanup threw", String(e)); return -1; });
    check(left === 0, "zero fixture rows left behind (counted, not assumed)", `${left} remaining`);
    const code = summary();
    await prisma.$disconnect();
    process.exit(code);
  });
