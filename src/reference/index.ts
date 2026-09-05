// THE REFERENCE FORMAT — Ibrahim, 2026-09-05, verbatim:
//
//   "SamaPay reference format: client:tenant:kind:id — e.g.
//    samaprime:samacard:user:abc123. Readable, sortable, collision-free."
//
// ⚠️ THIS IS NOT THE FORM THAT WAS PROPOSED. The recommendation carried to
// him was `m:<merchantId>/u:<userId>`, which had NOWHERE TO PUT THE CLIENT
// — a real gap the first time dahabi registers as a second client, because
// two clients could then mint the same reference. His four-part form puts
// the CLIENT FIRST, which is the model he corrected us on: SamaPay has
// CLIENTS, SamaPrime is one client with one key, and merchants are TENANTS
// underneath it. Build to his form; if any older spec text still shows the
// two-part one, it is stale.
//
// *** WHAT SAMAPAY ENFORCES, AND WHAT IT REFUSES TO KNOW. ***
// It validates the SHAPE — four segments, no delimiter inside one, none
// empty — because that is what makes his three properties TRUE rather than
// aspirational. It never interprets the SEGMENTS: `samacard` is an opaque
// string here, and SamaPay has no idea it names a merchant. Shape is ours;
// meaning is the client's.
//
// COLLISION-FREEDOM IS A THEOREM, NOT A HOPE, AND THIS IS THE PROOF:
// with the delimiter FORBIDDEN inside every segment, `join(":")` is
// injective — a string has exactly one split into four parts, so two
// distinct tuples cannot produce the same string. THAT IS THE ENTIRE
// DEFECT SURFACE OF A DELIMITED KEY, and refusing a colon is cheaper and
// more provable than escaping one. An escaping scheme would need its own
// round-trip proof and its own escape-the-escape rule; a refusal needs
// neither.

export const REFERENCE_DELIMITER = ":";
export const REFERENCE_SEGMENTS = 4;
export const MAX_SEGMENT_LENGTH = 64;

export interface ReferenceParts {
  /** The SamaPay client. `samaprime` today; `dahabi` when it registers. */
  client: string;
  /** The client's own tenant. For SamaPrime, a merchant. Opaque here. */
  tenant: string;
  /** What kind of thing the id names — `user`, `order`, `legacy`… */
  kind: string;
  /** The client's own identifier for it. Opaque here. */
  id: string;
}

export type ReferenceError =
  | "wrong_segment_count"
  | "empty_segment"
  | "segment_too_long"
  | "illegal_character";

export class InvalidReference extends Error {
  constructor(readonly reason: ReferenceError, readonly detail: string) {
    super(`Invalid reference (${reason}): ${detail}`);
    this.name = "InvalidReference";
  }
}

/** Segments may not contain the delimiter, whitespace, or control characters. */
const ILLEGAL = /[\s:\u0000-\u001f\u007f]/;

function checkSegment(name: string, value: string): void {
  if (value.length === 0) throw new InvalidReference("empty_segment", `${name} is empty`);
  if (value.length > MAX_SEGMENT_LENGTH) throw new InvalidReference("segment_too_long", `${name} is ${value.length} chars, max ${MAX_SEGMENT_LENGTH}`);
  if (ILLEGAL.test(value)) throw new InvalidReference("illegal_character", `${name} contains a delimiter, whitespace or control character`);
}

export function buildReference(parts: ReferenceParts): string {
  checkSegment("client", parts.client);
  checkSegment("tenant", parts.tenant);
  checkSegment("kind", parts.kind);
  checkSegment("id", parts.id);
  return [parts.client, parts.tenant, parts.kind, parts.id].join(REFERENCE_DELIMITER);
}

export function parseReference(reference: string): ReferenceParts {
  const segments = reference.split(REFERENCE_DELIMITER);
  if (segments.length !== REFERENCE_SEGMENTS) {
    throw new InvalidReference("wrong_segment_count", `expected ${REFERENCE_SEGMENTS} segments, got ${segments.length}`);
  }
  const [client, tenant, kind, id] = segments as [string, string, string, string];
  checkSegment("client", client);
  checkSegment("tenant", tenant);
  checkSegment("kind", kind);
  checkSegment("id", id);
  return { client, tenant, kind, id };
}

/** True iff the string is a well-formed reference. Never throws. */
export function isValidReference(reference: string): boolean {
  try { parseReference(reference); return true; } catch { return false; }
}

/**
 * The prefix that aggregates every reference for one tenant of one client,
 * for `GET /balance?reference=` style reconciliation. Trailing delimiter
 * included ON PURPOSE: without it `samaprime:sama` would also prefix-match
 * `samaprime:samacard`, and a reconciliation that silently includes a
 * different tenant is the worst failure this string has.
 */
export function tenantPrefix(client: string, tenant: string): string {
  checkSegment("client", client);
  checkSegment("tenant", tenant);
  return `${client}${REFERENCE_DELIMITER}${tenant}${REFERENCE_DELIMITER}`;
}
