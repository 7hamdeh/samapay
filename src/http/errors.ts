// One error shape for the whole API — contract §6 (/root/pay-mntad-api-contract.md):
//   { "error": { "code", "message", "request_id", "details"? } }
// Every failure is a typed code the client can branch on — never a message
// fragment, never a stack.
export type ApiErrorCode =
  | "invalid_json" | "idempotency_key_required" | "validation_failed"
  | "unauthenticated" | "invalid_key" | "key_revoked"
  | "insufficient_scope" | "not_found"
  | "idempotency_payload_mismatch" | "idempotency_in_progress"
  | "amount_out_of_range" | "unsupported_chain" | "reference_invalid"
  | "rate_limited" | "derivation_unavailable" | "chain_unavailable" | "internal"
  // Outside the contract table: withdrawals are out of Phase 0, the route keeps its own code.
  | "allowance_exceeded"
  // LEGACY NAME, same wire code: routes written before the contract say
  // `invalid_input`; the client always sees `validation_failed`.
  | "invalid_input";

const STATUS: Record<ApiErrorCode, number> = {
  invalid_json: 400, idempotency_key_required: 400, validation_failed: 400, invalid_input: 400,
  unauthenticated: 401, invalid_key: 401, key_revoked: 401,
  insufficient_scope: 403, not_found: 404,
  idempotency_payload_mismatch: 409, idempotency_in_progress: 409, allowance_exceeded: 409,
  amount_out_of_range: 422, unsupported_chain: 422, reference_invalid: 422,
  rate_limited: 429,
  derivation_unavailable: 503, chain_unavailable: 503,
  internal: 500,
};
const WIRE: Partial<Record<ApiErrorCode, string>> = { invalid_input: "validation_failed" };

declare module "hono" {
  interface ContextVariableMap { requestId: string }
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
  get wireCode(): string { return WIRE[this.code] ?? this.code; }
  toBody(requestId?: string): Record<string, unknown> {
    return { error: { code: this.wireCode, message: this.message, ...(requestId ? { request_id: requestId } : {}), ...(this.details ? { details: this.details } : {}) } };
  }
}

/** `details.fields` for a 400 validation_failed, from a Zod error's issue paths. */
export function fieldsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string[] {
  return [...new Set(issues.map((i) => (i.path.length ? i.path.map(String).join(".") : "(body)")))];
}
