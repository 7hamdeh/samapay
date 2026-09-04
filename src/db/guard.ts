// FAIL-CLOSED SANDBOX GUARD — the first statement of every verify script.
// Refuses any database whose NAME does not end in `_sandbox`. Copied as a
// contract from SamaPrime's scripts/lib/sandbox-guard.ts, which exists
// because three verify scripts there were found writing production in one
// day. Here it is present on day one, before any script exists.
import { prisma } from "./client.js";

export async function assertSandboxDatabase(): Promise<string> {
  const rows = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  const db = rows[0]?.db ?? "<unknown>";
  if (!db.endsWith("_sandbox")) {
    throw new Error(`REFUSING TO RUN — "${db}" is not a sandbox database (name must end in _sandbox). Fail-closed: no marker means refuse.`);
  }
  return db;
}
