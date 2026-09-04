// GET /balance → the five numbers the one rule is made of, never a sixth,
// never clamped, never rounded. Straight from allowance.read().
import { Hono } from "hono";
import { read } from "@/allowance/index.js";
import { bearerAuth, requireScope } from "../auth.js";

export function positionBody(p: Awaited<ReturnType<typeof read>>) {
  return { key_id: p.keyId, received: p.received.toString(), withdrawn: p.withdrawn.toString(), allowance: p.allowance.toString(), deposit_count: p.depositCount, withdrawal_count: p.withdrawalCount };
}
export const balance = new Hono();
balance.use("*", bearerAuth);
balance.get("/", async (c) => { const key = c.get("key"); requireScope(key, "balance.read"); return c.json({ balance: positionBody(await read(key.id)) }, 200); });
