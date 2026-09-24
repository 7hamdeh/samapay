// A CLIENT'S ACCOUNT TERMS (Phase 0, contract §0, §2, §5): the merchant fee,
// the intent amount bounds, the enabled chains — and the six default scopes
// of a merchant key. Set only by scripts/issue-key.ts (Ibrahim's hand);
// validated HERE with Zod so the CLI, provisioning and the verify script share
// one definition.
import { z } from "zod";
import { Prisma, type Chain } from "@prisma/client";
import { MAX_FEE_BPS } from "@/allowance/fee.js";

/** Contract §2: "The CLI's default merchant key has all six." keys.issue is never among them. */
export const MERCHANT_DEFAULT_SCOPES = [
  "payment_intents.write", "payment_intents.read", "deposits.read", "addresses.write", "balance.read", "events.read",
] as const;

// Up to 6 decimals, positive, no exponent, no sign — the contract's money string.
const MONEY = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
const money = z.string().regex(MONEY, "a positive USDT amount with at most 6 decimals").refine((s) => new Prisma.Decimal(s).greaterThan(0), "must be > 0");

export const ClientTermsInput = z
  .object({
    feeBps: z.number().int().min(0).max(MAX_FEE_BPS).optional(),
    minIntent: money.optional(),
    maxIntent: money.optional(),
    enabledChains: z.array(z.enum(["BEP20", "TRC20"])).min(1).optional(),
  })
  .strict();
export type ClientTermsInput = z.infer<typeof ClientTermsInput>;

export class TermsError extends Error {
  constructor(readonly code: "invalid_terms" | "min_above_max", message: string) { super(message); this.name = "TermsError"; }
}

/** Parses and checks a partial terms update against the terms it lands on. Returns the Prisma data (only the given fields). */
export function resolveTerms(
  input: unknown,
  current: { minIntent: Prisma.Decimal | string; maxIntent: Prisma.Decimal | string },
): { feeBps?: number; minIntent?: Prisma.Decimal; maxIntent?: Prisma.Decimal; enabledChains?: Chain[] } {
  const parsed = ClientTermsInput.safeParse(input);
  if (!parsed.success) throw new TermsError("invalid_terms", parsed.error.issues.map((i) => `${i.path.join(".") || "terms"}: ${i.message}`).join("; "));
  const t = parsed.data;
  const min = new Prisma.Decimal(t.minIntent ?? current.minIntent);
  const max = new Prisma.Decimal(t.maxIntent ?? current.maxIntent);
  if (min.greaterThan(max)) throw new TermsError("min_above_max", `min_intent ${min.toString()} is above max_intent ${max.toString()}`);
  const out: { feeBps?: number; minIntent?: Prisma.Decimal; maxIntent?: Prisma.Decimal; enabledChains?: Chain[] } = {};
  if (t.feeBps !== undefined) out.feeBps = t.feeBps;
  if (t.minIntent !== undefined) out.minIntent = min;
  if (t.maxIntent !== undefined) out.maxIntent = max;
  if (t.enabledChains !== undefined) out.enabledChains = [...new Set(t.enabledChains)] as Chain[];
  return out;
}

/** The terms flags of scripts/issue-key.ts, read from argv. A flag that is absent stays absent (no change). */
export function termsFromArgv(argv: readonly string[]): Record<string, unknown> {
  // A flag given with no value reads as "" and is REFUSED by Zod, never silently skipped.
  const val = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? (argv[i + 1] ?? "") : undefined; };
  const out: Record<string, unknown> = {};
  const fee = val("fee-bps");
  // Number("") is 0 and Number("1e2") is 100 — only plain digits reach Zod as a number.
  if (fee !== undefined) out.feeBps = /^\d+$/.test(fee) ? Number(fee) : fee;
  const min = val("min-intent"); if (min !== undefined) out.minIntent = min;
  const max = val("max-intent"); if (max !== undefined) out.maxIntent = max;
  const chains = val("chains"); if (chains !== undefined) out.enabledChains = chains.split(",").map((s) => s.trim());
  return out;
}
