// GET /deposits?since=&reference=&status= — the "+" side, read-only. Only
// `confirmed` rows count toward an allowance; `detected` is shown so a
// client can see money on its way, labelled as such.
import { Hono } from "hono";
import { prisma } from "@/db/client.js";
import { bearerAuth, requireScope } from "../auth.js";
import { ApiError } from "../errors.js";

export const deposits = new Hono();
deposits.use("*", bearerAuth);

deposits.get("/", async (c) => {
  const key = c.get("key"); requireScope(key, "deposits.read");
  const since = c.req.query("since"); const reference = c.req.query("reference"); const status = c.req.query("status");
  const sinceDate = since ? new Date(since) : null;
  if (since && Number.isNaN(sinceDate?.getTime())) throw new ApiError("invalid_input", "`since` must be an ISO-8601 timestamp.");
  if (status && !["detected", "confirmed", "orphaned"].includes(status)) throw new ApiError("invalid_input", "`status` must be detected|confirmed|orphaned.");
  const rows = await prisma.deposit.findMany({
    where: { keyId: key.id, ...(sinceDate ? { detectedAt: { gte: sinceDate } } : {}), ...(reference ? { address: { reference } } : {}), ...(status ? { status: status as "detected" | "confirmed" | "orphaned" } : {}) },
    orderBy: { detectedAt: "asc" }, take: 500,
    select: { id: true, chain: true, txHash: true, amount: true, confirmations: true, status: true, detectedAt: true, creditedAt: true, address: { select: { reference: true, address: true } } },
  });
  return c.json({ deposits: rows.map((d) => ({ id: d.id, chain: d.chain, tx_hash: d.txHash, amount: d.amount.toString(), confirmations: d.confirmations, status: d.status, reference: d.address.reference, address: d.address.address, detected_at: d.detectedAt, credited_at: d.creditedAt, counts_toward_allowance: d.status === "confirmed" })) }, 200);
});
