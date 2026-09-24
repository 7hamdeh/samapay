// GET /v1/health — no key (contract §5, v1.1 A2/A9):
//   { ok, observer_lag_blocks:{TRC20,BEP20}, vault:"proven|unproven",
//     derivation:"ready|unavailable", legacy_watch:{TRC20: iso|null, BEP20: iso|null} }
// The READERS belong to their owners — observer lag and legacy watch to G2,
// vault and derivation to G4 (wired below). Until G2's land (setHealthReaders)
// lag answers unknown (null), never an optimistic number, and legacy_watch
// is read from scan_cursors directly.
// MNTAD's start-legacy-scanner reads `legacy_watch` and refuses while it is
// set, so a reader failure must never read as "not watching": it makes the
// whole answer ok:false, and that field is left out rather than null.
import { Hono } from "hono";
import type { Chain } from "@prisma/client";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { derivationStatus, vaultStatus } from "@/chain/seed/vault-proof.js";

// G4's readers decrypt the seed row to prove it; /health is unauthenticated,
// so a caller must not be able to make every request pay that cost. Cached
// for a few seconds — a status that is 10 s stale is still the truth an
// operator needs, and it never reports better than the last real read.
const SEED_STATUS_TTL_MS = 10_000;
function cached<T>(f: () => Promise<T>): () => Promise<T> {
  let at = 0; let value: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (!value || now - at > SEED_STATUS_TTL_MS) { at = now; value = f(); value.catch(() => { value = null; }); }
    return value;
  };
}

type PerChain<T> = Record<Chain, T>;
export interface HealthReaders {
  observerLagBlocks(): Promise<PerChain<number | null>>;
  vault(): Promise<"proven" | "unproven">;
  derivation(): Promise<"ready" | "unavailable">;
  legacyWatch(): Promise<PerChain<Date | null>>;
}

let readers: HealthReaders = {
  async observerLagBlocks() { return { TRC20: null, BEP20: null }; },
  vault: cached(vaultStatus),           // G4
  derivation: cached(derivationStatus), // G4
  // Read straight from G6's column until G2's reader is wired: the stamp IS the fact.
  async legacyWatch() {
    const rows = await prisma.scanCursor.findMany({ select: { chain: true, legacyWatchEnabledAt: true } });
    const out: PerChain<Date | null> = { TRC20: null, BEP20: null };
    for (const r of rows) out[r.chain] = r.legacyWatchEnabledAt;
    return out;
  },
};
/** Wiring point for G2's / G4's readers (and for the verify script's fakes). */
export function setHealthReaders(next: Partial<HealthReaders>): void { readers = { ...readers, ...next }; }

async function settle<T>(name: string, f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await f() }; }
  catch (e) { logger.warn({ actor: "health", action: `health.${name}`, result: "reader_failed", err: e instanceof Error ? e.message : String(e) }, "health reader failed"); return { ok: false }; }
}

export const health = new Hono();
health.get("/", async (c) => {
  const [lag, vault, derivation, legacy] = await Promise.all([
    settle("observer_lag_blocks", readers.observerLagBlocks),
    settle("vault", readers.vault),
    settle("derivation", readers.derivation),
    settle("legacy_watch", readers.legacyWatch),
  ]);
  const body: Record<string, unknown> = {
    ok: lag.ok && vault.ok && derivation.ok && legacy.ok,
    observer_lag_blocks: lag.ok ? lag.value : { TRC20: null, BEP20: null },
    vault: vault.ok ? vault.value : "unproven",
    derivation: derivation.ok ? derivation.value : "unavailable",
  };
  if (legacy.ok) body.legacy_watch = { TRC20: legacy.value.TRC20?.toISOString() ?? null, BEP20: legacy.value.BEP20?.toISOString() ?? null };
  return c.json(body, 200);
});
