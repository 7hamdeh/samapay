// Where the chain implementations plug in at step 4 (the lib/crypto move, his
// maintenance window). Until then every adapter is the REFUSING stub below —
// a route that reaches the chain layer answers 503 chain_unavailable rather
// than pretending. Tests inject real doubles through setChainAdapters().
import type { Chain } from "@prisma/client";
import type { AddressDeriver, ChainObserver, TxExistenceProver, TxSender } from "./types.js";

// ⚠️⚠️ DO NOT WIRE THE DERIVER UNTIL THE `reference` FORMAT IS DECIDED.
// An address's reference is its attribution, created at derivation time and
// NOT RECOMPUTABLE — the $246.32 of unattributable SamaPrime deposits is
// that exact mistake, already paid for once. The question is with Ibrahim;
// docs/model-correction-2026-09-04.md §5 has it and the recommendation.
// Until he answers, no address may be issued — which is true by
// construction today, because the deriver below refuses.
export class ChainUnavailable extends Error {
  constructor(what: string) { super(`chain layer not wired: ${what} (step 4)`); this.name = "ChainUnavailable"; }
}
const refusingDeriver: AddressDeriver = { async deriveNext(chain: Chain) { throw new ChainUnavailable(`deriveNext(${chain})`); } };
const refusingObserver: ChainObserver = { async scan() { throw new ChainUnavailable("scan"); }, async confirmationsFor() { throw new ChainUnavailable("confirmationsFor"); } };
const refusingSender: TxSender = { async send() { throw new ChainUnavailable("send"); } };
const refusingProver: TxExistenceProver = { async exists() { throw new ChainUnavailable("exists"); } };

export interface ChainAdapters { deriver: AddressDeriver; observer: ChainObserver; sender: TxSender; prover: TxExistenceProver }
let current: ChainAdapters = { deriver: refusingDeriver, observer: refusingObserver, sender: refusingSender, prover: refusingProver };
export function chainAdapters(): ChainAdapters { return current; }
export function setChainAdapters(next: Partial<ChainAdapters>): void { current = { ...current, ...next }; }
