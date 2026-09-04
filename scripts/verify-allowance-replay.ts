// Ibrahim's acceptance test 2 — REPLAY = ONE CREDIT... in this module's
// terms: the same idempotency key reserves ONCE. A retried POST returns
// the existing row and consumes nothing more. RED-FIRST, sandbox only.
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { read, reserve, release } from "@/allowance/index.js";
import { check, summary, thrown } from "./lib/check.js";
import { D, makeKey, plantConfirmedDeposit, cleanupAndCount } from "./lib/allowance-fixture.js";

async function main() {
  console.log(`sandbox: ${await assertSandboxDatabase()}`);
  console.log("ALLOWANCE — REPLAY RESERVES ONCE\n");
  const K = await makeKey("r");
  await plantConfirmedDeposit(K.keyId, "10", "r1");
  const idem = `idem-${Date.now()}`;
  const input = { keyId: K.keyId, amount: "4", idempotencyKey: idem, toAddress: "0x" + "a".repeat(40), chain: "BEP20" as const };

  const first = await prisma.$transaction((tx) => reserve(tx, input));
  check(!first.replayed && first.position.withdrawn.eq(D("4")) && first.position.allowance.eq(D("6")), "first reserve consumes 4", `withdrawn ${first.position.withdrawn}, allowance ${first.position.allowance}`);

  const second = await prisma.$transaction((tx) => reserve(tx, input));
  check(second.replayed && second.withdrawalId === first.withdrawalId, "*** the same idempotency key returns the SAME row, flagged replayed ***", `${first.withdrawalId} === ${second.withdrawalId}`);
  const after = await read(K.keyId);
  check(after.withdrawn.eq(D("4")) && after.withdrawalCount === 1, "*** ...and consumed NOTHING more: one row, withdrawn still 4 ***", `withdrawn ${after.withdrawn} over ${after.withdrawalCount} row(s)`);

  // A DIFFERENT key with the same idempotency string is a different request.
  const third = await prisma.$transaction((tx) => reserve(tx, { ...input, idempotencyKey: `${idem}-2` }));
  check(!third.replayed && third.withdrawalId !== first.withdrawalId, "CONTROL: a different idempotency key is a new reservation", `withdrawn now ${third.position.withdrawn}`);

  // Release restores; a second release of the same reservation is refused by its own class.
  await prisma.$transaction((tx) => release(tx, third.reservationId, "verify: release"));
  const released = await read(K.keyId);
  check(released.withdrawn.eq(D("4")) && released.allowance.eq(D("6")), "release of a pending reservation restores exactly its amount", `allowance ${released.allowance}`);
  const again = await thrown(() => prisma.$transaction((tx) => release(tx, third.reservationId, "verify: twice")));
  check(again.name === "NotReleasable", "releasing it twice is refused BY NotReleasable", `got ${again.name}`);
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
