import { Hono } from "hono";
import { ApiError } from "./errors.js";
import { adminKeys } from "./routes/admin-keys.js";

export function buildApp(): Hono {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true, service: "samapay", version: "0.1.0" }));
  app.route("/admin", adminKeys);
  app.notFound((c) => c.json(new ApiError("not_found", "No such route.").toBody(), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
    // Never a stack, never a message fragment that could carry a secret.
    return c.json(new ApiError("internal", "Internal error.").toBody(), 500);
  });
  return app;
}
