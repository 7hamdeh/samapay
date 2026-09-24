// The refusals createIntent() can answer with. Each maps to exactly one row of
// the contract's error table (§6), so the HTTP layer (G1) translates by class
// and never by message text. Every one of them means NOTHING WAS CREATED: no
// address row, no intent row, no audit row.

/** 503 derivation_unavailable — seed missing/locked, or the index floor unset/invalid, or the deriver refused. */
export class DerivationUnavailable extends Error {
  constructor(readonly reason: string) { super(`derivation unavailable: ${reason}`); this.name = "DerivationUnavailable"; }
}

/** 422 amount_out_of_range — outside the client's [min_intent, max_intent], ≤ 0, or more than 6 decimals. */
export class AmountOutOfRange extends Error {
  constructor(readonly amount: string, readonly min: string, readonly max: string) {
    super(`amount ${amount} is outside [${min}, ${max}] or has more than 6 decimals`);
    this.name = "AmountOutOfRange";
  }
}

/** 422 unsupported_chain — the chain is not in the client's enabled_chains. */
export class UnsupportedChain extends Error {
  constructor(readonly chain: string) { super(`chain ${chain} is not enabled for this client`); this.name = "UnsupportedChain"; }
}

/** 422 reference_invalid — length or characters. */
export class ReferenceInvalid extends Error {
  constructor() { super("reference must be 1-200 characters of [A-Za-z0-9:_-]"); this.name = "ReferenceInvalid"; }
}

/** 400 validation_failed — the input does not have the contract's shape. `fields` names what is wrong. */
export class IntentInputInvalid extends Error {
  constructor(readonly fields: string[]) { super(`invalid payment intent input: ${fields.join(", ")}`); this.name = "IntentInputInvalid"; }
}

/** The key is not an active key of the client. The HTTP layer never reaches this (auth resolved both); a caller bug otherwise. */
export class IntentKeyMismatch extends Error {
  constructor() { super("key is not an active key of this client"); this.name = "IntentKeyMismatch"; }
}
