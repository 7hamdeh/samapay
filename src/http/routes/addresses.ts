// POST /addresses { chain, reference } → the only thing that can ever RAISE
// an allowance: an address bound to (key, reference) at derivation time.
// Idempotent on (key, reference, chain) by construction — the same pair
// returns the same address, so a client retry cannot burn indices.
import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import { chainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { bearerAuth, requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { isValidReference } from "@/reference/index.js";
import { idempotent } from "../idempotency.js";

const Body = z.object({ chain: z.enum(["BEP20", "TRC20"]), reference: z.string().min(1).max(200) });
export const addresses = new Hono();
addresses.use("*", bearerAuth);

addresses.post("/", idempotent, async (c) => {
  const key = c.get("key"); requireScope(key, "addresses.write");
  const parsed = Body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("invalid_input", "Body must be { chain: BEP20|TRC20, reference }.");
  const { chain, reference } = parsed.data;
  // ⚠️ REFUSED HERE, NOT LATER. A reference is ATTRIBUTION CREATED AT
  // DERIVATION TIME and is not recomputable — a malformed one stored on an
  // address is permanent. Shape only: SamaPay never reads the segments.
  if (!isValidReference(reference)) throw new ApiError("invalid_input", "reference must be client:tenant:kind:id — four non-empty segments, no colon, whitespace or control character inside a segment (e.g. samaprime:samacard:user:abc123).", { reference });
  const existing = await prisma.address.findFirst({ where: { keyId: key.id, chain, reference }, select: { id: true, address: true, createdAt: true } });
  if (existing) return c.json({ address: { id: existing.id, chain, reference, address: existing.address, created_at: existing.createdAt, reused: true } }, 200);
  let derived;
  try { derived = await chainAdapters().deriver.deriveNext(chain); }
  catch (e) { if (e instanceof ChainUnavailable) return c.json({ error: { code: "chain_unavailable", message: e.message } }, 503); throw e; }
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.address.create({ data: { keyId: key.id, chain, reference, address: derived.address, derivationIndex: derived.derivationIndex }, select: { id: true, address: true, createdAt: true } });
    await appendAudit(tx, { keyId: key.id, actor: "client", action: "address.issued", subjectId: created.id, idempotencyKey: c.req.header("idempotency-key") ?? null, params: { chain, reference, derivationIndex: derived.derivationIndex } });
    return created;
  });
  return c.json({ address: { id: row.id, chain, reference, address: row.address, created_at: row.createdAt, reused: false } }, 201);
});
