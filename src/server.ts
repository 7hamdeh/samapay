// Entry point. Binds 127.0.0.1 — nginx fronts it; opening it is his keystroke.
import { serve } from "@hono/node-server";
import pino from "pino";
import { buildApp } from "./http/app.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
export const app = buildApp();

if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const port = Number(process.env.PORT ?? 3090);
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname }, () => log.info({ port, hostname }, "samapay listening"));
}
