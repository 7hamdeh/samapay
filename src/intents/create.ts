// createIntent() — a PaymentIntent on a FRESH derived address, or a refusal
// that created nothing.
//
// ⚠️ THE FLOOR IS CHECKED HERE TOO, NOT ONLY IN THE DERIVER. The live deriver
// (src/chain/live.ts) already refuses to derive at or below the floor; this
// module reads the floor itself and refuses to PERSIST an index at or below
// it, whatever deriver is installed. Every index ≤ floor may already be one of
// MNTAD's customers' addresses (decision #80) — two owners on one address is
// the collision SamaPrime has paid for once. Two independent refusals, so a
// swapped or buggy deriver cannot slip one through.
//
// ⚠️ THE ADDRESS'S `reference` IS `payment_intent:<pi id>`, NOT THE STORE'S
// REFERENCE. POST /v1/addresses answers an existing (key, chain, reference)
// row with THAT address; a store whose intent reference happened to equal a
// top-up reference would be handed a live intent's address as a customer's
// permanent top-up address. The intent's own row carries the store reference.
import { randomBytes } from "node:crypto";
import { Prisma, type Chain } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { appendAudit } from "@/audit/append.js";
import logger from "@/log.js";
import { chainAdapters, ChainUnavailable } from "@/chain/registry.js";
import { CryptoError, ChainRpcError } from "@/chain/impl/errors.js";
import { derivationFloor, DerivationFloorError } from "@/chain/derivation-floor.js";
import { AmountOutOfRange, DerivationUnavailable, IntentInputInvalid, IntentKeyMismatch, ReferenceInvalid, UnsupportedChain } from "./errors.js";
import { INTENT_SELECT, type IntentRow } from "./render.js";

const log = logger.child({ mod: "intents/create" });

export const EXPIRES_MIN_SEC = 300;
export const EXPIRES_MAX_SEC = 604_800;
export const EXPIRES_DEFAULT_SEC = 3_600;
/** A lost race on @@unique([chain, derivationIndex]) re-derives; this bounds it. */
const DERIVE_ATTEMPTS = 5;

const REFERENCE_RE = /^[A-Za-z0-9:_-]{1,200}$/;
// Shape only; the RANGE (min/max, > 0, ≤ 6 dp) is a separate refusal with its own code.
const AMOUNT_RE = /^\d+(\.\d+)?$/;

const Input = z.object({
  amount: z.string().regex(AMOUNT_RE),
  chain: z.enum(["BEP20", "TRC20"]),
  reference: z.string(),
  expiresInSec: z.number().int().min(EXPIRES_MIN_SEC).max(EXPIRES_MAX_SEC).optional(),
});
export type CreateIntentInput = { amount: string; chain: Chain; reference: string; expiresInSec?: number | undefined };

export function newIntentId(): string { return `pi_${randomBytes(12).toString("hex")}`; }

function isDerivationRefusal(e: unknown): boolean {
  return e instanceof DerivationFloorError || e instanceof ChainUnavailable || (e instanceof CryptoError && !(e instanceof ChainRpcError));
}

export async function createIntent(clientId: string, keyId: string, input: CreateIntentInput, now = new Date()): Promise<IntentRow> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new IntentInputInvalid([...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "body")))]);
  const { chain, reference } = parsed.data;
  const expiresInSec = parsed.data.expiresInSec ?? EXPIRES_DEFAULT_SEC;
  if (!REFERENCE_RE.test(reference)) throw new ReferenceInvalid();

  const key = await prisma.clientKey.findFirst({
    where: { id: keyId, clientId, active: true, revokedAt: null },
    select: { client: { select: { minIntent: true, maxIntent: true, enabledChains: true } } },
  });
  if (!key) throw new IntentKeyMismatch();
  const { minIntent, maxIntent, enabledChains } = key.client;

  const amount = new Prisma.Decimal(parsed.data.amount);
  if (amount.decimalPlaces() > 6 || amount.lte(0) || amount.lt(minIntent) || amount.gt(maxIntent)) {
    throw new AmountOutOfRange(parsed.data.amount, minIntent.toFixed(), maxIntent.toFixed());
  }
  if (!enabledChains.includes(chain)) throw new UnsupportedChain(chain);

  let floor: number;
  try { floor = derivationFloor(chain); }
  catch (e) { if (e instanceof DerivationFloorError) throw new DerivationUnavailable(e.message); throw e; }

  for (let attempt = 1; ; attempt++) {
    let derived;
    try { derived = await chainAdapters().deriver.deriveNext(chain); }
    catch (e) {
      if (isDerivationRefusal(e)) { log.warn({ actor: `key:${keyId}`, action: "payment_intent.create", result: "derivation_unavailable", chain, err: (e as Error).name }, "refused"); throw new DerivationUnavailable((e as Error).message); }
      throw e;
    }
    if (derived.chain !== chain || !Number.isSafeInteger(derived.derivationIndex) || derived.derivationIndex <= floor) {
      log.error({ actor: `key:${keyId}`, action: "payment_intent.create", result: "floor_violation_refused", chain, derivationIndex: derived.derivationIndex, floor }, "deriver returned an index at or below the floor");
      throw new DerivationUnavailable(`deriver returned ${derived.chain} index ${derived.derivationIndex}, not above the floor ${floor}`);
    }
    const id = newIntentId();
    try {
      const row = await prisma.$transaction(async (tx) => {
        const address = await tx.address.create({
          data: { keyId, chain, reference: `payment_intent:${id}`, address: derived.address, derivationIndex: derived.derivationIndex },
          select: { id: true },
        });
        const created = await tx.paymentIntent.create({
          data: { id, clientId, keyId, addressId: address.id, chain, amount, reference, expiresAt: new Date(now.getTime() + expiresInSec * 1000) },
          select: INTENT_SELECT,
        });
        await appendAudit(tx, { keyId, actor: "client", action: "payment_intent.created", subjectId: id, params: { chain, amount: amount.toFixed(), reference, derivationIndex: derived.derivationIndex, expiresInSec } });
        return created;
      });
      log.info({ actor: `key:${keyId}`, action: "payment_intent.create", result: "created", intentId: id, chain, derivationIndex: derived.derivationIndex }, "payment intent created");
      return row;
    } catch (e) {
      // Another derivation took this index/address between our read and our
      // insert. Nothing was committed; take the next one.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && attempt < DERIVE_ATTEMPTS) continue;
      throw e;
    }
  }
}
