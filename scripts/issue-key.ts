// THE HAND. Creates a client (if needed) and issues a key from the CLI —
// the only path that can mint `keys.issue`. Runs against whatever
// DATABASE_URL is set; against production that is Ibrahim's keystroke.
//   pnpm exec tsx --env-file=.env scripts/issue-key.ts --client "SamaPrime" --kind platform \
//     --name "samaprime admin" --scopes keys.issue --by ibrahim [--env test]
import { prisma } from "@/db/client.js";
import { issueKey } from "@/keys/issue.js";
import type { ClientKind, KeyEnvironment } from "@prisma/client";

function arg(name: string, required = true): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (required && !v) { console.error(`missing --${name}`); process.exit(2); }
  return v;
}
async function main() {
  const clientName = arg("client") as string;
  const kind = (arg("kind") as ClientKind);
  const name = arg("name") as string;
  const scopes = (arg("scopes") as string).split(",").map((s) => s.trim());
  const by = arg("by") as string;
  const environment = (arg("env", false) ?? "live") as KeyEnvironment;
  const db = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  console.log(`database: ${db[0]?.db}`);
  const client = (await prisma.client.findFirst({ where: { name: clientName }, select: { id: true } }))
    ?? (await prisma.client.create({ data: { name: clientName, kind }, select: { id: true } }));
  const issued = await issueKey({ clientId: client.id, name, scopes, environment, issuedBy: by, issuedVia: "cli" });
  console.log(`client ${client.id}\nkey id ${issued.id}\nprefix ${issued.keyPrefix}  last4 ${issued.keyLast4}  scopes ${issued.scopes.join(",")}\n\nPLAINTEXT (shown once, never stored):\n${issued.plaintext}\n`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
