// COVERS: src/chain/seed/import.ts src/chain/seed/secret-input.ts src/chain/seed/ops-gate.ts
//
// IMPORT THE MASTER SEED (contract §8.1, cutover step 2). Run by Ibrahim, at a
// real terminal, from the SamaPay directory:
//
//   pnpm exec tsx --env-file=.env scripts/import-master-seed.ts \
//     --expect-fingerprint=a4434b0b --replace-fingerprint=02e0fb61 \
//     --backup=/root/backups/samapay/samapay-<stamp>.dump.gpg   # dry run (backup checked if given)
//   … same … --apply                                         # writes (--backup required)
//
// ⚠️ THE 24 WORDS ARE TYPED HERE AND NOWHERE ELSE. Never in argv, never in env,
// never piped. The script:
//   1. refuses unless stdin AND stdout are a TTY — before anything else runs;
//   2. refuses any unknown argument without printing it;
//   3. checks where it is (production = samapay @ 5432) and, with --apply, the
//      fresh-backup gate — all BEFORE asking for a single word;
//   4. reads the words with the terminal's echo OFF (raw mode; nothing printed
//      per keystroke), one prompt per word, refusing non-list words by position;
//   5. validates the BIP39 checksum, derives the seed, and REFUSES unless its
//      fingerprint equals --expect-fingerprint;
//   6. replaces crypto_config's row ONLY if its fingerprint equals
//      --replace-fingerprint, in one transaction (src/chain/seed/import.ts);
//   7. prints fingerprints only.
// exit 0 = done / dry run / already imported · 1 = REFUSED (nothing written) · 3 = FAILED.
import { requireInteractiveTerminal, readHiddenLine, collectMnemonicWords, InputAborted } from "@/chain/seed/secret-input.js";

requireInteractiveTerminal();

const { prisma } = await import("@/db/client.js");
const { parseOpsArgs, openOpsRun, backupDirFor, requireFreshBackup, OpsRefused } = await import("@/chain/seed/ops-gate.js");
const { mnemonicFromWords, seedFromMnemonic, replaceMasterSeed, fingerprintSchema, SeedImportRefused, MNEMONIC_WORD_COUNT } = await import("@/chain/seed/import.js");
const { getSeedEncryptionKey } = await import("@/chain/impl/config.js");
const { CryptoError } = await import("@/chain/impl/errors.js");

async function main(): Promise<number> {
  const mode = parseOpsArgs(process.argv.slice(2), ["--expect-fingerprint", "--replace-fingerprint"]);
  const expectFp = fingerprintSchema.safeParse(mode.values.get("--expect-fingerprint"));
  const replaceFp = fingerprintSchema.safeParse(mode.values.get("--replace-fingerprint"));
  if (!expectFp.success || !replaceFp.success) throw new OpsRefused("--expect-fingerprint=<8 hex> and --replace-fingerprint=<8 hex> are both required");
  getSeedEncryptionKey(); // refuse now, not after 24 words, if the key is missing

  await openOpsRun("import-master-seed", mode);
  if (mode.apply || mode.values.has("--backup")) await requireFreshBackup(mode.values.get("--backup"), backupDirFor(mode));

  process.stdout.write(`Type the ${MNEMONIC_WORD_COUNT} words of seed ${expectFp.data}. Nothing you type is shown. Ctrl-C aborts.\n\n`);
  const words = await collectMnemonicWords((p) => readHiddenLine(p), (l) => process.stdout.write(l), MNEMONIC_WORD_COUNT);
  const mnemonic = mnemonicFromWords(words);
  words.fill("");
  const seed = await seedFromMnemonic(mnemonic);
  try {
    const r = await replaceMasterSeed({ seed, expectFingerprint: expectFp.data, replaceFingerprint: replaceFp.data, apply: mode.apply });
    process.stdout.write(`\nseed fingerprint: ${r.fingerprint}   (stored before: ${r.previousFingerprint})\n`);
    if (r.outcome === "already_imported") process.stdout.write("ALREADY IMPORTED — crypto_config already holds this seed. Nothing written.\n");
    else if (r.outcome === "would_replace") process.stdout.write(`DRY RUN — checksum ok, fingerprint ok, stored row is ${r.previousFingerprint}. Nothing written. Re-run with --apply --backup=<fresh dump>.\n`);
    else process.stdout.write(`REPLACED — crypto_config now holds ${r.fingerprint} (one row, one transaction, read back and verified).\nThe vault verifier was cleared with the old seed: run scripts/prove-vault.ts next.\n`);
    return 0;
  } finally {
    seed.fill(0);
  }
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e: unknown) => {
    const refused = e instanceof OpsRefused || e instanceof SeedImportRefused || e instanceof InputAborted || e instanceof CryptoError;
    // These messages are built from positions, fingerprints and config names only; any other error prints its class, never its text.
    console.error(refused ? `\nREFUSED: ${(e as Error).message}` : `\nFAILED: ${(e as { constructor?: { name?: string } })?.constructor?.name ?? "error"} — nothing is committed unless "REPLACED" was printed above`);
    await prisma.$disconnect();
    process.exit(refused ? 1 : 3);
  });
