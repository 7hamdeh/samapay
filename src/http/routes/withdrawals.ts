// POST /withdrawals { to, amount, chain, reference? } → 202 pending, bounded by
// the allowance; GET /withdrawals/:id → status. The reservation is taken by
// allowance.reserve INSIDE one transaction (per-key advisory lock first), the
// audit row commits with it, and only then is the id handed to the sender.
// 409 allowance_exceeded carries received/withdrawn/requested UNCLAMPED.
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { reserve, AllowanceExceeded, InvalidAmount } from "@/allowance/index.js";
import { submitForSending } from "@/sender/index.js";
import { bearerAuth, requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { positionBody } from "./balance.js";

const Body = z.object({ to: z.string().min(20).max(120), amount: z.string().regex(/^\d+(\.\d{1,6})?$/), chain: z.enum(["BEP20", "TRC20"]), reference: z.string().max(200).optional() });
export const withdrawals = new Hono();
withdrawals.use("*", bearerAuth);

withdrawals.post("/", idempotent, async (c) => {
  const key = c.get("key"); requireScope(key, "withdrawals.write");
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("invalid_input", "Body must be { to, amount (decimal string, ≤6 dp), chain, reference? }.");
  const idemKey = c.req.header("idempotency-key") as string;
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const r = await reserve(tx, { keyId: key.id, amount: parsed.data.amount, idempotencyKey: idemKey, toAddress: parsed.data.to, chain: parsed.data.chain, reference: parsed.data.reference ?? null });
      if (!r.replayed) await appendAudit(tx, { keyId: key.id, actor: "client", action: "withdrawal.requested", subjectId: r.withdrawalId, idempotencyKey: idemKey, params: { amount: parsed.data.amount, chain: parsed.data.chain, to: parsed.data.to } });
      return r;
    });
  } catch (e) {
    if (e instanceof AllowanceExceeded) throw new ApiError("allowance_exceeded", "Only money that arrived on-chain under this key can be sent.", { received: e.received, withdrawn: e.withdrawn, requested: e.requested });
    if (e instanceof InvalidAmount) throw new ApiError("invalid_input", e.message);
    throw e;
  }
  if (!result.replayed) void submitForSending(result.withdrawalId).catch(() => undefined); // the sender records its own outcome; never awaited on the request path
  // On a replay the row may have moved on (sent/failed/…): read the REAL status so a
  // retrying client never sees a stale "pending" (value-model's review finding 3).
  const status = result.replayed
    ? (await prisma.withdrawal.findUniqueOrThrow({ where: { id: result.withdrawalId }, select: { status: true } })).status
    : "pending";
  // `balance` is the position AFTER this reservation was counted — on a replay it is the CURRENT position.
  return c.json({ withdrawal: { id: result.withdrawalId, status, replayed: result.replayed }, balance: positionBody(result.position) }, 202);
});

withdrawals.get("/:id", async (c) => {
  const key = c.get("key"); requireScope(key, "withdrawals.read");
  const w = await prisma.withdrawal.findFirst({ where: { id: c.req.param("id"), keyId: key.id }, select: { id: true, chain: true, toAddress: true, amount: true, fee: true, status: true, txHash: true, reference: true, requestedAt: true, sentAt: true, resolvedAt: true } });
  if (!w) throw new ApiError("not_found", "No withdrawal with that id under this key.");
  return c.json({ withdrawal: { id: w.id, chain: w.chain, to: w.toAddress, amount: w.amount.toString(), fee: w.fee.toString(), status: w.status, tx_hash: w.txHash, reference: w.reference, requested_at: w.requestedAt, sent_at: w.sentAt, resolved_at: w.resolvedAt } }, 200);
});
