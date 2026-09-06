// COVERS: src/chain/seed/master-seed.ts src/chain/impl/config.ts
//
// GENERATE SAMAPAY'S OWN MASTER SEED — ruling #24, (ج): a NEW seed, SamaPrime
// keeps its own and its 194 addresses. One system, one set of keys, ever.
//
// ⚠️ THIS CREATES IRREPLACEABLE KEY MATERIAL. It is not a verify script. It
// must be run by Ibrahim, on his line, at a real terminal, once.
//
// ══ THE TWO THINGS THAT MUST NOT BE CONFUSED ══
//   PLAINTEXT (the recovery words)  printed ONCE, to a TTY, and nowhere else.
//                                   Never logged, filed, messaged, or captured
//                                   in any session transcript — including the
//                                   one that wrote this file.
//   ENCRYPTED (the stored blob)     lives in crypto_config and IS in database
//                                   backups, exactly as SamaPrime's is. That is
//                                   CORRECT. Reading "never in a backup" as "do
//                                   not persist it" leaves SamaPay unable to
//                                   restart, which is the opposite failure and
//                                   just as total.
//
// ══ WHY IT REFUSES A PIPE ══
// "Never in a message" cannot be a promise a script remembers; a pipe, a tee,
// a `> file` or an agent's captured stdout would each put the words somewhere
// permanent while the script behaved exactly as designed. So the words are
// written ONLY when stdout is an interactive TTY, and the script REFUSES
// otherwise. That is the difference between a rule and a mechanism.
import crypto from "node:crypto";
import * as bip39 from "bip39";
import { prisma } from "@/db/client.js";
import { saveMasterSeedConfig, seedFingerprint } from "@/chain/seed/master-seed.js";

async function main() {
  // 1. REFUSE unless a human is looking at a real terminal.
  if (!process.stdout.isTTY) {
    console.error("REFUSING: stdout is not a TTY. The recovery words must never reach a pipe, a file, or a captured transcript.");
    console.error("Run this directly in your terminal, not through a tool, a pipe, or an agent.");
    process.exit(1);
  }

  // 2. REFUSE to overwrite an existing seed. There is no undo.
  const existing = await prisma.cryptoConfig.count();
  if (existing !== 0) {
    console.error(`REFUSING: crypto_config already holds ${existing} row(s). Overwriting a master seed destroys access to every address derived from it, permanently.`);
    process.exit(1);
  }

  // 3. The encryption key must already exist and be persisted, or the blob we
  //    are about to write can never be decrypted again.
  const keyB64 = process.env.SEED_ENCRYPTION_KEY;
  if (!keyB64 || Buffer.from(keyB64, "base64").length !== 32) {
    console.error("REFUSING: SEED_ENCRYPTION_KEY must be set to 32 bytes of base64 BEFORE this runs, and must be saved in SamaPay's .env.");
    console.error("Generate one with:  openssl rand -base64 32");
    console.error("⚠️ If that key is lost, the encrypted seed below is unrecoverable even though it is backed up.");
    process.exit(1);
  }

  const mnemonic = bip39.generateMnemonic(256); // 24 words
  const seed = await bip39.mnemonicToSeed(mnemonic);
  await saveMasterSeedConfig(seed);
  const fp = seedFingerprint(seed);

  // 4. The ONLY place the plaintext is ever produced. Written directly to the
  //    TTY, not through the logger, so no transport can copy it.
  process.stdout.write("\n\n═══════════════ WRITE THESE 24 WORDS ON PAPER, NOW ═══════════════\n\n");
  process.stdout.write("  " + mnemonic.split(" ").map((w, i) => `${String(i + 1).padStart(2)}. ${w}`).join("\n  ") + "\n");
  process.stdout.write("\n═══════════════════════════════════════════════════════════════════\n");
  process.stdout.write("\nThese words are shown ONCE and are not stored anywhere in readable form.\n");
  process.stdout.write("If they are lost, every address SamaPay ever issues becomes unrecoverable.\n");
  process.stdout.write("There is no reset and no support path.\n");
  process.stdout.write(`\nSeed fingerprint (safe to share, proves WHICH seed): ${fp}\n`);
  process.stdout.write("Press Enter once they are written down. ");
  await new Promise<void>((r) => process.stdin.once("data", () => r()));

  // 5. Scrub what we can from this process. Not a guarantee — V8 may have
  //    copied the string — but it costs nothing and narrows the window.
  seed.fill(0);
  process.stdout.write("\nStored, encrypted, in crypto_config. The encrypted blob IS backed up; the words are not.\n");
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("FAILED:", e instanceof Error ? e.message : e); await prisma.$disconnect(); process.exit(1); });
