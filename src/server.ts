// Entry point. Step 1 exposes only /health so the scaffold type-checks and
// boots; routes arrive in steps 2-5. Binds 127.0.0.1 — nginx fronts it.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
export const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, service: "samapay", version: "0.1.0" }));

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 3090);
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname }, () => log.info({ port, hostname }, "samapay listening"));
}
