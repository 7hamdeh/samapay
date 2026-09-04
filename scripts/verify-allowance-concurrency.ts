// The clause that was earned by a measured race in SamaPrime the night
// before this module existed: two reservations against ONE unit of a
// key's allowance → EXACTLY one wins. Never "at most one" — zero
// satisfies that and proves nothing. RED-FIRST (delete the advisory lock
// in reserve() and this goes red: won=2, allowance −unit). Sandbox only.
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { read, reserve, AllowanceExceeded } from "@/allowance/index.js";
import { check, summary } from "./lib/check.js";
import { D, makeKey, plantConfirmedDeposit, cleanupAndCount } from "./lib/allowance-fixture.js";

async function main() {
  console.log(`sandbox: ${await assertSandboxDatabase()}`);
  console.log("ALLOWANCE — CONCURRENCY: EXACTLY ONE OF TWO WINS ONE UNIT\n");
  const K = await makeKey("c");
  await plantConfirmedDeposit(K.keyId, "7", "c1");
  check((await read(K.keyId)).allowance.eq(D("7")), "CONTROL: exactly one unit (7) of allowance to race for", "");

  for (let round = 1; round <= 3; round += 1) {
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => reserve(tx, { keyId: K.keyId, amount: "7", idempotencyKey: `c-${round}-a`, toAddress: "0x" + "1".repeat(40), chain: "BEP20" })),
      prisma.$transaction((tx) => reserve(tx, { keyId: K.keyId, amount: "7", idempotencyKey: `c-${round}-b`, toAddress: "0x" + "2".repeat(40), chain: "BEP20" })),
    ]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lostByRule = results.filter((r) => r.status === "rejected" && r.reason instanceof AllowanceExceeded).length;
    const other = results.filter((r) => r.status === "rejected" && !(r.reason instanceof AllowanceExceeded)).map((r) => String((r as PromiseRejectedResult).reason).slice(0, 80));
    const pos = await read(K.keyId);
    check(won === 1, `round ${round}: *** EXACTLY ONE of two concurrent reservations won ***`, `won=${won}`);
    check(lostByRule === 1, `round ${round}: ...and the loser was refused BY AllowanceExceeded`, `lostByRule=${lostByRule} other=${JSON.stringify(other)}`);
    check(pos.allowance.eq(0) && pos.withdrawn.eq(D("7")), `round ${round}: ...and the allowance is exactly zero, never negative`, `withdrawn ${pos.withdrawn}, allowance ${pos.allowance}`);
    // reset for the next round: cancel the winner
    await prisma.withdrawal.updateMany({ where: { keyId: K.keyId, status: "pending" }, data: { status: "cancelled" } });
    await prisma.reservation.updateMany({ where: { keyId: K.keyId, status: "held" }, data: { status: "released", reason: "verify round reset" } });
  }
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
