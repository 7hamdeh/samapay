// EVENTS — the one place an `events` row and its webhook delivery are born.
//
//   enqueueEvent(tx, {type, objectKind, objectId, snapshot})
//     Call it INSIDE the transaction that makes the state change, so the event
//     exists iff the change committed. EXACTLY ONE event per (objectId, type)
//     is STRUCTURAL: UNIQUE(object_id, type) + INSERT … ON CONFLICT DO NOTHING.
//     A concurrent second caller blocks on the first's uncommitted row, then
//     inserts nothing and reads the winner's id — no error, no second delivery.
//
//   getEvent(clientId, id) → the envelope, or null for an unknown id AND for
//     another client's event (the route answers 404 for both; no oracle).
//
// ⚠️ deposit.confirmed IS EMITTED FOR EVERY CONFIRMED DEPOSIT (contract v1.1
// A1) — intent addresses included, with data.object.payment_intent_id set:
// the store credits per DEPOSIT, so a late, over, under or post-success
// payment is never lost. payment_intent.* is status only. Two exceptions,
// both "SamaPay does not own this address's money stream":
//   - a watch-DISABLED address (§9 step 0);
//   - a legacy_import address on a chain whose legacy watch is not enabled
//     yet (scan_cursors.legacy_watch_enabled_at NULL): MNTAD's scanner still
//     credits it, and a second notification would be a second rail.
// That rule lives HERE, not in the caller, so no caller can forget it.
//
// events.object_id holds the PUBLIC id: "pi_…" for an intent, "dep_<row id>"
// for a deposit — the id the envelope's data.object.id carries.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { API_VERSION, buildEnvelope, EnqueueEventInput, newEventId, type EventEnvelope, type EventType } from "./envelope.js";

export { API_VERSION, EVENT_TYPES, type EventEnvelope, type EventType, type ObjectKind } from "./envelope.js";

const log = logger.child({ module: "events" });

export class EventObjectNotFound extends Error {
  constructor(kind: string, id: string) { super(`${kind} ${id} does not exist`); this.name = "EventObjectNotFound"; }
}

export type SuppressReason = "watch_disabled" | "legacy_not_watched";
export type EnqueueResult =
  | { status: "created" | "existing"; eventId: string; deliveryId: string }
  | { status: "suppressed"; reason: SuppressReason };

/** Why a deposit.confirmed for this deposit must not exist, or null if it may. */
export async function depositEventSuppression(db: Prisma.TransactionClient, depositRowId: string): Promise<SuppressReason | null> {
  const d = await db.deposit.findUnique({ where: { id: depositRowId }, select: { chain: true, address: { select: { watchDisabledAt: true, legacyImport: true } } } });
  if (!d) throw new EventObjectNotFound("deposit", `dep_${depositRowId}`);
  if (d.address.watchDisabledAt) return "watch_disabled";
  if (d.address.legacyImport) {
    const cursor = await db.scanCursor.findUnique({ where: { chain: d.chain }, select: { legacyWatchEnabledAt: true } });
    if (!cursor?.legacyWatchEnabledAt) return "legacy_not_watched";
  }
  return null;
}

/** The key whose webhook receives the event, and its client. */
async function resolveTarget(tx: Prisma.TransactionClient, kind: "payment_intent" | "deposit", objectId: string): Promise<{ keyId: string; clientId: string }> {
  if (kind === "payment_intent") {
    const pi = await tx.paymentIntent.findUnique({ where: { id: objectId }, select: { keyId: true, clientId: true } });
    if (!pi) throw new EventObjectNotFound(kind, objectId);
    return pi;
  }
  const d = await tx.deposit.findUnique({ where: { id: objectId.slice("dep_".length) }, select: { keyId: true, key: { select: { clientId: true } } } });
  if (!d) throw new EventObjectNotFound(kind, objectId);
  return { keyId: d.keyId, clientId: d.key.clientId };
}

export async function enqueueEvent(tx: Prisma.TransactionClient, raw: EnqueueEventInput): Promise<EnqueueResult> {
  const input = EnqueueEventInput.parse(raw);
  const { type, objectKind, objectId, snapshot } = input;

  if (type === "deposit.confirmed") {
    const reason = await depositEventSuppression(tx, objectId.slice("dep_".length));
    if (reason) {
      log.info({ actor: "events", action: "event.enqueue", result: "suppressed", reason, type, objectId }, "no deposit.confirmed for this address");
      return { status: "suppressed", reason };
    }
  }

  const target = await resolveTarget(tx, objectKind, objectId);
  const id = newEventId();
  const createdAt = new Date();
  const envelope = buildEnvelope(id, type, createdAt, snapshot);
  const payload = envelope as unknown as Prisma.InputJsonObject;
  const inserted = await tx.event.createMany({
    data: [{ id, clientId: target.clientId, keyId: target.keyId, type, objectKind, objectId, apiVersion: envelope.api_version, snapshot: snapshot as Prisma.InputJsonObject, createdAt }],
    skipDuplicates: true, // ON CONFLICT DO NOTHING — the unique (object_id, type) is the guarantee
  });

  if (inserted.count === 1) {
    const delivery = await tx.webhookDelivery.create({ data: { keyId: target.keyId, clientId: target.clientId, eventType: type, eventId: id, payload, nextAttemptAt: createdAt }, select: { id: true } });
    log.info({ actor: "events", action: "event.enqueue", result: "created", type, objectId, eventId: id, deliveryId: delivery.id }, "event enqueued");
    return { status: "created", eventId: id, deliveryId: delivery.id };
  }

  const existing = await tx.event.findUniqueOrThrow({ where: { objectId_type: { objectId, type } }, select: { id: true } });
  const delivery = await tx.webhookDelivery.findFirstOrThrow({ where: { eventId: existing.id }, select: { id: true } });
  log.info({ actor: "events", action: "event.enqueue", result: "existing", type, objectId, eventId: existing.id }, "event already exists");
  return { status: "existing", eventId: existing.id, deliveryId: delivery.id };
}

export async function getEvent(clientId: string, id: string): Promise<EventEnvelope | null> {
  if (typeof clientId !== "string" || typeof id !== "string" || !/^evt_[A-Za-z0-9]{1,64}$/.test(id)) return null;
  // clientId IN THE WHERE: another client's event is indistinguishable from none.
  const row = await prisma.event.findFirst({ where: { id, clientId }, select: { id: true, type: true, apiVersion: true, snapshot: true, createdAt: true } });
  if (!row) return null;
  // Rendered from the stored columns by the same builder the webhook body came
  // from, with the row's own api_version (never the current constant).
  return { ...buildEnvelope(row.id, row.type as EventType, row.createdAt, row.snapshot as Record<string, unknown>), api_version: row.apiVersion as typeof API_VERSION };
}
