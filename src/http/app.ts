import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { ApiError } from "./errors.js";
import { logger } from "@/log.js";
// ⚠️ `adminKeys` IS DELIBERATELY NOT MOUNTED IN v1 — see routes/admin-keys.ts.
// Its only caller was SamaPrime's merchant-enable action, retired by the
// 2026-09-04 model correction; keys now come from the CLI (his hand).
import { addresses } from "./routes/addresses.js";
import { deposits, depositsV1 } from "./routes/deposits.js";
import { withdrawals } from "./routes/withdrawals.js";
import { balance } from "./routes/balance.js";
import { paymentIntents } from "./routes/payment-intents.js";
import { events } from "./routes/events.js";

function health(): Record<string, unknown> {
  return { ok: true, service: "samapay", version: "0.1.0" };
}

export function buildApp(): Hono {
  const app = new Hono();

  // Every response carries X-Request-Id (contract §1); every error body echoes it.
  app.use("*", async (c, next) => {
    const requestId = `req_${randomBytes(12).toString("hex")}`;
    c.set("requestId", requestId);
    await next();
    c.res.headers.set("X-Request-Id", requestId);
  });

  // THE CONTRACT SURFACE (contract §5): everything under /v1.
  const v1 = new Hono();
  v1.get("/health", (c) => c.json(health()));
  v1.route("/payment-intents", paymentIntents);
  v1.route("/deposits", depositsV1);
  v1.route("/events", events);
  v1.route("/addresses", addresses);
  v1.route("/withdrawals", withdrawals);
  v1.route("/balance", balance);
  app.route("/v1", v1);

  // Pre-contract unversioned paths, unchanged, for existing callers.
  app.get("/health", (c) => c.json(health()));
  app.route("/addresses", addresses);
  app.route("/deposits", deposits);
  app.route("/withdrawals", withdrawals);
  app.route("/balance", balance);

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
