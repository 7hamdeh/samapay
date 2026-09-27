// One server-rendered shell for the panel. Hono, same process, same origin as
// the API — pay-dashboard.md B.3's recommendation, and the reason there is no
// second vhost, no CORS and no extra secret distribution here.
//
// It is deliberately a SHELL plus a fetch layer: every number on the page comes
// from the same read-only panel routes a merchant's own integration would use,
// so the dashboard cannot be right while the API is wrong.
import { escapeHtml } from "./html.js";
import { cspHeader, scriptHash } from "@/http/csp.js";
import type { PanelConfig } from "@/panel/config.js";

export interface ShellAccount {
  email: string; displayName: string | null;
  clients: Array<{ id: string; name: string; kind: string; role: string; feeBps: number }>;
}

export interface RenderedShell {
  html: string;
  /** The header value that authorizes THIS document's inline script. The route
   *  sets it; the app's default policy would block the script otherwise. */
  csp: string;
}

/** The sections the shell renders, in page order, each with the label the nav
 *  gives it. One list, so a nav link cannot point at a section that is not on
 *  the page — which is how the phase-1 draft's nav ended up linking four
 *  JSON API routes as if they were pages. */
const NAV: Array<[keyof typeof TABLES.en, string]> = [
  ["balance", "balance"], ["keys", "keys"], ["deposits", "deposits"],
  ["intents", "intents"], ["addresses", "addresses"], ["audit", "audit"],
];

export function renderPanelShell(input: ShellAccount & { cfg: PanelConfig; csrfToken: string; lang?: "en" | "ar" }): RenderedShell {
  const lang = input.lang === "ar" ? "ar" : "en";
  const dir = lang === "ar" ? "rtl" : "ltr";
  const t = TABLES[lang];
  const clients = input.clients.length
    ? input.clients.map((c) => `<li class="client"><a href="/panel?clientId=${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a> <span class="role">${escapeHtml(c.role)}</span> <span class="fee">${c.feeBps / 100}%</span></li>`).join("")
    : `<li class="empty">${t.noClient}</li>`;
  const nav = NAV.map(([key, label]) => `<a href="#${label}">${t[key]}</a>`).join("\n    ");
  const script = panelScript(input.clients[0]?.id ?? null);
  return {
    csp: cspHeader([scriptHash(script)]),
    html: `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(t.title)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/panel/panel.css">
</head>
<body class="panel">
<header class="site-header">
  <a class="brand" href="/panel">${t.brand}</a>
  <nav>
    ${nav}
    <a href="/docs.html">${t.docsEn}</a>
    <a href="/docs.ar.html">${t.docsAr}</a>
    <a href="/panel?lang=ar" lang="ar" rel="alternate">${t.ar}</a>
    <a href="/panel?lang=en" lang="en" rel="alternate">${t.en}</a>
  </nav>
  <!-- Logout is a FORM, not a script: a merchant who cannot run JS must still be
       able to end their session, and the token in the field is checked by the one
       route that reads a body value (src/http/routes/panel/index.ts's /panel/logout). -->
  <form method="post" action="/panel/logout" class="logout">
    <input type="hidden" name="_csrf" value="${escapeHtml(input.csrfToken)}">
    <input type="hidden" name="lang" value="${lang}">
    <button type="submit" class="signout">${t.signOut}</button>
  </form>
</header>
<main data-empty="${escapeHtml(t.noClient)}">
  <p class="who">${t.signedInAs} <strong>${escapeHtml(input.displayName || input.email)}</strong></p>
  <ul class="clients">${clients}</ul>
  <section id="balance" data-view="balance"><h2>${t.balance}</h2><p class="hint">${t.balanceHint}</p><div class="rows"></div></section>
  <section id="keys" data-view="keys"><h2>${t.keys}</h2><p class="hint">${t.keysHint}</p><div class="rows"></div></section>
  <section id="deposits" data-view="deposits"><h2>${t.deposits}</h2><div class="rows"></div></section>
  <section id="intents" data-view="intents"><h2>${t.intents}</h2><div class="rows"></div></section>
  <section id="addresses" data-view="addresses"><h2>${t.addresses}</h2><p class="hint">${t.addressesHint}</p><div class="rows"></div></section>
  <section id="audit" data-view="audit"><h2>${t.audit}</h2><div class="rows"></div></section>
  <noscript>${t.needScript}</noscript>
</main>
<script>${script}</script>
</body>
</html>`,
  };
}

/** The shell's whole client side. Split out of the document so the CSP hash is
 *  computed over exactly the bytes between the <script> tags — a template
 *  literal's leading newline is a byte, and a hash that misses one by one is a
 *  page whose data never loads. */
function panelScript(clientId: string | null): string {
  return `
// INLINED ON PURPOSE. /panel.js would be a request to nginx's static root
// (location / serves /www/wwwroot/pay.mntad.com), which needs a deploy step that
// the panel itself does not; a dashboard whose script 404s is a blank page.
(() => {
  const clientId = ${clientId ? JSON.stringify(clientId) : "null"};
  const empty = document.querySelector("main")?.dataset.empty ?? "no data";
  const qs = clientId ? "?clientId=" + encodeURIComponent(clientId) : "";
  const fmt = (v) => (v === null || v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
  // Escaped at the point a value becomes markup, not before: every cell below
  // reaches innerHTML, and a key's name, a deposit reference and an audit
  // subject are all merchant- or chain-supplied strings. CSP's hash stops an
  // injected <script> from RUNNING; it does not make the page's own text safe.
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const row = (cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join("") + '</tr>';
  const cell = (v) => esc(fmt(v));
  // A table cannot scroll itself; the overflow rule needs a block around it.
  // See src/render/panel-css.ts and the 2026-09-27 browser pass (975px of
  // six-column key list on a 360px phone).
  const wrap = (table) => '<div class="table-wrap">' + table + '</div>';
  async function load(view, render) {
    const el = document.querySelector('[data-view="' + view + '"] .rows');
    if (!el) return;
    if (!clientId) { el.textContent = empty; return; }
    try {
      const r = await fetch('/panel/' + view + qs, { credentials: 'same-origin' });
      const body = await r.json();
      if (!r.ok) { el.textContent = String(body?.error?.code ?? r.status); return; }
      el.innerHTML = render(body);
    } catch (e) { el.textContent = "load failed"; }
  }
  load('balance', (b) => {
    const chains = Object.entries(b.chains ?? {});
    return wrap('<table>' + row(['chain', 'received', 'fees', 'withdrawn', 'available', 'pending']) +
      chains.map(([c, p]) => row([cell(c), cell(p.received), cell(p.fees), cell(p.withdrawn), cell(p.available), cell(p.pending)]))
        .join("") + '</table>') + '<p class="hint">fee ' + (b.feeBps / 100) + '% · ' + esc(fmt(b.note)) + '</p>';
  });
  load('keys', (b) => wrap('<table>' + row(['name', 'prefix', 'last4', 'scopes', 'env', 'active', 'created via', 'webhook']) +
    (b.keys ?? []).map((k) => row([cell(k.name), cell(k.keyPrefix) + '…', cell(k.keyLast4), cell(k.scopes.join(" ")), cell(k.environment),
      cell(k.active), cell(k.createdVia), k.hasWebhookSecret ? 'secret set' : 'none'])).join("") + '</table>'));
  load('deposits', (b) => wrap('<table>' + row(['chain', 'amount', 'fee', 'confirmations', 'status', 'reference', 'detected']) +
    (b.deposits ?? []).map((d) => row([cell(d.chain), cell(d.amount), cell(d.feeAmount), cell(d.confirmations), cell(d.status), cell(d.reference), cell(d.detectedAt)])).join("") + '</table>'));
  load('intents', (b) => wrap('<table>' + row(['id', 'reference', 'chain', 'amount', 'status', 'created', 'expires']) +
    (b.intents ?? []).map((i) => row([cell(i.id), cell(i.reference), cell(i.chain), cell(i.amount), cell(i.status), cell(i.createdAt), cell(i.expiresAt)])).join("") + '</table>'));
  load('addresses', (b) => wrap('<table>' + row(['chain', 'address', 'reference', 'legacy import', 'watch disabled']) +
    (b.addresses ?? []).map((a) => row([cell(a.chain), '<code>' + cell(a.address) + '</code>', cell(a.reference), cell(a.legacyImport), cell(a.watchDisabledAt)])).join("") + '</table>'));
  load('audit', (b) => wrap('<table>' + row(['at', 'actor', 'action', 'subject']) +
    (b.events ?? []).map((e) => row([cell(e.at), cell(e.actor), cell(e.action), cell(e.subjectId)])).join("") + '</table>'));
  // No mutation happens from script any more: signing out is a real form with
  // the session's CSRF value in a hidden field, so it works with JavaScript
  // refused, and the only script on this page is the read layer.
})();
`;
}

const TABLES = {
  en: {
    brand: "MNTAD Pay", title: "MNTAD Pay — merchant panel", signedInAs: "Signed in as", keys: "API keys",
    ar: "العربية", en: "English", docsEn: "Docs (EN)", docsAr: "Docs (عربي)", signOut: "Sign out",
    balance: "Balance", balanceHint: "available = confirmed deposits − fees − withdrawals still consuming. Nothing here moves money.",
    keysHint: "A key's plaintext is shown once, at creation, and cannot be recovered by anybody — including support.",
    deposits: "Deposits", intents: "Payment intents", addresses: "Permanent addresses",
    addressesHint: "One address per customer per chain, for stores in permanent mode. MNTAD Pay never reuses one.",
    audit: "Audit trail", noClient: "No store is linked to this account yet. A MNTAD Pay account is provisioned by the platform first.",
    needScript: "This page needs script to read your own data. The panel exposes the same routes to you that it uses itself — use them directly if you prefer.",
  },
  ar: {
    brand: "منطاد باي", title: "منطاد باي — لوحة التاجر", signedInAs: "تم الدخول باسم", keys: "مفاتيح API",
    ar: "العربية", en: "English", docsEn: "التوثيق (إنجليزي)", docsAr: "التوثيق (عربي)", signOut: "خروج",
    balance: "الرصيد", balanceHint: "المتاح = الإيداعات المؤكدة − الرسوم − السحوبات الجارية. لا شيء هنا يحرك المال.",
    keysHint: "يظهر نص المفتاح مرة واحدة عند الإنشاء ولا يمكن استرجاعه من أي جهة، بما فيها الدعم.",
    deposits: "الإيداعات", intents: "طلبات الدفع", addresses: "العناوين الدائمة",
    addressesHint: "عنوان واحد لكل عميل لكل شبكة للمتاجر في النمط الدائم. لا يُعاد استخدام العنوان أبداً.",
    audit: "سجل التدقيق", noClient: "لا يوجد متجر مرتبط بهذا الحساب بعد. حساب منطاد باي يُنشأ من المنصة أولاً.",
    needScript: "تحتاج هذه الصفحة إلى جافاسكريبت لقراءة بياناتك. اللوحة تعرض عليك المسارات نفسها التي تستخدمها — يمكنك استخدامها مباشرة.",
  },
} as const;
