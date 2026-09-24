// POST /v1/addresses { chain, reference } → a per-customer top-up address
// (contract §5, v1.1 A6/A9, M-6): 201 {object:"address", chain, address,
// reference} when issued, 200 with the SAME address when (client, chain,
// reference) already has one — so a client retry cannot burn indices.
// Owned by the CLIENT (any of its keys), so a rotated key finds the same
// address. An address bound here is the only thing that can ever RAISE an
// allowance: attribution created at derivation time.
import { Hono } from "hono";
import { z } from "zod";
import { Prisma, type Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { appendAudit } from "@/audit/append.js";
import { chainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { bearerAuth, scope } from "../auth.js";
import { ApiError, fieldsOf } from "../errors.js";
import { isValidReference } from "@/reference/index.js";
import { idempotent } from "../idempotency.js";

const CHAINS = ["TRC20", "BEP20"] as const;
const Body = z.object({ chain: z.string(), reference: z.string() }).strict();

function render(a: { chain: Chain; address: string; reference: string }) {
  return { object: "address", chain: a.chain, address: a.address, reference: a.reference };
}

// An intent's address (reference "payment_intent:<pi>", G2) is never handed
// out here: the four-part format already refuses that reference, and the
// lookup excludes intent addresses as well.
function findExisting(clientId: string, chain: Chain, reference: string, db: Pick<typeof prisma, "address"> = prisma) {
  return db.address.findFirst({
    where: { key: { clientId }, chain, reference, intent: { is: null } },
    orderBy: { createdAt: "asc" },
    select: { chain: true, address: true, reference: true },
  });
}

export const addresses = new Hono();
addresses.use("*", bearerAuth);

addresses.post("/", scope("addresses.write"), idempotent, async (c) => {
  const key = c.get("key");
  const parsed = Body.safeParse(await c.req.json());
  if (!parsed.success) throw new ApiError("validation_failed", "Body must be { chain, reference }.", { fields: fieldsOf(parsed.error.issues) });
  const { chain, reference } = parsed.data;
  if (!(CHAINS as readonly string[]).includes(chain)) throw new ApiError("unsupported_chain", "chain must be TRC20 or BEP20 and enabled for this account.", { chain });
  // ⚠️ REFUSED HERE, NOT LATER. A reference is ATTRIBUTION CREATED AT
  // DERIVATION TIME and is not recomputable — a malformed one stored on an
  // address is permanent. Shape only: SamaPay never reads the segments.
  if (!isValidReference(reference)) throw new ApiError("reference_invalid", "reference must be client:tenant:kind:id — four non-empty segments, no colon, whitespace or control character inside a segment (e.g. samaprime:samacard:user:abc123).");
  const client = await prisma.client.findUnique({ where: { id: key.clientId }, select: { enabledChains: true } });
  if (!client) throw new ApiError("invalid_key", "Invalid API key.");
  if (!client.enabledChains.includes(chain as Chain)) throw new ApiError("unsupported_chain", `${chain} is not enabled for this account.`, { chain });

  const existing = await findExisting(key.clientId, chain as Chain, reference);
  if (existing) return c.json(render(existing), 200);

  let derived;
  try { derived = await chainAdapters().deriver.deriveNext(chain as Chain); }
  catch (e) {
    if (e instanceof ChainUnavailable || (e instanceof Error && e.name === "DerivationUnavailable")) {
      throw new ApiError("derivation_unavailable", "Address derivation is unavailable; nothing was created. Retry later.");
    }
    throw e;
  }
  try {
    const row = await prisma.$transaction(async (tx) => {
      // Serialise issuance per (client, chain, reference) and re-check under
      // the lock, so two concurrent requests cannot both create. G6's UNIQUE
      // (client_id, chain, reference) is the backstop (the P2002 below).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`address:${key.clientId}:${chain}:${reference}`}))`;
      const winner = await findExisting(key.clientId, chain as Chain, reference, tx);
      if (winner) return { ...winner, id: null };
      const created = await tx.address.create({ data: { keyId: key.id, clientId: key.clientId, chain: chain as Chain, reference, address: derived.address, derivationIndex: derived.derivationIndex }, select: { id: true, chain: true, address: true, reference: true } });
      await appendAudit(tx, { keyId: key.id, actor: "client", action: "address.issued", subjectId: created.id, idempotencyKey: c.req.header("idempotency-key") ?? null, params: { chain, reference, derivationIndex: derived.derivationIndex } });
      return created;
    });
    if (row.id === null) return c.json(render(row), 200); // lost the race; the derived index is burned, never reused
    logger.info({ actor: `key:${key.id}`, action: "address.issue", result: "issued", addressId: row.id, chain, requestId: c.get("requestId") }, "address issued");
    return c.json(render(row), 201);
  } catch (e) {
    // Lost the UNIQUE(client_id, chain, reference) race (G6, v1.1 A7): the
    // winner's address is the answer. The derived index is burned, never reused.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const winner = await findExisting(key.clientId, chain as Chain, reference);
      if (winner) return c.json(render(winner), 200);
    }
    throw e;
  }
});
