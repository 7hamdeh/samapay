// GET /v1/events/:id — contract §4/§5, READ SIDE ONLY. Lets a webhook
// receiver re-fetch an event with its own key instead of trusting a body.
// 404 for an unknown id and for another client's event alike. The envelope
// is built by G3's getEvent() (src/events); this route only scopes and maps.
import { Hono } from "hono";
import { bearerAuth, scope } from "../auth.js";
import { ApiError } from "../errors.js";

// ── G3's interface (plan §Interfaces), injected so this file never waits on it ──
export type GetEventFn = (clientId: string, id: string) => Promise<Record<string, unknown> | null>;
let getEventImpl: GetEventFn = async () => null; // wired at integration to `getEvent` from @/events
/** Wiring point for G3's getEvent (and for the verify script's fake). */
export function setGetEvent(fn: GetEventFn): void { getEventImpl = fn; }

export const events = new Hono();
events.use("*", bearerAuth);

events.get("/:id", scope("events.read"), async (c) => {
  const event = await getEventImpl(c.get("key").clientId, c.req.param("id"));
  if (!event) throw new ApiError("not_found", "No such event.");
  return c.json(event, 200);
});
