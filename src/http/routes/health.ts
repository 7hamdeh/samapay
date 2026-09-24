// GET /v1/health — no key (contract §5, v1.1 A2/A9):
//   { ok, observer_lag_blocks:{TRC20,BEP20}, vault:"proven|unproven",
//     derivation:"ready|unavailable", legacy_watch:{TRC20: iso|null, BEP20: iso|null} }
// The READERS belong to their owners — observer lag and legacy watch to G2
// (src/observer), vault and derivation to G4 (src/chain/seed/vault-proof) —
// and are wired below; setHealthReaders() exists for the verify script.
// MNTAD's start-legacy-scanner reads `legacy_watch` and refuses while it is
// set, so a reader failure must never read as "not watching": it makes the
// whole answer ok:false, and that field is left out rather than null.
import { Hono } from "hono";
import type { Chain } from "@prisma/client";
import { logger } from "@/log.js";
import { derivationStatus, vaultStatus } from "@/chain/seed/vault-proof.js";
import { legacyWatchStatus, observerLagBlocks } from "@/observer/index.js";
import { getChainAdapter } from "@/chain/impl/index.js";

// G4's readers decrypt the seed row to prove it; /health is unauthenticated,
// so a caller must not be able to make every request pay that cost. Cached
// for a few seconds — a status that is 10 s stale is still the truth an
// operator needs, and it never reports better than the last real read.
const STATUS_TTL_MS = 10_000;
function cached<T>(f: () => Promise<T>): () => Promise<T> {
  let at = 0; let value: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (!value || now - at > STATUS_TTL_MS) { at = now; value = f(); value.catch(() => { value = null; }); }
    return value;
  };
}

type PerChain<T> = Record<Chain, T>;
export interface HealthReaders {
  observerLagBlocks(): Promise<PerChain<number | null>>;
  vault(): Promise<"proven" | "unproven">;
  derivation(): Promise<"ready" | "unavailable">;
  legacyWatch(): Promise<PerChain<string | null>>;
}

let readers: HealthReaders = {
  // G2. The head read is a live RPC call: cached like the seed readers, so an
  // unauthenticated caller cannot turn /health into an RPC amplifier.
  observerLagBlocks: cached(() => observerLagBlocks((chain) => getChainAdapter(chain).getLatestBlock())),
  vault: cached(vaultStatus),           // G4
  derivation: cached(derivationStatus), // G4
  legacyWatch: legacyWatchStatus,       // G2
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
  if (legacy.ok) body.legacy_watch = { TRC20: legacy.value.TRC20, BEP20: legacy.value.BEP20 };
  return c.json(body, 200);
});
