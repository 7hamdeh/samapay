// Token buckets for the panel's unauthenticated and semi-authenticated routes.
//
// WHY THIS EXISTS SEPARATELY FROM src/http/auth.ts: that bucket is per API KEY
// and protects argon2 work on a 200-bit secret. A panel faces humans on shared
// NATs, over email codes an attacker can neither see nor grind quickly, and the
// thing being protected is (a) an argon2 hash per code attempt, (b) an SMTP
// send per "resend", (c) the whole point of a 6-digit code. Different budget,
// different keys, same shape — a refill-rate bucket with a named capacity.
//
// THE NUMBERS, AND WHERE THEY COME FROM:
//  · sign_in request  per email: 5 / 15 min  — the "one mistyped address, then
//    four real retries" budget for a person who fatigued the wrong tab.
//  · code verify      per email: 5 / 15 min  — PANEL_CODE_MAX_ATTEMPTS on the
//    code row is the per-code rule; this is the per-address rule that stops an
//    attacker from spraying one address's inbox while codes rotate.
//  · code send        per IP:     10 / 15 min — one person per IP plus nine for
//    an office behind one NAT, per fifteen minutes, is enough that a real
//    customer never notices the cap and a script does immediately.
//  · handoff consume  per IP:      10 / 15 min — a handoff is one click per
//    merchant; 10 covers a reload-happy operator on a bad connection.
//  · panel mutation   per account: 30 / 1 min — key create/revoke/webhook set
//    are all "a human clicking, occasionally twice by accident".
//  · second factor    per account:  5 / 15 min — turning 2FA OFF. The thing
//    being guessed is a 6-digit code valid for 3 steps (±1), so 5 tries is
//    15 in 10^6 per window: a hijacked session cannot grind its way out of the
//    second factor, which is the entire reason the factor is asked for here.
// An account-level brake at 20 failures / 15 min is the stolen-cookie detector
// (a 32-byte base64url session id is not guessable; the point is to notice
// somebody TRYING, and 20 in 15 min is above what one flaky browser tab does).
export type BucketKind = "sign_in_request" | "code_verify" | "code_send" | "handoff_consume" | "panel_mutation" | "account_failure" | "webhook_test" | "second_factor";

type Rule = Readonly<{ capacity: number; refillPerSec: number; windowSec: number }>;

const RULES: Record<BucketKind, Rule> = {
  sign_in_request:  { capacity: 5,  refillPerSec: 5 / 900,  windowSec: 900 },
  code_verify:      { capacity: 5,  refillPerSec: 5 / 900,  windowSec: 900 },
  code_send:        { capacity: 10, refillPerSec: 10 / 900, windowSec: 900 },
  handoff_consume:  { capacity: 10, refillPerSec: 10 / 900, windowSec: 900 },
  panel_mutation:   { capacity: 30, refillPerSec: 30 / 60,  windowSec: 60 },
  second_factor:    { capacity: 5,  refillPerSec: 5 / 900,  windowSec: 900 },
  account_failure:  { capacity: 20, refillPerSec: 20 / 900, windowSec: 900 },
  // One signed POST to a merchant-chosen address per key per minute (pay-dashboard.md
  // B.6 step 12): enough for a human to check their receiver twice, not enough to
  // use the dispatcher as a scanner.
  webhook_test:     { capacity: 1,  refillPerSec: 1 / 60,   windowSec: 60 },
};

export type RateDecision = Readonly<{ ok: true; remaining: number } | { ok: false; retryAfterSec: number }>;

export interface BucketStore {
  /** Atomic take: refill by elapsed time, spend one if affordable. */
  take(key: string, rule: Rule, nowSec: number): RateDecision;
}

export function ruleFor(kind: BucketKind): Rule {
  return RULES[kind];
}

export function bucketKey(kind: BucketKind, subject: string): string {
  return `${kind}:${subject}`;
}

/** In-process store. Correct for ONE API process, which is what runs today
 *  (ecosystem.config.cjs instances:1) — the same honest caveat
 *  src/http/auth.ts:103-133 carries. Survives nothing: a restart forgets the
 *  buckets, which is why every number above is a throttle, not a lockout. */
export class MemoryBucketStore implements BucketStore {
  #rows = new Map<string, { tokens: number; lastRefillSec: number }>();
  take(key: string, rule: Rule, nowSec: number): RateDecision {
    const row = this.#rows.get(key) ?? { tokens: rule.capacity, lastRefillSec: nowSec };
    const refilled = Math.min(rule.capacity, row.tokens + (nowSec - row.lastRefillSec) * rule.refillPerSec);
    if (refilled < 1) {
      this.#rows.set(key, { tokens: refilled, lastRefillSec: nowSec });
      const needed = 1 - refilled;
      const retryAfterSec = Math.max(1, Math.ceil(needed / rule.refillPerSec));
      return { ok: false, retryAfterSec };
    }
    this.#rows.set(key, { tokens: refilled - 1, lastRefillSec: nowSec });
    return { ok: true, remaining: Math.floor(refilled - 1) };
  }
  /** Test seam: drop one bucket so an assertion can start from a known state. */
  reset(key: string): void { this.#rows.delete(key); }
  clear(): void { this.#rows.clear(); }
}

/** Guard for the callers: one place decides what "limited" looks like. */
export function enforce(store: BucketStore, kind: BucketKind, subject: string, nowSec = Math.floor(Date.now() / 1000)): RateDecision {
  return store.take(bucketKey(kind, subject), ruleFor(kind), nowSec);
}
