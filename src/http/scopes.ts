// The closed set. A scope not listed here cannot be issued or checked.
// ⚠️ NO CHANNEL SCOPE, EVER. Ibrahim, 2026-09-06, verbatim: "CHANNELS ARE
// TOGGLES FROM THE PANEL, NOT PERMISSIONS." Scopes are VERBS; a key never
// carries a channel; which channels a client uses is a per-client toggle in
// the panel (docs/panel-survey-2026-09-06.md S4/S5). Adding `shamcash.*`
// here would be the thing this comment exists to refuse.
export const SCOPES = [
  "addresses.write", "deposits.read", "withdrawals.write", "withdrawals.read", "balance.read",
  // held only by the SamaPrime server's admin key: it can issue and revoke
  // keys and can NEVER move money — that is what keeps "no privileged path" true.
  "keys.issue",
] as const;
export type Scope = (typeof SCOPES)[number];
export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}
