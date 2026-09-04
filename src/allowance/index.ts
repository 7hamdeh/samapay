// The allowance module's public surface. src/http, src/sender and the
// reconciler import ONLY from here.
export { read } from "./read.js";
export { readByReference, type ReferencePosition } from "./read-by-reference.js";
export { reserve, ALLOWANCE_LOCK_NAMESPACE, type ReserveInput, type ReserveResult } from "./reserve.js";
export { release } from "./release.js";
export { expire } from "./expire.js";
export { markRefunded, type AbsenceEvidence } from "./mark-refunded.js";
export {
  RETURNED_STATUSES,
  AllowanceError,
  AllowanceExceeded,
  InvalidAmount,
  NotReleasable,
  NotRefundable,
  RefundNeedsEvidence,
  type AllowancePosition,
} from "./types.js";
