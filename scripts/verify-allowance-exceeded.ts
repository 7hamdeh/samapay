// Ibrahim's acceptance test 3 — OVER-ALLOWANCE REFUSED, by its own class,
// exactly-not-at-most; the fee never enters; failed keeps consuming until
// refunded WITH evidence; the figure is never clamped. RED-FIRST, sandbox.
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { read, reserve, markRefunded, AllowanceExceeded, RefundNeedsEvidence, NotRefundable } from "@/allowance/index.js";
import { check, summary, thrown } from "./lib/check.js";
import { D, makeKey, plantConfirmedDeposit, cleanupAndCount } from "./lib/allowance-fixture.js";

async function main() {
  console.log(`sandbox: ${await assertSandboxDatabase()}`);
  console.log("ALLOWANCE — OVER-ALLOWANCE IS REFUSED\n");
  const K = await makeKey("x");
  const base = { keyId: K.keyId, toAddress: "0x" + "b".repeat(40), chain: "BEP20" as const };

  // At zero, ANY amount is refused — and by the right class.
  const r0 = await thrown(() => prisma.$transaction((tx) => reserve(tx, { ...base, amount: "0.000001", idempotencyKey: "x-zero" })));
  check(r0.err instanceof AllowanceExceeded, "*** at zero, the smallest amount is refused BY AllowanceExceeded ***", `got ${r0.name}`);
  const e0 = r0.err as AllowanceExceeded;
  check(e0?.received === "0" && e0?.withdrawn === "0" && e0?.requested === "0.000001", "...and the refusal carries the three figures", `${e0?.received}/${e0?.withdrawn}/${e0?.requested}`);
  check((await prisma.withdrawal.count({ where: { keyId: K.keyId } })) === 0, "...and wrote no row", "");

  await plantConfirmedDeposit(K.keyId, "10", "x1");
  // The fee is excluded: reserving the WHOLE 10 with a fee of 1 succeeds.
  const whole = await prisma.$transaction((tx) => reserve(tx, { ...base, amount: "10", fee: "1", idempotencyKey: "x-whole" }));
  check(!whole.replayed && whole.position.allowance.eq(0), "*** the last unit is withdrawable (exactly, not at-most); the fee is not counted ***", `allowance ${whole.position.allowance}`);
  // The first unit past it is refused.
  const over = await thrown(() => prisma.$transaction((tx) => reserve(tx, { ...base, amount: "0.000001", idempotencyKey: "x-over" })));
  check(over.err instanceof AllowanceExceeded, "*** the first unit past the allowance is refused BY AllowanceExceeded ***", `got ${over.name}`);

  // A failed send KEEPS consuming until refunded with evidence.
  await prisma.withdrawal.update({ where: { id: whole.withdrawalId }, data: { status: "failed" } });
  const failedPos = await read(K.keyId);
  check(failedPos.withdrawn.eq(D("10")), "a FAILED send still consumes (under-allow is the safe direction)", `withdrawn ${failedPos.withdrawn}`);
  const noEv = await thrown(() => prisma.$transaction((tx) => markRefunded(tx, whole.withdrawalId, { checkedVia: "x", txHashesChecked: [], checkedAt: new Date().toISOString(), absentOnChain: false as unknown as true })));
  check(noEv.err instanceof RefundNeedsEvidence, "*** refunding WITHOUT on-chain absence evidence is refused BY RefundNeedsEvidence ***", `got ${noEv.name}`);
  await prisma.$transaction((tx) => markRefunded(tx, whole.withdrawalId, { checkedVia: "verify: getTransactionReceipt x2", txHashesChecked: [], checkedAt: new Date().toISOString(), absentOnChain: true }));
  const refundedPos = await read(K.keyId);
  check(refundedPos.withdrawn.eq(0) && refundedPos.allowance.eq(D("10")), "*** refunded WITH evidence restores exactly the amount ***", `allowance ${refundedPos.allowance}`);
  const ev = await prisma.withdrawal.findUnique({ where: { id: whole.withdrawalId }, select: { evidence: true, status: true } });
  check(ev?.status === "refunded" && ev?.evidence !== null, "...and the evidence is stored beside the transition", JSON.stringify(ev?.evidence).slice(0, 80));
  const twice = await thrown(() => prisma.$transaction((tx) => markRefunded(tx, whole.withdrawalId, { checkedVia: "x", txHashesChecked: [], checkedAt: new Date().toISOString(), absentOnChain: true })));
  check(twice.err instanceof NotRefundable, "refunding a refunded row is refused BY NotRefundable", `got ${twice.name}`);

  // NEVER CLAMPED: force a negative by hand and prove read() shows it.
  await prisma.withdrawal.update({ where: { id: whole.withdrawalId }, data: { status: "sent", amount: D("15") } });
  const neg = await read(K.keyId);
  check(neg.allowance.eq(D("-5")), "*** a negative allowance is SHOWN, never clamped to zero ***", `${neg.allowance}`);
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
