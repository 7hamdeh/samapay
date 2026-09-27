import { createHash } from "node:crypto";

// The only email shape the panel accepts, and it is stored in this exact form
// everywhere: lower-case, trimmed. A unique index on `email` means nothing if
// "A@M.COM" and "a@m.com" are two accounts.
//
// DELIBERATELY NOT RFC 5322: this address receives a login code and nothing
// else, so the cost of a wrong accept is one bounced email and the cost of a
// wrong reject is a merchant who cannot sign in. The shape below accepts
// plus-addressing and unusual-but-real TLDs, and refuses the things that are
// never a person: spaces, multiple @, an empty local part, a bare domain.
const SHAPE = /^[^\s@,;:<>"'`){}\\]{1,64}@[^\s@,;:<>"'`){}\\.@]{1,253}\.[^\s@,;:<>"'`){}\\.@]{2,24}$/;

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isPlausibleEmail(input: string): boolean {
  const e = normalizeEmail(input);
  return e.length <= 320 && SHAPE.test(e);
}

/** Keyed on the NORMALIZED form, so a lookup by the raw typed value still
 *  finds the row a different tab created. */
export function emailLookupKey(input: string): string {
  return createHash("sha256").update(normalizeEmail(input)).digest("hex").slice(0, 32);
}
