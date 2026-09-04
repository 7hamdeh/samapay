// GET /balance → the five numbers the one rule is made of, never a sixth,
// never clamped, never rounded. Straight from allowance.read().
import { Hono } from "hono";
import { read, readByReference } from "@/allowance/index.js";
import { bearerAuth, requireScope } from "../auth.js";

export function positionBody(p: Awaited<ReturnType<typeof read>>) {
  return { key_id: p.keyId, received: p.received.toString(), withdrawn: p.withdrawn.toString(), allowance: p.allowance.toString(), deposit_count: p.depositCount, withdrawal_count: p.withdrawalCount };
}
export const balance = new Hono();
balance.use("*", bearerAuth);
balance.get("/", async (c) => {
  const key = c.get("key");
  requireScope(key, "balance.read");
  const reference = c.req.query("reference");
  if (reference !== undefined) {
    // ⚠️ RECONCILIATION, NOT A BOUND. No `allowance` field here, on purpose:
    // the allowance is per KEY and there is exactly one. See
    // docs/model-correction-2026-09-04.md §3-§4.
    const p = await readByReference(key.id, reference);
    return c.json({ reference_position: { key_id: p.keyId, reference: p.reference, received: p.received.toString(), withdrawn: p.withdrawn.toString(), deposit_count: p.depositCount, withdrawal_count: p.withdrawalCount, note: "reconciliation only — the allowance is per key, not per reference" } }, 200);
  }
  return c.json({ balance: positionBody(await read(key.id)) }, 200);
});
