/** HTML escaping for the panel shell. Every value interpolated into the page
 *  passes through here — merchant names, emails and addresses are user data on
 *  a page that carries a session cookie, which is the exact condition an
 *  injected <script> needs. */
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export function escapeHtml(input: string): string {
  return String(input).replace(/[&<>"'`]/g, (ch) => ENTITIES[ch] ?? ch);
}
