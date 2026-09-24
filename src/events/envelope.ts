// THE EVENT ENVELOPE — contract §4, the one shape a webhook body and
// GET /v1/events/:id both carry:
//   { id: "evt_…", object: "event", api_version, type, created_at, data: { object } }
// `data.object` is the PaymentIntent or Deposit AS AT EVENT TIME: a snapshot
// the caller serialises when the state changes, stored whole, never
// re-rendered later. A receiver that wants the current state re-fetches it.
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const API_VERSION = "2026-09-24";

export const EVENT_TYPES = ["payment_intent.succeeded", "payment_intent.expired", "deposit.confirmed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type ObjectKind = "payment_intent" | "deposit";

// Each type belongs to exactly one object kind; enqueueEvent refuses a pair
// that is not in this table.
export const KIND_OF: Record<EventType, ObjectKind> = {
  "payment_intent.succeeded": "payment_intent",
  "payment_intent.expired": "payment_intent",
  "deposit.confirmed": "deposit",
};

// Public id prefixes (§4). A deposit's public id is `dep_` + its row id; an
// intent's row id already IS its public id.
const PUBLIC_ID = { payment_intent: /^pi_[A-Za-z0-9_]{1,120}$/, deposit: /^dep_[A-Za-z0-9]{1,120}$/ } as const;

export const EnqueueEventInput = z
  .object({
    type: z.enum(EVENT_TYPES),
    objectKind: z.enum(["payment_intent", "deposit"]),
    objectId: z.string().min(1).max(128),
    snapshot: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (KIND_OF[v.type] !== v.objectKind) ctx.addIssue({ code: "custom", path: ["type"], message: `${v.type} does not belong to a ${v.objectKind}` });
    if (!PUBLIC_ID[v.objectKind].test(v.objectId)) ctx.addIssue({ code: "custom", path: ["objectId"], message: `not a ${v.objectKind} public id` });
    // The snapshot must BE the object it claims to be: a snapshot of another
    // object stored under this id would be delivered as this one's state.
    if (v.snapshot.id !== v.objectId) ctx.addIssue({ code: "custom", path: ["snapshot", "id"], message: "snapshot.id must equal objectId" });
    if (v.snapshot.object !== v.objectKind) ctx.addIssue({ code: "custom", path: ["snapshot", "object"], message: "snapshot.object must equal objectKind" });
  });
export type EnqueueEventInput = z.infer<typeof EnqueueEventInput>;

export interface EventEnvelope {
  id: string;
  object: "event";
  api_version: typeof API_VERSION;
  type: EventType;
  created_at: string;
  data: { object: Record<string, unknown> };
}

/** evt_ + 24 base62 characters (~143 bits). */
export function newEventId(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  while (out.length < 24) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < 24) out += alphabet[b % 62]; // 248 = 4*62: rejection keeps it unbiased
    }
  }
  return `evt_${out}`;
}

export function buildEnvelope(id: string, type: EventType, createdAt: Date, snapshot: Record<string, unknown>): EventEnvelope {
  return { id, object: "event", api_version: API_VERSION, type, created_at: createdAt.toISOString(), data: { object: snapshot } };
}
