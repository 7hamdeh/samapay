// The closed set. A scope not listed here cannot be issued or checked.
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
