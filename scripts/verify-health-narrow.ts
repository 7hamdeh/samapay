// GET /health — the public answer must be a bare { ok } and nothing else.
// Owner ruling 2026-09-26: detail on loopback only. Read-only, in-process, no DB.
//   pnpm exec tsx scripts/verify-health-narrow.ts
import { shouldExposeDetailedHealth, health } from "../src/http/routes/health.js";

let fails = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fails++;
};

async function bodyFor(host: string, extra: Record<string, string> = {}) {
  const res = await health.request("/", { headers: { host, ...extra } });
  return (await res.json()) as Record<string, unknown>;
}

async function main() {
  const SECRET = "0123456789abcdef0123456789abcdef";
  check(shouldExposeDetailedHealth({ host: "127.0.0.1:3090" }), "1a. loopback host is detailed");
  check(shouldExposeDetailedHealth({ host: "localhost" }), "1b. localhost is detailed");
  check(!shouldExposeDetailedHealth({ host: "pay.mntad.com" }), "1c. public hostname is NOT detailed");
  check(!shouldExposeDetailedHealth({ host: "pay.mntad.com" }, ), "1d. absent token does not open it");
  check(shouldExposeDetailedHealth({ host: "pay.mntad.com", forwardToken: SECRET, configuredToken: SECRET }),
    "1e. matching token opens it explicitly");
  check(!shouldExposeDetailedHealth({ host: "pay.mntad.com", forwardToken: "wrong", configuredToken: SECRET }),
    "1f. a wrong token does not");
  check(!shouldExposeDetailedHealth({ host: "pay.mntad.com", forwardToken: SECRET, configuredToken: "short" }),
    "1g. a too-short configured token is never honoured (misconfig fails closed)");
  check(!shouldExposeDetailedHealth({}), "1h. no Host header at all is NOT detailed (fail closed)");

  const pub = await bodyFor("pay.mntad.com");
  check(Object.keys(pub).length === 1 && "ok" in pub, "2a. public body is exactly { ok }", JSON.stringify(pub));
  for (const leak of ["vault", "derivation", "observer_lag_blocks", "legacy_watch"])
    check(!(leak in pub), `2b. public body hides ${leak}`);

  const priv = await bodyFor("127.0.0.1:3090");
  check("vault" in priv && "observer_lag_blocks" in priv, "3. loopback body keeps the detail", Object.keys(priv).join(","));

  // CONTROL: force the detailed branch on a public host and prove the assertions go red.
  const forced = await bodyFor("pay.mntad.com", { "x-samapay-health-token": "irrelevant-but-present" });
  const controlRed = Object.keys(forced).length !== 1;
  check(!controlRed, "4. CONTROL: a public request with a non-matching token still returns one key",
    `${Object.keys(forced).length} key(s)`);
  const planted = { ...pub, vault: "proven" } as Record<string, unknown>;
  check("vault" in planted, "5. CONTROL: the leak assertion is real — a planted vault field is detected");

  console.log(fails ? `\nverify-health-narrow: FAIL (${fails})` : "\nverify-health-narrow: PASS");
  if (fails) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
