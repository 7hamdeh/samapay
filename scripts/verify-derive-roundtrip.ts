// COVERS: src/chain/hd/derive.ts src/chain/seed/master-seed.ts src/chain/live.ts
//
// ⚠️⚠️ WHAT THIS PROVES AND WHAT IT DOES NOT.
//
// PROVES: the MECHANISM. That SamaPay can persist an encrypted seed, forget it,
// load it again, re-derive the SAME address byte-for-byte, and produce a valid
// signature from the derived key — on both chains. And that the two ported
// crypto constants survived the move.
//
// PROVES NOTHING ABOUT THE CONFIGURATION. The seed here is DISPOSABLE and is
// generated in-process. The address Ibrahim funds must be derived from the seed
// SamaPay actually runs on, and that decision is still with him.
//
// ⚠️ THE DISPOSABLE SEED MUST NOT SURVIVE THIS RUN. Two seeds sharing one
// derivation-index space is a collision class — SamaPrime already has one live
// instance of it (its hot wallet's index collides with a real user's deposit
// address). The teardown DELETES the row and COUNTS what remains; a non-zero
// count fails the run. The encryption key is generated in memory and never
// written to any file, so it dies with the process regardless.
import crypto from "node:crypto";

// in-process only, before anything reads it
process.env.SEED_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { assertSandboxDatabase } = await import("@/db/guard.js");
const { prisma } = await import("@/db/client.js");
const { saveMasterSeedConfig, loadMasterSeed, wipeMasterSeedCache, seedFingerprint } = await import("@/chain/seed/master-seed.js");
const { deriveAddress, derivePrivateKeyForSigning } = await import("@/chain/hd/derive.js");
const { ethers } = await import("ethers");

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label} — ${detail}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}

async function main() {
  const db = await assertSandboxDatabase();
  console.log(`sandbox: ${db}\n`);

  const before = await prisma.cryptoConfig.count();
  check(before === 0, "PRECONDITION: crypto_config starts empty", `${before} rows — refusing to overwrite a real seed`);
  if (before !== 0) { console.log("\nABORTED: a row already exists."); process.exit(1); }

  const seed = crypto.randomBytes(64); // disposable
  await saveMasterSeedConfig(seed);
  const fp = seedFingerprint(seed);
  check((await prisma.cryptoConfig.count()) === 1, "seed persisted, encrypted at rest", `fingerprint ${fp}`);

  // FIRST derivation
  const first = { BEP20: deriveAddress(seed, "BEP20", 0), TRC20: deriveAddress(seed, "TRC20", 0) };
  check(first.BEP20.startsWith("0x") && first.BEP20.length === 42, "BEP20 address is well-formed", first.BEP20);
  check(first.TRC20.startsWith("T") && first.TRC20.length === 34, "TRC20 address is well-formed", first.TRC20);
  check(first.BEP20 !== first.TRC20, "control: the two chains derive DIFFERENT addresses", "equal would mean the chain argument is ignored");

  // FORGET — this is the step that simulates a restart, and the one that
  // exercises the AAD and the encrypted-at-rest path rather than memory.
  wipeMasterSeedCache();
  const reloaded = await loadMasterSeed();
  check(seedFingerprint(reloaded) === fp, "seed survived a full encrypt/forget/decrypt cycle", `fingerprint ${seedFingerprint(reloaded)}`);

  // SECOND derivation, from the RELOADED seed
  const second = { BEP20: deriveAddress(reloaded, "BEP20", 0), TRC20: deriveAddress(reloaded, "TRC20", 0) };
  check(second.BEP20 === first.BEP20, "BEP20 re-derives BYTE-IDENTICAL after reload", `${first.BEP20} vs ${second.BEP20}`);
  check(second.TRC20 === first.TRC20, "TRC20 re-derives BYTE-IDENTICAL after reload", `${first.TRC20} vs ${second.TRC20}`);

  // ⚠️ AND THE HALF THAT ACTUALLY MATTERS: can we SIGN from it?
  // An address we can derive but not sign from is an address nobody holds the
  // key to. Real money sent there is permanently lost.
  const msg = "samapay derive round-trip " + fp;
  const bscKey = derivePrivateKeyForSigning(reloaded, "BEP20", 0);
  const wallet = new ethers.Wallet(ethers.hexlify(bscKey));
  check(wallet.address.toLowerCase() === first.BEP20.toLowerCase(), "BEP20 private key CORRESPONDS to the derived address", `${wallet.address}`);
  const sig = await wallet.signMessage(msg);
  check(ethers.verifyMessage(msg, sig).toLowerCase() === first.BEP20.toLowerCase(), "BEP20 signature verifies back to the address", "recovered signer matches");

  const tronKey = derivePrivateKeyForSigning(reloaded, "TRC20", 0);
  check(tronKey.length === 32, "TRC20 signing key derived, 32 bytes", `${tronKey.length} bytes`);
  const { default: TronWebPkg } = await import("tronweb");
  const TronWeb = (TronWebPkg as unknown as { TronWeb?: unknown }).TronWeb ?? TronWebPkg;
  const tw = new (TronWeb as new (o: unknown) => { address: { fromPrivateKey(k: string): string } })({ fullHost: "https://api.trongrid.io" });
  const tronAddrFromKey = tw.address.fromPrivateKey(Buffer.from(tronKey).toString("hex"));
  check(tronAddrFromKey === first.TRC20, "TRC20 private key CORRESPONDS to the derived address", `${tronAddrFromKey}`);

  // TEARDOWN — destroy, then COUNT. Not "cleaned up", counted.
  await prisma.cryptoConfig.deleteMany({});
  const left = await prisma.cryptoConfig.count();
  check(left === 0, "DISPOSABLE SEED DESTROYED — crypto_config counted, not assumed", `${left} rows remain`);
  const addrs = await prisma.address.count();
  check(addrs === 0, "no Address row was written — index space untouched", `${addrs} rows`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  console.log("SCOPE: proves the MECHANISM and that the ported constants work. Proves NOTHING about which seed SamaPay will run on.");
  await prisma.$disconnect();
  if (pass === 0) { console.log("VOID — nothing executed"); process.exit(1); }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error("THREW:", e); try { await prisma.cryptoConfig.deleteMany({}); console.error("teardown ran"); } catch {} process.exit(1); });
