// THE HAND. Creates (or selects) a client and issues a key from the CLI —
// the only path that can mint `keys.issue`, and the only path that provisions
// a merchant account (decision #80: one client + one live key per merchant).
// Runs against whatever DATABASE_URL is set; against production that is
// Ibrahim's keystroke.
//
// A merchant's gateway key (S2 slice 1):
//   pnpm exec tsx --env-file=.env scripts/issue-key.ts --client "SamaPrime" --kind merchant \
//     --name "mntad gateway" --by ibrahim \
//     --webhook-url "http://127.0.0.1:3033/api/webhooks/samapay/<credentialId>"
//   (--scopes defaults to the merchant set below; --client-id <id> selects an
//    existing client exactly; --env test for a test key)
//
// ⚠️ REFUSES UNLESS STDOUT IS A TTY. The API key and the webhook secret are
// printed ONCE and never stored in readable form; a pipe, a `> file` or an
// agent's captured stdout would put them somewhere permanent while this script
// behaved exactly as designed. Same mechanism as generate-master-seed.ts.
import type { ClientKind, KeyEnvironment } from "@prisma/client";

export const MERCHANT_DEFAULT_SCOPES = ["payment_intents.write", "payment_intents.read", "deposits.read", "balance.read"];

function arg(name: string, required = true): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (required && !v) { console.error(`missing --${name}`); process.exit(2); }
  return v;
}

async function main() {
  if (!process.stdout.isTTY) {
    console.error("REFUSING: stdout is not a TTY. The API key and webhook secret must never reach a pipe, a file, or a captured transcript.");
    console.error("Run this directly in your terminal, not through a tool, a pipe, or an agent.");
    process.exit(1);
  }
  // Imported only after the TTY check: nothing touches the database first.
  const { prisma } = await import("@/db/client.js");
  const { provisionClientKey } = await import("@/keys/provision.js");
  const clientId = arg("client-id", false);
  const clientName = clientId ? undefined : (arg("client") as string);
  const kind = (arg("kind", false) ?? "merchant") as ClientKind;
  const name = arg("name") as string;
  const scopesArg = arg("scopes", false);
  const scopes = scopesArg ? scopesArg.split(",").map((s) => s.trim()) : kind === ("merchant" as ClientKind) ? MERCHANT_DEFAULT_SCOPES : (arg("scopes") as string).split(",");
  const by = arg("by") as string;
  const environment = (arg("env", false) ?? "live") as KeyEnvironment;
  const webhookUrl = arg("webhook-url", false) ?? null;
  const db = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  console.log(`database: ${db[0]?.db}`);
  const { client, key } = await provisionClientKey({ ...(clientId ? { clientId } : { clientName: clientName as string }), kind, keyName: name, scopes, issuedBy: by, environment, webhookUrl });
  console.log(`client ${client.id} (${client.kind}${client.created ? ", created now" : ", existing"}) "${client.name}"\nkey id ${key.id}\nprefix ${key.keyPrefix}  last4 ${key.keyLast4}  scopes ${key.scopes.join(",")}\nwebhook ${webhookUrl ?? "(none)"}\n`);
  console.log(`API KEY (shown once, never stored):\n${key.plaintext}\n`);
  if (key.webhookSecret) console.log(`WEBHOOK SECRET (shown once, stored only encrypted):\n${key.webhookSecret}\n`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
