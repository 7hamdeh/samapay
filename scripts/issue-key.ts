// THE HAND. Creates (or selects) a client and issues a key from the CLI —
// the only path that can mint `keys.issue`, and the only path that provisions
// a merchant account (decision #80: one client + one live key per merchant).
// Runs against whatever DATABASE_URL is set; against production that is
// Ibrahim's keystroke.
//
// Runbook §5 form (flags as --flag=value or --flag value):
//   pnpm exec tsx --env-file=.env scripts/issue-key.ts --client="SamaPrime" --kind=merchant --fee-bps=0 --webhook-url=<url>
//   (--name defaults to "gateway", --by to "ibrahim"; prints KEY_ID, the key and the webhook secret once)
//
// A merchant's gateway key (S2 slice 1):
//   pnpm exec tsx --env-file=.env scripts/issue-key.ts --client "SamaPrime" --kind merchant \
//     --name "mntad gateway" --by ibrahim \
//     --webhook-url "http://127.0.0.1:3033/api/webhooks/samapay/<credentialId>"
//   (--scopes defaults to the six merchant scopes, src/keys/terms.ts;
//    --client-id <id> selects an existing client exactly; --env test for a test key)
//
// ACCOUNT TERMS (Phase 0, contract §0/§5) — each flag optional; an absent flag
// leaves the client's value as it is (a new client gets the column default):
//   --fee-bps <0..10000>     merchant fee in basis points (SamaPrime: 0; default 0)
//   --min-intent <usdt>      smallest intent amount, ≤ 6 dp (default 1)
//   --max-intent <usdt>      largest intent amount, ≤ 6 dp (default 10000)
//   --chains BEP20,TRC20     chains the client may use (default both)
// Validated before anything is written; the change is audited (client.terms_set).
//
// ⚠️ REFUSES UNLESS STDOUT IS A TTY. The API key and the webhook secret are
// printed ONCE and never stored in readable form; a pipe, a `> file` or an
// agent's captured stdout would put them somewhere permanent while this script
// behaved exactly as designed. Same mechanism as generate-master-seed.ts.
import type { ClientKind, KeyEnvironment } from "@prisma/client";
import { MERCHANT_DEFAULT_SCOPES, normalizeArgv, termsFromArgv } from "@/keys/terms.js";

export { MERCHANT_DEFAULT_SCOPES };

// Both `--flag value` and `--flag=value` (the runbook's form) are accepted.
const ARGV = normalizeArgv(process.argv);
function arg(name: string, required = true): string | undefined {
  const i = ARGV.indexOf(`--${name}`);
  const v = i >= 0 ? ARGV[i + 1] : undefined;
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
  // Runbook §5 omits both: the key name defaults to "gateway", and the
  // issuer to "ibrahim" — this CLI only runs on a TTY, i.e. his hand.
  const name = arg("name", false) ?? "gateway";
  const scopesArg = arg("scopes", false);
  const scopes = scopesArg ? scopesArg.split(",").map((s) => s.trim()) : kind === ("merchant" as ClientKind) ? [...MERCHANT_DEFAULT_SCOPES] : (arg("scopes") as string).split(",");
  const by = arg("by", false) ?? "ibrahim";
  const environment = (arg("env", false) ?? "live") as KeyEnvironment;
  const webhookUrl = arg("webhook-url", false) ?? null;
  const db = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  console.log(`database: ${db[0]?.db}`);
  const terms = termsFromArgv(ARGV);
  const { client, key, terms: t } = await provisionClientKey({ ...(clientId ? { clientId } : { clientName: clientName as string }), kind, keyName: name, scopes, issuedBy: by, environment, webhookUrl, terms });
  console.log(`client ${client.id} (${client.kind}${client.created ? ", created now" : ", existing"}) "${client.name}"\nterms fee_bps ${t.feeBps}  min_intent ${t.minIntent.toString()}  max_intent ${t.maxIntent.toString()}  chains ${t.enabledChains.join(",")}\nkey id ${key.id}\nprefix ${key.keyPrefix}  last4 ${key.keyLast4}  scopes ${key.scopes.join(",")}\nwebhook ${webhookUrl ?? "(none)"}\n`);
  console.log(`KEY_ID ${key.id}\n`);
  console.log(`API KEY (shown once, never stored):\n${key.plaintext}\n`);
  if (key.webhookSecret) console.log(`WEBHOOK SECRET (shown once, stored only encrypted):\n${key.webhookSecret}\n`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
