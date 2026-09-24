// Entry point. Binds 127.0.0.1 — nginx fronts it; opening it is his keystroke.
//
// THE API COMPOSITION ROOT. bootApi() is the only place the API's ports are
// installed (G2's createIntent, G3's getEvent) and the only place the process
// decides whether it may serve at all. It is exported so a verify script
// boots EXACTLY this path in-process (scripts/verify-api-contract.ts), rather
// than a hand-assembled copy of it that could wire something this file forgets.
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import pino from "pino";
import { buildApp } from "./http/app.js";
import { assertDerivationFloorsConfigured } from "./chain/derivation-floor.js";
import { installLiveDeriver } from "./chain/live.js";
import { createIntent } from "./intents/index.js";
import { getEvent } from "./events/index.js";
import { createIntentWired, setCreateIntent } from "./http/routes/payment-intents.js";
import { getEventWired, setGetEvent } from "./http/routes/events.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

/** Throws naming every API port that is still unwired. A process that would answer 500 on a contract route must not listen. */
export function assertApiPortsWired(): void {
  const missing = [
    ...(createIntentWired() ? [] : ["createIntent (POST /v1/payment-intents)"]),
    ...(getEventWired() ? [] : ["getEvent (GET /v1/events/:id)"]),
  ];
  if (missing.length) throw new Error(`REFUSING TO START — API port(s) not wired: ${missing.join(", ")}`);
}

export function bootApi(): Hono {
  // BOOT REFUSES without a valid index floor per chain (decision #80: shared
  // seed with MNTAD). A process that cannot derive safely must not listen.
  log.info({ floors: assertDerivationFloorsConfigured() }, "derivation floors");
  // ⚠️ Until 2026-09 the API process NEVER installed a live deriver: the
  // worker did (installLiveChainAdapters), the API kept the refusing stub, so
  // POST /addresses answered 503. Payment intents need a fresh address per
  // request, so the API installs the deriver — and only the deriver.
  installLiveDeriver();
  setCreateIntent(createIntent);
  setGetEvent(getEvent);
  assertApiPortsWired();
  return buildApp();
}

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  let app: Hono;
  try { app = bootApi(); }
  catch (e) { log.fatal({ err: e instanceof Error ? e.message : String(e) }, "refusing to start"); console.error(e instanceof Error ? e.message : e); process.exit(1); }
  const port = Number(process.env.PORT ?? 3090);
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname }, () => log.info({ port, hostname }, "samapay listening"));
}
