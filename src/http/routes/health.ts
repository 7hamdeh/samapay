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
  legacyWatch(): Promise<PerChain<string | null>>; // ISO strings (G2 legacyWatchStatus)
}

let readers: HealthReaders = {
  // G2. The head read is a live RPC call: cached like the seed readers, so an
  // unauthenticated caller cannot turn /health into an RPC amplifier.
  observerLagBlocks: cached(() => observerLagBlocks()),
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

/**
 * WHICH VIEW of /health is this caller allowed to see? (owner ruling 2026-09-26)
 *
 * Public: `{"ok":true|false}` ONLY. The detailed view — `observer_lag_blocks`,
 * `vault: "proven"|"unproven"`, `derivation`, `legacy_watch` checkpoint timestamps —
 * stays loopback-only. Those fields are a reconnaissance map for a custodial gateway:
 * vault-proven tells an attacker the sender is armed, observer lag tells them when the
 * scanner is behind, legacy_watch timestamps tell them the cutover state.
 *
 * *** WHY THE PEER ADDRESS IS NOT THE TEST. *** pay.mntad.com's nginx `location ^~ /v1/`
 * proxies to 127.0.0.1:3090, so **every public request also arrives from loopback** —
 * gating on peer IP would leak the detail while looking correct, the exact "green gate
 * looking at the wrong thing" failure. The Host header survives the proxy unchanged
 * (nginx forwards the original host), so a request whose Host names a loopback
 * interface is one that reached the process directly. A shared-secret header is the
 * second, explicit door for tooling that must set Host to something else; its NAME is
 * `SAMAPAY_HEALTH_TOKEN` and its value is never logged, never returned, never defaulted.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function loopbackOnly(hostHeader: string | undefined, portless: string): boolean {
  return LOOPBACK_HOSTS.has(portless || hostHeader || "");
}

export function shouldExposeDetailedHealth(input: {
  host?: string; forwardToken?: string | null; configuredToken?: string | undefined;
}): boolean {
  const token = input.configuredToken;
  if (token && token.length >= 16 && input.forwardToken && input.forwardToken === token) return true;
  const raw = (input.host ?? "").trim().toLowerCase();
  if (!raw) return false;
  const withoutPort = raw.replace(/:\d+$/, "");
  return loopbackOnly(raw, withoutPort);
}

export const health = new Hono();
health.get("/", async (c) => {
  const detailed = shouldExposeDetailedHealth({
    host: c.req.header("host"),
    forwardToken: c.req.header("x-samapay-health-token"),
    configuredToken: process.env.SAMAPAY_HEALTH_TOKEN,
  });
  const [lag, vault, derivation, legacy] = await Promise.all([
    settle("observer_lag_blocks", readers.observerLagBlocks),
    settle("vault", readers.vault),
    settle("derivation", readers.derivation),
    settle("legacy_watch", readers.legacyWatch),
  ]);
  const ok = lag.ok && vault.ok && derivation.ok && legacy.ok;
  // PUBLIC ANSWER: one boolean, and it is still the TRUE one. The readers above run
  // exactly as before, because `ok` is what process supervision and the unversioned
  // /health poll watch — narrowing the response must not narrow the signal. (An
  // earlier cut of this function returned a constant ok for the public case: that
  // would have shown a dead scanner as healthy, which is worse than the disclosure.)
  if (!detailed) return c.json({ ok }, 200);
  const body: Record<string, unknown> = {
    ok,
    observer_lag_blocks: lag.ok ? lag.value : { TRC20: null, BEP20: null },
    vault: vault.ok ? vault.value : "unproven",
    derivation: derivation.ok ? derivation.value : "unavailable",
  };
  if (legacy.ok) body.legacy_watch = { TRC20: legacy.value.TRC20, BEP20: legacy.value.BEP20 };
  return c.json(body, 200);
});
