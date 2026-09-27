import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ApiError } from "./errors.js";
import { logger } from "@/log.js";
// ⚠️ `adminKeys` IS DELIBERATELY NOT MOUNTED — see routes/admin-keys.ts.
// Its only caller was SamaPrime's merchant-enable action, retired by the
// 2026-09-04 model correction; keys now come from the CLI (his hand).
// ⚠️ `withdrawals` IS DELIBERATELY NOT MOUNTED IN PHASE 0 (contract §4
// Balance, §10; v1.1 A9): the sender stays disabled until the vault is
// proven. No route can create a withdrawal row; scripts/verify-api-contract.ts
// proves POST /v1/withdrawals is 404 and writes nothing.
import { addresses } from "./routes/addresses.js";
import { deposits } from "./routes/deposits.js";
import { balance } from "./routes/balance.js";
import { paymentIntents } from "./routes/payment-intents.js";
import { events } from "./routes/events.js";
import { health } from "./routes/health.js";
// The merchant panel (pay.mntad.com, phase 1). Mounted only when PANEL_ENABLED
// is on — see src/panel/config.ts: a service with one database and no staging
// earns its safety by making new customer-facing reach an explicit act. When it
// is off, every /panel and /auth path answers the same 404 as any unknown route,
// so a preview host and a production host look identical from the outside.
import { panel as panelRoutes, auth as panelAuthRoutes, panelDeps, panelShell } from "./routes/panel/index.js";
import { cspHeader, isCspScoped } from "./csp.js";

export function buildApp(): Hono {
  const app = new Hono();

  // Every response carries X-Request-Id (contract §1); every error body echoes it.
  app.use("*", async (c, next) => {
    const requestId = `req_${randomBytes(12).toString("hex")}`;
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
  });

  // CSP on every /panel and /auth response — including the 401, 400, 404 and 429
  // ones, because a policy that is only on the happy path is a policy an attacker
  // reads as a map of where the header is missing. Set AFTER next() so it covers
  // whatever the router decided, and only when the route did not already carry a
  // stricter-by-omission answer of its own (the shell authorizes its inline
  // script by hash; nothing else may run a script anywhere).
  //
  // INSIDE the panel's own gate: with PANEL_ENABLED off, /panel and /auth must
  // answer the same 404 as any unknown route — a host that headers that tree and
  // no other is a host announcing where its panel will be.
  if (panelDeps().cfg.enabled) {
    app.use("*", async (c, next) => {
      await next();
      if (isCspScoped(c.req.path) && !c.res.headers.has("Content-Security-Policy")) {
        c.res.headers.set("Content-Security-Policy", cspHeader());
      }
    });
    app.route("/auth", panelAuthRoutes);
    app.route("/panel", panelRoutes);
    // Hono answers a sub-app's "/" as the bare `/panel` and 404s `/panel/`
    // (measured, hono 4.6). nginx's `location ^~ /panel/` forwards the trailing
    // slash a merchant types into the URL bar verbatim, so the shell is served
    // on both spellings instead of answering one of them with a JSON 404.
    app.get("/panel/", panelShell);
  }

  // THE CONTRACT SURFACE (contract §5): everything under /v1. The
  // pre-contract unversioned paths are gone; only /health stays unversioned
  // for process supervision.
  const v1 = new Hono();
  v1.route("/health", health);
  v1.route("/payment-intents", paymentIntents);
  v1.route("/deposits", deposits);
  v1.route("/events", events);
  v1.route("/addresses", addresses);
  v1.route("/balance", balance);
  app.route("/v1", v1);
  app.route("/health", health);

  app.notFound((c) => c.json(new ApiError("not_found", "No such route.").toBody(c.get("requestId")), 404));
  app.onError((err, c) => {
    const requestId = c.get("requestId");
    if (err instanceof ApiError) {
      if (err.code === "rate_limited" && typeof err.details?.retry_after_sec === "number") c.header("Retry-After", String(err.details.retry_after_sec));
      return c.json(err.toBody(requestId), err.status as 400);
    }
    // Logged with the request id; the client gets neither a stack nor a
    // message fragment that could carry a secret.
    logger.error({ requestId, err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, "unhandled error");
    return c.json(new ApiError("internal", "Internal error.").toBody(requestId), 500);
  });
  return app;
}
