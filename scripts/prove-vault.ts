// COVERS: src/chain/seed/vault-proof.ts src/chain/seed/vault.ts src/chain/seed/secret-input.ts src/chain/seed/ops-gate.ts
//
// PROVE THE VAULT (contract §8.2) — run once, after import-master-seed.ts, by
// Ibrahim at a real terminal, from the SamaPay directory:
//
//   pnpm exec tsx --env-file=.env scripts/prove-vault.ts                                    # dry run
//   pnpm exec tsx --env-file=.env scripts/prove-vault.ts --apply                            # writes
//
// --backup is OPTIONAL here (runbook §4): the only write is vault_verifier
// NULL → value, conditional on the row still holding this seed and no
// verifier. If --backup is given it is gated exactly like the import's.
//
// Asks for a NEW vault passphrase twice (echo OFF), proves the stored seed
// decrypts to its fingerprint, writes crypto_config.vault_verifier, and opens
// it again with a fresh derivation through the same function an unlock runs.
// Afterwards /health reports `vault: proven`. The passphrase is never stored:
// if it is lost, signing (withdrawals, sweep) can never be unlocked again.
// Needs SEED_ENCRYPTION_KEY and PASSPHRASE_SALT in the environment.
// exit 0 = done / dry run / already proven · 1 = REFUSED (nothing written) · 3 = FAILED.
import { requireInteractiveTerminal, readHiddenLine, InputAborted } from "@/chain/seed/secret-input.js";

requireInteractiveTerminal();

const { prisma } = await import("@/db/client.js");
const { parseOpsArgs, openOpsRun, backupDirFor, requireFreshBackup, OpsRefused } = await import("@/chain/seed/ops-gate.js");
const { writeVaultVerifier, vaultStatus, derivationStatus, VaultProofRefused, MIN_PASSPHRASE_LENGTH } = await import("@/chain/seed/vault-proof.js");
const { getSeedEncryptionKey } = await import("@/chain/impl/config.js");
const { getPassphraseSalt } = await import("@/chain/seed/passphrase.js");
const { CryptoError } = await import("@/chain/impl/errors.js");

async function main(): Promise<number> {
  const mode = parseOpsArgs(process.argv.slice(2), []);
  getSeedEncryptionKey();
  getPassphraseSalt();
  await openOpsRun("prove-vault", mode);
  if (mode.values.has("--backup")) await requireFreshBackup(mode.values.get("--backup"), backupDirFor(mode));

  const derivation = await derivationStatus();
  process.stdout.write(`before: derivation ${derivation}, vault ${await vaultStatus()}\n`);
  if (derivation !== "ready") throw new VaultProofRefused("no_seed", "derivation is not ready — import the seed first");

  process.stdout.write(`Choose the vault passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters). Nothing you type is shown.\n`);
  const pass = await readHiddenLine("New vault passphrase: ");
  const again = await readHiddenLine("Type it again: ");
  if (pass !== again) throw new VaultProofRefused("round_trip_failed", "the two entries did not match — nothing written");

  const r = await writeVaultVerifier({ passphrase: pass, apply: mode.apply });
  process.stdout.write(`\nseed fingerprint: ${r.fingerprint}\n`);
  if (r.outcome === "would_write") process.stdout.write("DRY RUN — the verifier opens with this passphrase. Nothing written. Re-run with --apply.\n");
  else if (r.outcome === "already_proven") process.stdout.write("ALREADY PROVEN — a verifier for this seed and this passphrase is stored. Nothing written.\n");
  else process.stdout.write("WRITTEN — the vault verifier is stored and opens with this passphrase.\n");
  process.stdout.write(`vault: ${await vaultStatus()}\n`);
  return 0;
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (e: unknown) => {
    const refused = e instanceof OpsRefused || e instanceof VaultProofRefused || e instanceof InputAborted || e instanceof CryptoError;
    console.error(refused ? `\nREFUSED: ${(e as Error).message}` : `\nFAILED: ${(e as { constructor?: { name?: string } })?.constructor?.name ?? "error"} — nothing is committed unless "WRITTEN" was printed above`);
    await prisma.$disconnect();
    process.exit(refused ? 1 : 3);
  });
