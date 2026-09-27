// The panel's login page: one document, two steps, NO script in it.
//
// WHY NO SCRIPT. The dashboard (`panel-shell.ts`) carries one inline script,
// authorized by a sha256 of its own bytes. This page deliberately has none, and
// the CSP that serves it says `script-src 'none'` — asserted in
// scripts/verify-panel-login.ts:2. Three reasons, in order of weight:
//   · It is the most-attacked document in the service and the only one served to
//     anonymous browsers. A page with no script cannot run injected script, and
//     cannot be broken by a merchant whose extension, proxy or corporate policy
//     blocks it.
//   · Everything the flow has to do — type an address, type a code, click resend
//     — is a form. A JavaScript gate in front of a login form is an accessibility
//     and reliability cost with no security benefit behind it.
//   · The cooldown is a server bucket (`code_resend`), not a disabled button. A
//     page timer can be clicked through with curl; the bucket cannot.
//
// WHY IT IS SERVED BY THIS APP and not by nginx's static root: the code step
// needs the session, the rate limiter and the mailer, all of which live here;
// and `/panel/…` is inside the nginx block the panel needs anyway. The same
// reason applies to its stylesheet and its font — see panel-css.ts.
//
// RTL FIRST, MOBILE FIRST: `dir=rtl` is the default reading order of this estate,
// and every rule in panel-css.ts is a logical property so one sheet serves both.
// The 360px layout is the design, not the fallback.
import { escapeHtml } from "./html.js";

export type LoginStep = "email" | "code";
export type LoginError =
  | "invalid_email" | "bad_code" | "rate_limited" | "state_expired" | "totp_required" | "totp_invalid"
  | "account_disabled" | "mail_failed";

export interface LoginView {
  step: LoginStep;
  lang: "en" | "ar";
  /** Present on the code step only. Echoed into the document, escaped. */
  email?: string;
  /** The sha256 of the browser's state cookie — a hidden field on every form here. */
  loginState: string;
  error?: LoginError;
  /** Seconds until another code may be requested; rendered as text, enforced by a bucket. */
  retryAfterSec?: number;
  codeTtlMin: number;
}

export function renderLoginPage(v: LoginView): string {
  const lang = v.lang === "ar" ? "ar" : "en";
  const t = TABLES[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";
  const email = v.email ?? "";
  const state = escapeHtml(v.loginState);
  const error = v.error ? `<p class="alert" role="alert" id="login-error">${escapeHtml(t.errors[v.error])}</p>` : "";
  const cooldown = v.step === "code" && typeof v.retryAfterSec === "number" && v.retryAfterSec > 0
    ? `<p class="cooldown">${escapeHtml(t.cooldown.replace("{n}", String(v.retryAfterSec)))}</p>`
    : "";

  const step1 = `
  <form method="post" action="/panel/login" class="card">
    ${error}
    <label for="email">${t.emailLabel}</label>
    <input id="email" name="email" type="email" inputmode="email" autocomplete="username" required
           maxlength="320" placeholder="you@store.com" aria-describedby="${v.error ? "login-error" : "hint"}">
    <p class="hint" id="hint">${t.hint}</p>
    <input type="hidden" name="login_state" value="${state}">
    <input type="hidden" name="lang" value="${lang}">
    <button type="submit" class="primary">${t.sendCode}</button>
  </form>`;

  const step2 = `
  <form method="post" action="/panel/login/code" class="card">
    ${error}
    <p class="sent">${escapeHtml(t.sentTo.replace("{email}", email)).replace("{n}", String(v.codeTtlMin))}</p>
    <label for="code">${t.codeLabel}</label>
    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
           autocomplete="one-time-code" required autofocus aria-describedby="${v.error ? "login-error" : "codehint"}">
    <p class="hint" id="codehint">${t.codeHint}</p>
    <details ${v.error === "totp_required" || v.error === "totp_invalid" ? "open" : ""}>
      <summary>${t.totpSummary}</summary>
      <label for="totp">${t.totpLabel}</label>
      <input id="totp" name="totp" type="text" inputmode="numeric" maxlength="10" autocomplete="totp">
    </details>
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="hidden" name="login_state" value="${state}">
    <input type="hidden" name="lang" value="${lang}">
    <button type="submit" class="primary">${t.signIn}</button>
    ${cooldown}
  </form>
  <form method="post" action="/panel/login" class="inline">
    <input type="hidden" name="email" value="${escapeHtml(email)}">
    <input type="hidden" name="login_state" value="${state}">
    <input type="hidden" name="lang" value="${lang}">
    <button type="submit" class="linklike">${t.resend}</button>
  </form>
  <p class="back"><a href="/panel/login?lang=${lang}">${t.changeAddress}</a></p>`;

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<title>${escapeHtml(t.title)}</title>
<link rel="preload" as="font" type="font/woff2" crossorigin href="/panel/fonts/alexandria-${lang === "ar" ? "arabic" : "latin"}.woff2">
<link rel="stylesheet" href="/panel/panel.css">
</head>
<body class="panel auth">
<main class="auth-wrap">
  <h1 class="brand">SamaPay</h1>
  <p class="tagline">${v.step === "email" ? t.tagline : t.taglineCode}</p>
  ${v.step === "email" ? step1 : step2}
  <p class="nobody">${t.nobodyAsks}</p>
  <nav class="auth-foot">
    <a href="/panel/login?lang=${lang === "ar" ? "en" : "ar"}" rel="alternate" lang="${lang === "ar" ? "en" : "ar"}">${lang === "ar" ? "English" : "العربية"}</a>
    <a href="/docs.html">${t.docsEn}</a>
    <a href="/docs.ar.html">${t.docsAr}</a>
  </nav>
</main>
</body>
</html>`;
}

const TABLES = {
  en: {
    title: "Sign in — SamaPay merchant panel",
    tagline: "Open your SamaPay merchant panel with a code sent to your email. There is no password to forget.",
    taglineCode: "Almost in. Enter the code we just sent you.",
    emailLabel: "Email address",
    hint: "The address your store was provisioned with. New here? The same form opens your account.",
    sendCode: "Send me a code",
    sentTo: "A 6-digit code is on its way to {email}. It works once and expires in {n} minutes.",
    codeLabel: "6-digit code",
    codeHint: "Six digits only. Spaces and dashes are not accepted.",
    totpSummary: "This account has 2FA",
    totpLabel: "Second-factor code",
    signIn: "Sign in",
    resend: "Send another code",
    cooldown: "You can request another code in {n} seconds.",
    changeAddress: "Use a different address",
    nobodyAsks: "Nobody at SamaPay will ever ask you for this code, and support cannot sign in for you.",
    docsEn: "Docs (EN)", docsAr: "Docs (عربي)",
    errors: {
      invalid_email: "That does not look like an email address.",
      bad_code: "That code did not work. Check the digits and try again, or ask for a new code.",
      rate_limited: "Too many attempts from here. Wait a minute, then try again.",
      state_expired: "This sign-in has expired or started in another browser. Ask for a new code.",
      totp_required: "This account has 2FA turned on — enter the code from your authenticator app as well.",
      totp_invalid: "That second-factor code was not accepted.",
      account_disabled: "This account is disabled. Contact the platform operator.",
      mail_failed: "The mail could not be sent just now. Try again in a moment.",
    },
  },
  ar: {
    title: "دخول — لوحة تاجر SamaPay",
    tagline: "افتح لوحة التاجر في SamaPay برمز يصلك بالبريد. لا توجد كلمة مرور لتنساها.",
    taglineCode: "بقيت خطوة واحدة. أدخل الرمز الذي أرسلناه إليك.",
    emailLabel: "البريد الإلكتروني",
    hint: "العنوان الذي فُعّل به متجرك. جديد هنا؟ نفس النموذج يفتح حسابك.",
    sendCode: "أرسل الرمز",
    sentTo: "رمز مكوّن من ٦ أرقام في طريقه إلى {email}. يُستخدم مرة واحدة وينتهي بعد {n} دقيقة.",
    codeLabel: "الرمز المكوّن من ٦ أرقام",
    codeHint: "ستة أرقام فقط. المسافات والشرطات غير مقبولة.",
    totpSummary: "هذا الحساب يفعّل المصادقة الثنائية",
    totpLabel: "رمز التحقق الثاني",
    signIn: "دخول",
    resend: "إرسال رمز آخر",
    cooldown: "يمكنك طلب رمز آخر بعد {n} ثانية.",
    changeAddress: "استخدام عنوان آخر",
    nobodyAsks: "لن يطلب منك أي شخص في SamaPay هذا الرمز أبداً، والدعم لا يستطيع الدخول نيابةً عنك.",
    docsEn: "التوثيق (إنجليزي)", docsAr: "التوثيق (عربي)",
    errors: {
      invalid_email: "هذا لا يبدو عنوان بريد إلكتروني صحيحًا.",
      bad_code: "لم يعمل هذا الرمز. تحقق من الأرقام وأعد المحاولة، أو اطلب رمزًا جديدًا.",
      rate_limited: "محاولات كثيرة من هنا. انتظر دقيقة ثم أعد المحاولة.",
      state_expired: "انتهت صلاحية هذا الدخول أو بدأ في متصفح آخر. اطلب رمزًا جديدًا.",
      totp_required: "هذا الحساب يفعّل المصادقة الثنائية — أدخل الرمز من تطبيق المصادقة أيضًا.",
      totp_invalid: "لم يُقبل رمز التحقق الثاني.",
      account_disabled: "هذا الحساب معطّل. تواصل مع مشغّل المنصة.",
      mail_failed: "لم نتمكن من إرسال البريد الآن. أعد المحاولة بعد قليل.",
    },
  },
} as const;
