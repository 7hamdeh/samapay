// THE INDEX FLOOR — decision #80 (option B: ONE seed, a4434b0b, living in
// SamaPay). MNTAD derived its customers' deposit addresses from that same seed
// on the same BIP44 paths (m/44'/{60|195}'/0'/0/{index}), so any index MNTAD
// ever issued is an address that ALREADY BELONGS TO SOMEONE. SamaPay deriving
// one of them again would put two owners on one address — the collision class
// SamaPrime has paid for once (its hot wallet collided with a real user).
//
// Measured 2026-09-23 (read-only, MNTAD crypto_addresses): highest issued
// user index TRC20 112, BEP20 122. Those are pinned below. The CONFIGURED
// floor must sit at least MIN_FLOOR_MARGIN above them (MNTAD's legacy rail
// keeps issuing until it is frozen), and SamaPay never derives at or below the
// configured floor — enforced here at derivation time AND validated at boot
// (src/server.ts), so a missing or low value stops the process instead of
// being discovered as a shared address.
//
//   SAMAPAY_DERIVATION_FLOOR_TRC20=<integer ≥ 212>
//   SAMAPAY_DERIVATION_FLOOR_BEP20=<integer ≥ 222>
//
// Raising a floor later is always safe (the next index only moves up).
// LOWERING one below an index SamaPay already issued is harmless (highest + 1
// wins) but lowering it into MNTAD's range is refused by the bound below.
import type { Chain } from "@prisma/client";

export const MNTAD_MAX_ISSUED_INDEX: Readonly<Record<Chain, number>> = { TRC20: 112, BEP20: 122 };
export const MIN_FLOOR_MARGIN = 100;
const ENV_NAME: Readonly<Record<Chain, string>> = { TRC20: "SAMAPAY_DERIVATION_FLOOR_TRC20", BEP20: "SAMAPAY_DERIVATION_FLOOR_BEP20" };

export class DerivationFloorError extends Error {
  constructor(message: string) { super(message); this.name = "DerivationFloorError"; }
}

/** The configured floor for one chain. Throws unless it is a plain integer ≥ MNTAD max + margin. */
export function derivationFloor(chain: Chain): number {
  const name = ENV_NAME[chain];
  const raw = process.env[name];
  if (raw === undefined || raw === "") throw new DerivationFloorError(`${name} is not set — SamaPay refuses to derive ${chain} addresses without an index floor above MNTAD's issued range (decision #80).`);
  if (!/^\d+$/.test(raw)) throw new DerivationFloorError(`${name}=${JSON.stringify(raw)} is not a plain non-negative integer.`);
  const floor = Number(raw);
  const min = MNTAD_MAX_ISSUED_INDEX[chain] + MIN_FLOOR_MARGIN;
  if (!Number.isSafeInteger(floor) || floor < min) throw new DerivationFloorError(`${name}=${raw} is below the minimum ${min} (MNTAD's highest issued ${chain} index ${MNTAD_MAX_ISSUED_INDEX[chain]} + margin ${MIN_FLOOR_MARGIN}).`);
  return floor;
}

/** Boot check: both chains, or throw. */
export function assertDerivationFloorsConfigured(): Record<Chain, number> {
  return { TRC20: derivationFloor("TRC20"), BEP20: derivationFloor("BEP20") };
}

/** max(highest + 1, floor + 1). Refuses (throws) rather than ever returning an index ≤ floor. */
export function nextIndexAboveFloor(highest: number | null, floor: number): number {
  const next = Math.max((highest ?? -1) + 1, floor + 1);
  if (!(next > floor)) throw new DerivationFloorError(`refusing to derive at index ${next} ≤ floor ${floor}`);
  return next;
}
