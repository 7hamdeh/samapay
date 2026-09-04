import { Hono } from "hono";
import { ApiError } from "./errors.js";
import { adminKeys } from "./routes/admin-keys.js";
import { addresses } from "./routes/addresses.js";
import { deposits } from "./routes/deposits.js";
import { withdrawals } from "./routes/withdrawals.js";
import { balance } from "./routes/balance.js";

export function buildApp(): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "samapay", version: "0.1.0" }));
  app.route("/admin", adminKeys);
  app.route("/addresses", addresses);
  app.route("/deposits", deposits);
  app.route("/withdrawals", withdrawals);
  app.route("/balance", balance);
  app.notFound((c) => c.json(new ApiError("not_found", "No such route.").toBody(), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
    // Never a stack, never a message fragment that could carry a secret.
    return c.json(new ApiError("internal", "Internal error.").toBody(), 500);
  });
  return app;
}
