// Entry point. Binds 127.0.0.1 — nginx fronts it; opening it is his keystroke.
import { serve } from "@hono/node-server";
import pino from "pino";
import { buildApp } from "./http/app.js";
import { assertDerivationFloorsConfigured } from "./chain/derivation-floor.js";
import { installLiveDeriver } from "./chain/live.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
export const app = buildApp();

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  // BOOT REFUSES without a valid index floor per chain (decision #80: shared
  // seed with MNTAD). A process that cannot derive safely must not listen.
  try { log.info({ floors: assertDerivationFloorsConfigured() }, "derivation floors"); }
  catch (e) { log.fatal({ err: e instanceof Error ? e.message : String(e) }, "refusing to start"); console.error(e instanceof Error ? e.message : e); process.exit(1); }
  // ⚠️ Until this line the API process NEVER installed a live deriver: the
  // worker did (installLiveChainAdapters), the API kept the refusing stub, so
  // POST /addresses answered 503 chain_unavailable. Payment intents need a
  // fresh address per request, so the API now installs the deriver — and only
  // the deriver.
  installLiveDeriver();
  const port = Number(process.env.PORT ?? 3090);
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname }, () => log.info({ port, hostname }, "samapay listening"));
}
