// THE EVENT PORT — the one seam between the intents engine and src/events (G3).
//
// The agreed interface (phase-0 plan, §Interfaces):
//   enqueueEvent(tx, { type, objectKind, objectId, snapshot })
// idempotent on (objectId, type) by the events table's unique index. The
// engine calls it INSIDE the transaction that flips the intent's status, so
// the event and the transition commit together or not at all.
//
// ⚠️ UNWIRED MEANS REFUSING, NOT SILENT. Until the composition root installs
// G3's enqueueEvent with setEventSink(), every transition that would emit an
// event THROWS inside its transaction and rolls back: the intent stays where
// it was and the next tick retries. A no-op default would advance intents with
// no webhook ever written — the store would never credit a paid customer.
import type { Prisma } from "@prisma/client";
import type { IntentEventType } from "./state.js";

export interface EnqueueEventInput {
  type: IntentEventType | "deposit.confirmed";
  objectKind: "payment_intent" | "deposit";
  objectId: string;
  snapshot: Record<string, unknown>;
}
export type EnqueueEvent = (tx: Prisma.TransactionClient, input: EnqueueEventInput) => Promise<unknown>;

export class EventSinkNotWired extends Error {
  constructor() { super("intents: event sink not wired — call setEventSink(enqueueEvent) from src/events at startup"); this.name = "EventSinkNotWired"; }
}

const refusing: EnqueueEvent = async () => { throw new EventSinkNotWired(); };
let sink: EnqueueEvent = refusing;

export function setEventSink(fn: EnqueueEvent): void { sink = fn; }
export function eventSink(): EnqueueEvent { return sink; }
/** True once a real sink replaced the refusing default. The worker's boot assertion reads this. */
export function isEventSinkWired(): boolean { return sink !== refusing; }
