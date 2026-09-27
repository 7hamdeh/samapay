// One server-rendered shell for the panel. Hono, same process, same origin as
// the API — pay-dashboard.md B.3's recommendation, and the reason there is no
// second vhost, no CORS and no extra secret distribution here.
//
// It is deliberately a SHELL plus a fetch layer: every number on the page comes
// from the same read-only panel routes a merchant's own integration would use,
// so the dashboard cannot be right while the API is wrong.
import { escapeHtml } from "./html.js";
import type { PanelConfig } from "@/panel/config.js";

export interface ShellAccount {
  email: string; displayName: string | null;
  clients: Array<{ id: string; name: string; kind: string; role: string; feeBps: number }>;
}

export function renderPanelShell(input: ShellAccount & { cfg: PanelConfig; csrfToken: string; lang?: "en" | "ar" }): string {
  const lang = input.lang === "ar" ? "ar" : "en";
  const dir = lang === "ar" ? "rtl" : "ltr";
  const t = TABLES[lang];
  const clients = input.clients.length
    ? input.clients.map((c) => `<li class="client"><a href="/panel?clientId=${encodeURIComponent(c.id)}">${escapeHtml(c.name)}</a> <span class="role">${escapeHtml(c.role)}</span> <span class="fee">${c.feeBps / 100}%</span></li>`).join("")
    : `<li class="empty">${t.noClient}</li>`;
  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(t.title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="panel">
<header class="site-header">
  <a class="brand" href="/panel">SamaPay</a>
  <nav>
    <a href="/panel/account">${t.overview}</a>
    <a href="/panel/keys">${t.keys}</a>
    <a href="/panel/deliveries">${t.webhooks}</a>
    <a href="/panel/deposits">${t.movements}</a>
    <a href="/docs.html">${t.docsEn}</a>
    <a href="/docs.ar.html">${t.docsAr}</a>
    <a href="/panel?lang=ar" lang="ar">العربية</a>
    <a href="/panel?lang=en" lang="en">English</a>
  </nav>
  <button type="button" id="signout" class="signout">${t.signOut}</button>
</header>
<main>
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
<script>
// INLINED ON PURPOSE. /panel.js would be a request to nginx's static root
// (location / serves /www/wwwroot/pay.mntad.com), which needs a deploy step that
// the panel itself does not; a dashboard whose script 404s is a blank page.
(() => {
  const clientId = ${input.clients[0] ? JSON.stringify(input.clients[0]!.id) : "null"};
  const csrf = ${JSON.stringify(input.csrfToken)};
  const qs = clientId ? "?clientId=" + encodeURIComponent(clientId) : "";
  const fmt = (v) => (v === null || v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const row = (cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join("") + '</tr>';
  async function load(view, render) {
    const el = document.querySelector('[data-view="' + view + '"] .rows');
    if (!el) return;
    if (!clientId) { el.innerHTML = '<p class="empty">no client linked to this account</p>'; return; }
    try {
      const r = await fetch('/panel/' + view + qs, { credentials: 'same-origin' });
      const body = await r.json();
      if (!r.ok) { el.innerHTML = '<p class="empty">' + fmt(body?.error?.code ?? r.status) + '</p>'; return; }
      el.innerHTML = render(body);
    } catch (e) { el.innerHTML = '<p class="empty">load failed</p>'; }
  }
  load('balance', (b) => {
    const chains = Object.entries(b.chains ?? {});
    return '<table>' + row(['chain', 'received', 'fees', 'withdrawn', 'available', 'pending']) +
      chains.map(([c, p]) => row([c, fmt(p.received), fmt(p.fees), fmt(p.withdrawn), fmt(p.available), fmt(p.pending)]))
        .join("") + '</table><p class="hint">fee ' + (b.feeBps / 100) + '% · ' + fmt(b.note) + '</p>';
  });
  load('keys', (b) => '<table>' + row(['name', 'prefix', 'last4', 'scopes', 'env', 'active', 'created via', 'webhook']) +
    (b.keys ?? []).map((k) => row([fmt(k.name), fmt(k.keyPrefix) + '…', fmt(k.keyLast4), fmt(k.scopes.join(" ")), fmt(k.environment),
      fmt(k.active), fmt(k.createdVia), k.hasWebhookSecret ? 'secret set' : 'none'])).join("") + '</table>');
  load('deposits', (b) => '<table>' + row(['chain', 'amount', 'fee', 'confirmations', 'status', 'reference', 'detected']) +
    (b.deposits ?? []).map((d) => row([fmt(d.chain), fmt(d.amount), fmt(d.feeAmount), fmt(d.confirmations), fmt(d.status), fmt(d.reference), fmt(d.detectedAt)])).join("") + '</table>');
  load('intents', (b) => '<table>' + row(['id', 'reference', 'chain', 'amount', 'status', 'created', 'expires']) +
    (b.intents ?? []).map((i) => row([fmt(i.id), fmt(i.reference), fmt(i.chain), fmt(i.amount), fmt(i.status), fmt(i.createdAt), fmt(i.expiresAt)])).join("") + '</table>');
  load('addresses', (b) => '<table>' + row(['chain', 'address', 'reference', 'legacy import', 'watch disabled']) +
    (b.addresses ?? []).map((a) => row([fmt(a.chain), '<code>' + fmt(a.address) + '</code>', fmt(a.reference), fmt(a.legacyImport), fmt(a.watchDisabledAt)])).join("") + '</table>');
  load('audit', (b) => '<table>' + row(['at', 'actor', 'action', 'subject']) +
    (b.events ?? []).map((e) => row([fmt(e.at), fmt(e.actor), fmt(e.action), fmt(e.subjectId)])).join("") + '</table>');
  // Every mutation carries the CSRF token in the HEADER the server checks
  // (checkCsrf reads X-CSRF-Token). A form field named _csrf would be ignored,
  // so there is exactly one way to send it and the button below is the only
  // mutation the shell itself makes.
  document.getElementById("signout")?.addEventListener("click", async () => {
    await fetch('/auth/signout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
    location.href = '/';
  });
})();
</script>
</body>
</html>`;
}

const TABLES = {
  en: {
    title: "SamaPay — merchant panel", signedInAs: "Signed in as", overview: "Overview", keys: "API keys",
    webhooks: "Webhooks", movements: "Movements", docsEn: "Docs (EN)", docsAr: "Docs (عربي)", signOut: "Sign out",
    balance: "Balance", balanceHint: "available = confirmed deposits − fees − withdrawals still consuming. Nothing here moves money.",
    keysHint: "A key's plaintext is shown once, at creation, and cannot be recovered by anybody — including support.",
    deposits: "Deposits", intents: "Payment intents", addresses: "Permanent addresses",
    addressesHint: "One address per customer per chain, for stores in permanent mode. SamaPay never reuses one.",
    audit: "Audit trail", noClient: "No store is linked to this account yet. A SamaPay account is provisioned by the platform first.",
    needScript: "This page needs script to read your own data. The panel exposes the same routes to you that it uses itself — use them directly if you prefer.",
  },
  ar: {
    title: "SamaPay — لوحة التاجر", signedInAs: "تم الدخول باسم", overview: "نظرة عامة", keys: "مفاتيح API",
    webhooks: "الويب هوك", movements: "الحركات", docsEn: "التوثيق (إنجليزي)", docsAr: "التوثيق (عربي)", signOut: "خروج",
    balance: "الرصيد", balanceHint: "المتاح = الإيداعات المؤكدة − الرسوم − السحوبات الجارية. لا شيء هنا يحرك المال.",
    keysHint: "يظهر نص المفتاح مرة واحدة عند الإنشاء ولا يمكن استرجاعه من أي جهة، بما فيها الدعم.",
    deposits: "الإيداعات", intents: "طلبات الدفع", addresses: "العناوين الدائمة",
    addressesHint: "عنوان واحد لكل عميل لكل شبكة للمتاجر في النمط الدائم. لا يُعاد استخدام العنوان أبداً.",
    audit: "سجل التدقيق", noClient: "لا يوجد متجر مرتبط بهذا الحساب بعد. حساب SamaPay يُنشأ من المنصة أولاً.",
    needScript: "تحتاج هذه الصفحة إلى جافاسكريبت لقراءة بياناتك. اللوحة تعرض عليك المسارات نفسها التي تستخدمها — يمكنك استخدامها مباشرة.",
  },
} as const;
