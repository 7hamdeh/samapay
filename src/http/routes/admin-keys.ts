// The keys.issue surface. Held by the SamaPrime server's admin key only.
// It can issue and revoke CLIENT keys; it cannot mint another keys.issue
// key (issue.ts refuses), and it has no route that moves money.
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuth, requireScope } from "../auth.js";
import { ApiError } from "../errors.js";
import { SCOPES } from "../scopes.js";
import { issueKey, IssueKeyError, revokeKey } from "@/keys/issue.js";

const IssueBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1),
  environment: z.enum(["live", "test"]).optional(),
  webhookUrl: z.string().url().max(500).optional(),
});

export const adminKeys = new Hono();
adminKeys.use("*", bearerAuth);

adminKeys.post("/clients/:clientId/keys", async (c) => {
  const key = c.get("key");
  requireScope(key, "keys.issue");
  const parsed = IssueBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError("invalid_input", "Body must be { name, scopes[], environment?, webhookUrl? }.", { issues: parsed.error.issues.map((i) => i.message) });
  try {
    const issued = await issueKey({
      clientId: c.req.param("clientId"), name: parsed.data.name, scopes: parsed.data.scopes,
      ...(parsed.data.environment ? { environment: parsed.data.environment } : {}),
      issuedBy: `samaprime_admin:${key.keyPrefix}`, issuedVia: "samaprime_admin_action", webhookUrl: parsed.data.webhookUrl ?? null,
    });
    // The plaintext appears in exactly this response and nowhere else.
    return c.json({ key: { id: issued.id, prefix: issued.keyPrefix, last4: issued.keyLast4, scopes: issued.scopes, environment: issued.environment, plaintext: issued.plaintext } }, 201);
  } catch (e) {
    if (e instanceof IssueKeyError && e.code === "unknown_client") throw new ApiError("not_found", e.message);
    if (e instanceof IssueKeyError) throw new ApiError("insufficient_scope", e.message, { code: e.code });
    throw e;
  }
});

adminKeys.delete("/keys/:keyId", async (c) => {
  const key = c.get("key");
  requireScope(key, "keys.issue");
  const count = await revokeKey(c.req.param("keyId"), `admin:${key.keyPrefix}`, "revoked via admin action");
  if (count === 0) throw new ApiError("not_found", "No active key with that id.");
  return c.json({ revoked: true }, 200);
});
