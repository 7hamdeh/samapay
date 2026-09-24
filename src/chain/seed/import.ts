// Master-seed IMPORT (contract §8.1): the ONE seed (MNTAD's) is copied into
// SamaPay by Ibrahim typing its 24 words into scripts/import-master-seed.ts.
// This module is the library half — the CLI owns the TTY, the where-am-I and
// the backup gate; everything that decides whether crypto_config changes is here.
//
// THE THREE REFUSALS THAT MAKE A WRONG IMPORT IMPOSSIBLE TO COMMIT
//   bad_checksum          the words are not a valid BIP39 mnemonic (a typo)
//   fingerprint_mismatch  the words are valid but are not the seed named by
//                         --expect-fingerprint (a DIFFERENT seed) — refused
//                         before the database is read
//   replace_mismatch      the stored row is not the seed named by
//                         --replace-fingerprint — nothing unexpected is
//                         ever overwritten
// The replace is ONE transaction: row locked, conditional UPDATE that must hit
// exactly one row, then the written blob is decrypted back and its fingerprint
// re-checked BEFORE commit. Any failure rolls the whole thing back.
//
// The seed derivation is bip39.mnemonicToSeed(mnemonic) with NO passphrase,
// exactly as SamaPrime's lib/crypto/seed/cli-generate.ts (mnemonicToSeedSync),
// and the fingerprint is master-seed.ts#seedFingerprint — the same function on
// both sides, so the fingerprint Ibrahim passes is the one SamaPrime shows.
import * as bip39 from "bip39";
import { z } from "zod";
import { prisma } from "@/db/client.js";
import { logger } from "@/log.js";
import { getSeedEncryptionKey } from "@/chain/impl/config.js";
import { decryptSeed, encryptSeed, seedFingerprint } from "@/chain/seed/master-seed.js";

export const MNEMONIC_WORD_COUNT = 24;

export type SeedImportRefusalCode =
  | "bad_argument"
  | "word_count"
  | "not_a_word"
  | "bad_checksum"
  | "fingerprint_mismatch"
  | "no_existing_row"
  | "not_exactly_one_row"
  | "replace_mismatch"
  | "write_verification_failed";

export class SeedImportRefused extends Error {
  readonly code: SeedImportRefusalCode;
  constructor(code: SeedImportRefusalCode, message: string) {
    super(message);
    this.name = "SeedImportRefused";
    this.code = code;
  }
}

export const fingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/, "a fingerprint is 8 lowercase hex characters");

const WORDS = new Set(bip39.wordlists.english ?? []);

/**
 * Normalises (trim, lowercase) and validates 24 words: every word in the BIP39
 * English list, then the checksum. Refusals name a POSITION, never a word.
 */
export function mnemonicFromWords(words: readonly string[]): string {
  const norm = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (norm.length !== MNEMONIC_WORD_COUNT) {
    throw new SeedImportRefused("word_count", `expected ${MNEMONIC_WORD_COUNT} words, got ${norm.length}`);
  }
  const bad = norm.findIndex((w) => !WORDS.has(w));
  if (bad !== -1) {
    throw new SeedImportRefused("not_a_word", `word ${bad + 1} is not in the BIP39 English word list`);
  }
  const mnemonic = norm.join(" ");
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new SeedImportRefused("bad_checksum", "the 24 words fail the BIP39 checksum — at least one word is wrong or out of order");
  }
  return mnemonic;
}

/** 64-byte BIP32 seed, no passphrase — identical to SamaPrime's derivation. */
export async function seedFromMnemonic(mnemonic: string): Promise<Buffer> {
  return bip39.mnemonicToSeed(mnemonic);
}

const replaceInput = z.object({
  expectFingerprint: fingerprintSchema,
  replaceFingerprint: fingerprintSchema,
  apply: z.boolean(),
});

export interface ReplaceSeedInput {
  seed: Buffer;
  expectFingerprint: string;
  replaceFingerprint: string;
  apply: boolean;
}

export interface ReplaceSeedResult {
  outcome: "would_replace" | "replaced" | "already_imported";
  fingerprint: string;
  previousFingerprint: string;
}

/**
 * Replaces crypto_config's single row with `seed`, ONLY if:
 *   seed's fingerprint == expectFingerprint (checked before any DB read), and
 *   the table holds exactly one row, and its fingerprint == replaceFingerprint.
 * If the row already holds `expectFingerprint`, nothing is written
 * (already_imported). Dry run (`apply: false`) reads and decides, never writes.
 *
 * On replace, the old seed's vault verifier and hot-wallet address cache are
 * cleared — both were derived from the OLD seed and would be wrong for the new
 * one (scripts/prove-vault.ts writes the new verifier). created_at is set to
 * the import time: the next ops step's backup gate is measured from it.
 */
export async function replaceMasterSeed(input: ReplaceSeedInput): Promise<ReplaceSeedResult> {
  const parsed = replaceInput.safeParse(input);
  if (!parsed.success) {
    throw new SeedImportRefused("bad_argument", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const { expectFingerprint, replaceFingerprint, apply } = parsed.data;
  const fingerprint = seedFingerprint(input.seed);
  if (fingerprint !== expectFingerprint) {
    throw new SeedImportRefused("fingerprint_mismatch", `the words give seed fingerprint ${fingerprint}, not the expected ${expectFingerprint} — nothing was written`);
  }
  const key = getSeedEncryptionKey();

  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: number; seed_fingerprint: string }>>`
      SELECT id, seed_fingerprint FROM crypto_config ORDER BY id FOR UPDATE`;
    if (rows.length === 0) {
      throw new SeedImportRefused("no_existing_row", "crypto_config holds no row — there is no seed to replace (refusing to create one: this tool only replaces)");
    }
    const row = rows[0];
    if (rows.length !== 1 || !row || row.id !== 1) {
      throw new SeedImportRefused("not_exactly_one_row", `crypto_config holds ${rows.length} row(s) (ids ${rows.map((r) => r.id).join(",")}); expected exactly one, id 1`);
    }
    const previousFingerprint = row.seed_fingerprint;
    if (previousFingerprint === expectFingerprint) {
      return { outcome: "already_imported" as const, fingerprint, previousFingerprint };
    }
    if (previousFingerprint !== replaceFingerprint) {
      throw new SeedImportRefused("replace_mismatch", `the stored seed is ${previousFingerprint}, not ${replaceFingerprint} — refusing to overwrite it`);
    }
    if (!apply) {
      return { outcome: "would_replace" as const, fingerprint, previousFingerprint };
    }

    const updated = await tx.cryptoConfig.updateMany({
      where: { id: 1, seedFingerprint: replaceFingerprint },
      data: {
        encryptedMasterSeed: encryptSeed(input.seed, key),
        seedFingerprint: fingerprint,
        vaultVerifier: null,
        hotWalletAddressBep20: null,
        hotWalletAddressTrc20: null,
        createdAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new SeedImportRefused("write_verification_failed", `the conditional update hit ${updated.count} row(s), not 1 — rolled back`);
    }
    // Read back what was written and prove it decrypts to this seed, before commit.
    const back = await tx.cryptoConfig.findUniqueOrThrow({ where: { id: 1 } });
    const roundTrip = decryptSeed(back.encryptedMasterSeed, key);
    const ok = roundTrip.equals(input.seed) && back.seedFingerprint === fingerprint;
    roundTrip.fill(0);
    if (!ok) {
      throw new SeedImportRefused("write_verification_failed", "the written row does not decrypt back to the imported seed — rolled back");
    }
    return { outcome: "replaced" as const, fingerprint, previousFingerprint };
  });

  logger.info({ actor: "cli:import-master-seed", action: "seedImport", result: result.outcome, fingerprint: result.fingerprint, previousFingerprint: result.previousFingerprint }, "master seed import");
  return result;
}
