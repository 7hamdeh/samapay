// COVERS: src/chain/hd/derive.ts src/chain/seed/master-seed.ts
//
// STEP 4 OF THE CUTOVER SEQUENCE: the derive-and-sign round trip against the
// REAL seed, immediately before Ibrahim funds an address.
//
// ⚠️ THIS SCRIPT WRITES NOTHING AND DELETES NOTHING. Its sibling,
// verify-derive-roundtrip.ts, CREATES a disposable seed and destroys it — that
// behaviour is correct there and would be catastrophic here, which is why this
// is a separate file rather than a flag on that one. A flag would be one
// mistyped argument away from deleting the master seed.
//
// WHAT IT PROVES, and this is the whole reason it runs before any money moves:
//   · the stored seed decrypts (the two ported crypto constants are correct)
//   · an address derived from it survives a FORGET and re-derives identically
//   · the private key for that address PROVABLY corresponds to it, per chain
//
// An address we can derive but cannot sign from is an address nobody holds the
// key to. Money sent there is permanently lost, and the seed has no recovery
// path. Deriving alone would pass while proving nothing about recoverability.
import { prisma } from "@/db/client.js";
import { loadMasterSeed, wipeMasterSeedCache, seedFingerprint } from "@/chain/seed/master-seed.js";
import { deriveAddress, derivePrivateKeyForSigning } from "@/chain/hd/derive.js";
import { ethers } from "ethers";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label} — ${detail}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}

async function main() {
  // PRECONDITION: the opposite of the disposable fixture's. There must BE a
  // seed, and exactly one.
  const rows = await prisma.cryptoConfig.count();
  if (rows !== 1) {
    console.log(`[VOID] expected exactly 1 crypto_config row, found ${rows}. Nothing was tested.`);
    console.log("INCONCLUSIVE — run the generator first, or investigate why there is more than one.");
    process.exit(2);
  }

  const seed = await loadMasterSeed();
  const fp = seedFingerprint(seed);
  check(true, "stored seed DECRYPTS", `fingerprint ${fp} — the ported AAD and HKDF info are correct`);

  const nextIndex = ((await prisma.address.findFirst({ orderBy: { derivationIndex: "desc" }, select: { derivationIndex: true } }))?.derivationIndex ?? -1) + 1;
  console.log(`  next derivation index: ${nextIndex}\n`);

  const first = { BEP20: deriveAddress(seed, "BEP20", nextIndex), TRC20: deriveAddress(seed, "TRC20", nextIndex) };
  check(first.BEP20 !== first.TRC20, "control: the two chains derive DIFFERENT addresses", "equal would mean the chain argument is ignored");

  // FORGET — without this the second derivation reads the same buffer and the
  // encrypted-at-rest path is never exercised.
  wipeMasterSeedCache();
  const reloaded = await loadMasterSeed();
  check(seedFingerprint(reloaded) === fp, "seed survives FORGET and re-decrypt", `fingerprint ${seedFingerprint(reloaded)}`);

  const second = { BEP20: deriveAddress(reloaded, "BEP20", nextIndex), TRC20: deriveAddress(reloaded, "TRC20", nextIndex) };
  check(second.BEP20 === first.BEP20, "BEP20 re-derives BYTE-IDENTICAL", first.BEP20);
  check(second.TRC20 === first.TRC20, "TRC20 re-derives BYTE-IDENTICAL", first.TRC20);

  // THE HALF THAT MATTERS: can we sign?
  const msg = "samapay live derive check " + fp;
  const w = new ethers.Wallet(ethers.hexlify(derivePrivateKeyForSigning(reloaded, "BEP20", nextIndex)));
  check(w.address.toLowerCase() === first.BEP20.toLowerCase(), "BEP20 key CORRESPONDS to the address", w.address);
  const sig = await w.signMessage(msg);
  check(ethers.verifyMessage(msg, sig).toLowerCase() === first.BEP20.toLowerCase(), "BEP20 signature verifies back", "recovered signer matches");

  const tronKey = derivePrivateKeyForSigning(reloaded, "TRC20", nextIndex);
  const { default: TronWebPkg } = await import("tronweb");
  const TronWeb = (TronWebPkg as unknown as { TronWeb?: unknown }).TronWeb ?? TronWebPkg;
  const tw = new (TronWeb as new (o: unknown) => { address: { fromPrivateKey(k: string): string } })({ fullHost: "https://api.trongrid.io" });
  check(tw.address.fromPrivateKey(Buffer.from(tronKey).toString("hex")) === first.TRC20, "TRC20 key CORRESPONDS to the address", first.TRC20);

  // PROOF THAT NOTHING WAS WRITTEN — counted, not asserted in prose.
  check((await prisma.cryptoConfig.count()) === 1, "crypto_config UNCHANGED", "still exactly 1 row");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("\n══ THE TWO ADDRESSES, DERIVED AND PROVEN SIGNABLE ══");
    console.log(`  TRC20 (send first): ${first.TRC20}`);
    console.log(`  BEP20             : ${first.BEP20}`);
    console.log(`\n⚠️ NOT YET RECORDED in the addresses table — this run wrote nothing.`);
    console.log(`   Issue them through the API so a row exists before funds arrive.`);
  }
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("THREW:", e instanceof Error ? e.message : e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
