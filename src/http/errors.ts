// One error shape for the whole API. Every failure is a typed code the
// client can branch on — never a message fragment, never a stack.
export type ApiErrorCode =
  | "unauthorized" | "insufficient_scope" | "not_found" | "invalid_input"
  | "idempotency_key_required" | "idempotency_key_in_progress" | "idempotency_payload_mismatch"
  | "allowance_exceeded" | "unsupported_chain" | "internal";

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401, insufficient_scope: 403, not_found: 404, invalid_input: 400,
  idempotency_key_required: 400, idempotency_key_in_progress: 409, idempotency_payload_mismatch: 409,
  allowance_exceeded: 409, unsupported_chain: 400, internal: 500,
};

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
  toBody(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
