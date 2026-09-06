// COVERS: src/chain/seed/vault.ts src/chain/seed/passphrase.ts
//
// THE TWO STRINGS THAT CANNOT CHANGE, PINNED.
//
// In a repository called SamaPay, "salamwallet-vault-v1" and
// "salamwallet-vault-key-v1" read like leftover branding from a rename nobody
// finished. They are cryptographic INPUTS:
//
//   salamwallet-vault-v1       AES-256-GCM additional authenticated data,
//                              passed to setAAD() on BOTH encrypt and decrypt
//   salamwallet-vault-key-v1   the HKDF `info` parameter — a direct input to
//                              key derivation
//
// Change either and every blob ever written fails its auth tag, or a DIFFERENT
// key is derived. SamaPrime's own docs say the seed has NO RECOVERY PATH. And
// it would not fail loudly: it compiles, it type-checks, it lints, and it
// throws on the first vault unlock — by which time it is deployed and the
// window has already copied the seed.
//
// This is a MECHANISM, not a comment, because SamaPrime's equivalent table of
// dangerous strings shipped for months MISSING these exact two rows.
import { readFileSync } from "node:fs";

const AAD_LITERAL = 'Buffer.from("salamwallet-vault-v1", "utf8")';
const HKDF_LITERAL = '"salamwallet-vault-key-v1"';

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail: string) {
  if (ok) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label} — ${detail}`); }
}

const vault = readFileSync("src/chain/seed/vault.ts", "utf8");
const pass_ = readFileSync("src/chain/seed/passphrase.ts", "utf8");

// PRESENCE — the claim itself
check(vault.includes(AAD_LITERAL), "vault.ts carries the exact AAD literal", `expected ${AAD_LITERAL}`);
check(pass_.includes(HKDF_LITERAL), "passphrase.ts carries the exact HKDF info literal", `expected ${HKDF_LITERAL}`);

// SIZE CONTROL — an absence claim is satisfied by an empty file, a failed read
// or a truncated one. Assert the sample is real before trusting anything above.
check(vault.length > 2000, "vault.ts sample is a real file", `read ${vault.length} chars`);
check(pass_.length > 1000, "passphrase.ts sample is a real file", `read ${pass_.length} chars`);

// NEGATIVE CONTROL — the probe must be able to say NO. If a rename happened,
// the new brand is what would replace it, so look for it explicitly.
check(!vault.includes("samapay-vault-v1"), "vault.ts has NOT been rebranded", "found samapay-vault-v1");
check(!pass_.includes("samapay-vault-key-v1"), "passphrase.ts has NOT been rebranded", "found samapay-vault-key-v1");

// AND THE PROBE ITSELF MUST BE PROVEN ABLE TO FAIL.
check(!vault.includes("zzq-marker-that-must-be-absent"), "control: probe returns false for an absent string", "impossible");
check(vault.includes("setAAD"), "control: probe returns true for a string that IS present", "setAAD not found — probe is broken");

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (pass === 0) { console.log("VOID — no check executed"); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
