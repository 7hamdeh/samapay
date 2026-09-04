// FAIL-CLOSED SANDBOX GUARD — the first statement of every verify script.
// Two checks, closing two doors: (1) the DATABASE_URL's database NAME must end
// in `_sandbox`, decided BEFORE any connection is opened, so a wrong URL
// refuses instead of erroring; (2) `current_database()` must agree, so a
// URL that lies about its name is caught by the server's own answer.
// Contract copied from SamaPrime's scripts/lib/sandbox-guard.ts, present here
// on day one.
import { prisma } from "./client.js";

export function databaseNameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null; } catch { return null; }
}

export async function assertSandboxDatabase(): Promise<string> {
  const named = databaseNameFromUrl(process.env.DATABASE_URL);
  if (!named || !named.endsWith("_sandbox")) {
    throw new Error(`REFUSING TO RUN — DATABASE_URL names "${named ?? "<none>"}", not a sandbox database (name must end in _sandbox). Refused before connecting.`);
  }
  const rows = (await prisma.$queryRawUnsafe("select current_database() as db")) as Array<{ db: string }>;
  const actual = rows[0]?.db ?? "<unknown>";
  if (actual !== named) throw new Error(`REFUSING TO RUN — connected to "${actual}" but the URL named "${named}".`);
  return actual;
}
