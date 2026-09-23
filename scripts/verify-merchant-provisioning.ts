// COVERS: src/keys/provision.ts src/keys/issue.ts scripts/issue-key.ts
//
// S2 slice 1, step 1 — RED-FIRST. "One Client per MERCHANT (pre-provisioned
// merchant account), one live ClientKey per client with webhookUrl +
// webhookSecret; plaintext printed ONCE by the CLI." (spec, Actors.)
//
// Kind used here is `partner`: the generated Prisma client in this worktree
// predates the `merchant` enum value (prisma generate is guard-refused this
// session). The rules under test are kind-agnostic by construction.
import crypto from "node:crypto";
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

import { spawnSync } from "node:child_process";
import { assertSandboxDatabase } from "@/db/guard.js";
import { prisma } from "@/db/client.js";
import { revokeKey } from "@/keys/issue.js";
import { provisionClientKey, ProvisionError } from "@/keys/provision.js";
import { check, summary, thrown } from "./lib/check.js";

const RUN = Date.now().toString(36);
const HOOK = "https://store.example/api/webhooks/samapay/cred";
const code = (r: { err?: unknown }) => (r.err instanceof ProvisionError ? r.err.code : `not a ProvisionError: ${String(r.err)}`);

async function main() {
  console.log(`database: ${await assertSandboxDatabase()}`);
  const name = `verify-merchant-${RUN}`;
  const base = { kind: "partner" as const, keyName: "gateway", scopes: ["deposits.read"], issuedBy: "verify", webhookUrl: HOOK };
  try {
    // 1. a new merchant name creates exactly one client and one live key with a secret
    const a = await provisionClientKey({ ...base, clientName: name });
    const clients1 = await prisma.client.count({ where: { name } });
    check(a.client.created && clients1 === 1 && a.key.plaintext.startsWith("sk_live_") && !!a.key.webhookSecret, "1. a new merchant → one new client + one live key + a webhook secret", `created=${a.client.created} clients=${clients1}`);

    // 2. the same merchant again: SAME client, and a second live webhook key is REFUSED, nothing written
    const keysBefore = await prisma.clientKey.count({ where: { clientId: a.client.id } });
    const dup = await thrown(() => provisionClientKey({ ...base, clientName: name }));
    const keysAfter = await prisma.clientKey.count({ where: { clientId: a.client.id } });
    const clients2 = await prisma.client.count({ where: { name } });
    check(code(dup) === "live_webhook_key_exists" && keysBefore === keysAfter && clients2 === 1, "2. one live webhook key per client: a second is refused; no key, no second client", `${code(dup)} keys ${keysBefore}→${keysAfter} clients=${clients2}`);

    // 3. revoke the first → a replacement can be provisioned for the SAME client (rotation by hand)
    await revokeKey(a.key.id, "verify", "rotation test");
    const b = await provisionClientKey({ ...base, clientName: name });
    check(!b.client.created && b.client.id === a.client.id && b.key.id !== a.key.id, "3. after revoking, a replacement key lands on the SAME client", `sameClient=${b.client.id === a.client.id}`);

    // 3b. a TEST-environment key does not count against the one-LIVE-key rule
    const t = await provisionClientKey({ ...base, clientName: name, environment: "test" });
    check(t.key.plaintext.startsWith("sk_test_"), "3b. a test key is not blocked by the live key");

    // 4. an ambiguous name (two clients) is refused; --client-id selects exactly
    const twin = await prisma.client.create({ data: { name, kind: "partner" }, select: { id: true } });
    const amb = await thrown(() => provisionClientKey({ ...base, clientName: name, webhookUrl: `${HOOK}-x` }));
    check(code(amb) === "client_ambiguous", "4. two clients with the same name → refused as ambiguous", code(amb));
    const byId = await provisionClientKey({ ...base, clientId: twin.id });
    check(byId.client.id === twin.id && !byId.client.created, "4b. --client-id picks exactly that client", byId.client.id);
    const ghost = await thrown(() => provisionClientKey({ ...base, clientId: "no-such-client" }));
    check(code(ghost) === "client_not_found", "4c. an unknown --client-id is refused", code(ghost));

    // 5. kind mismatch with an existing client is refused (no silent reuse under the wrong kind)
    const mism = await thrown(() => provisionClientKey({ ...base, kind: "platform", clientId: twin.id, environment: "test" }));
    check(code(mism) === "client_kind_mismatch", "5. an existing client of another kind is refused", code(mism));

    // 6. the CLI refuses to print a key or secret anywhere but a TTY — and writes NOTHING first
    const before = await prisma.client.count();
    const cli = spawnSync("./node_modules/.bin/tsx", ["scripts/issue-key.ts", "--client", `cli-${name}`, "--kind", "partner", "--name", "gateway", "--scopes", "deposits.read", "--by", "verify", "--webhook-url", HOOK], { env: process.env, encoding: "utf8" });
    const after = await prisma.client.count();
    check(cli.status === 1 && /REFUSING: stdout is not a TTY/.test(cli.stderr) && !/sk_live_|whsec_/.test(cli.stdout + cli.stderr) && before === after, "6. the CLI refuses a non-TTY stdout before touching the database; no key material printed", `exit=${cli.status} clients ${before}→${after} stderr=${cli.stderr.trim().split("\n")[0]}`);
  } catch (err) {
    check(false, "THE SUITE THREW — nothing below this point ran", String(err instanceof Error ? err.stack : err));
  } finally {
    await prisma.$disconnect();
  }
  process.exit(summary());
}
main().catch((e) => { console.error("verify-merchant-provisioning crashed:", e); process.exit(1); });
