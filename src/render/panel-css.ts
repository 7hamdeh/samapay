// The panel's own stylesheet, served by the app at /panel/panel.css.
//
// WHY THE PANEL OWNS ITS CSS, when /style.css already exists on this host: the
// marketing sheet is a file in nginx's static root (/www/wwwroot/pay.mntad.com),
// edited outside this repo and shared with the landing and docs pages. The 2026-09-27
// browser pass found two things that need fixing there and nowhere else — six-column
// tables overflow a 360px phone, and the header's nav links measure 19px tall,
// half the smallest target a thumb is supposed to hit. A panel whose layout can
// only change by hand-editing a file another site depends on is a panel that does
// not get fixed. `/panel/…` is inside the nginx block go-live adds for the panel
// anyway, so the sheet is same-origin (which `style-src 'self'` admits), ships
// with the code that needs it, and rolls back with it.
//
// LOGICAL PROPERTIES ONLY — `padding-inline`, `text-align: start`,
// `margin-inline` — because the same sheet serves the Arabic RTL page and the
// English LTR one, and a `left`/`right` here would be a mirror-image bug there.
export const PANEL_CSS = `/* ALEXANDRIA — the estate's one Arabic-first family (samaprime lib/fonts.ts declares
   weight:"variable" with subsets arabic+latin+latin-ext, and this is the same build: the
   two files below are byte-identical to the ones stores.mntad.com serves, 31,348 B and
   30,140 B, asserted in scripts/verify-panel-login.ts:12b).
   WHY THE PANEL HOSTS ITS OWN COPY: the CSP on this origin allows font-src 'self', so a
   link to fonts.gstatic.com is not merely slower on a Syrian mobile connection, it is
   refused. latin-ext is NOT copied: the panel's own strings are Arabic and Latin, and
   merchant-supplied names outside that envelope fall back to the system font, which is a
   cosmetic cost on a table cell and not a reason to ship 28 KB more per origin.
   unicode-range means each file is fetched only when the page renders a glyph
   from it. Both login pages do fetch both — the language switcher and the docs
   links are written in the OTHER script on purpose ("العربية" on the English
   page), so both scripts are on screen. A page that renders one script alone
   (the docs pages, a Latin-only error) downloads one file. */
@font-face {
  font-family: 'Alexandria';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/panel/fonts/alexandria-arabic.woff2') format('woff2');
  unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1;
}
@font-face {
  font-family: 'Alexandria';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('/panel/fonts/alexandria-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

/* PRO LIGHT — the estate's light theme (tokens from /root/sgc-ref/gemini-review.md §4,
   the theme stores.mntad.com ships). Contrast is the point: --text-main on --bg-app is
   over 13:1, and --primary on white is 5.2:1, which is what "readable in daylight on a
   cheap phone" means in numbers. */
:root {
  --pl-bg: #F8FAFC; --pl-surface: #FFFFFF; --pl-raised: #F1F5F9; --pl-active: #E2E8F0;
  --pl-text: #0F172A; --pl-muted: #64748B; --pl-subtle: #94A3B8;
  --pl-primary: #2563EB; --pl-primary-hover: #1D4ED8; --pl-primary-subtle: #EFF6FF;
  --pl-secondary: #0D9488;
  --pl-danger: #DC2626; --pl-danger-subtle: #FEE2E2;
  --pl-success: #16A34A; --pl-success-subtle: #DCFCE7;
  --pl-warning: #D97706; --pl-warning-subtle: #FEF3C7;
  --pl-border: rgba(15, 23, 42, 0.08); --pl-focus: #2563EB;
  --pl-shadow-card: 0 1px 3px 0 rgba(15, 23, 42, 0.08), 0 1px 2px -1px rgba(15, 23, 42, 0.05);
  --pl-radius-card: 14px; --pl-radius-field: 10px;
  --pl-touch: 48px;
}

/* ── THE LOGIN PAGE ───────────────────────────────────────────────────────
   MOBILE FIRST: the base rules below are the 360px layout, and the only
   @media in this block widens the card. A 48px minimum on every field and
   button, 1rem text in every input (a smaller input makes iOS zoom the whole
   page on focus, which is how a 6-digit code gets typed into the wrong box). */
body.panel.auth { background: var(--pl-bg); color: var(--pl-text); font-family: 'Alexandria', ui-sans-serif, system-ui, sans-serif; font-size: 1rem; line-height: 1.75; margin: 0; }
body.panel.auth { font-feature-settings: 'ss01'; }
.auth-wrap { max-width: 26rem; margin-inline: auto; padding: 2rem 1rem 3rem; }
.auth-wrap .brand { font-size: 1.5rem; font-weight: 700; line-height: 1.35; margin: 0 0 .25rem; letter-spacing: -.01em; }
.auth-wrap .tagline { color: var(--pl-muted); margin: 0 0 1.5rem; }
.auth-wrap form.card, .auth-wrap form.inline { background: var(--pl-surface); border: 1px solid var(--pl-border); border-radius: var(--pl-radius-card); box-shadow: var(--pl-shadow-card); padding: 1.25rem; display: grid; gap: .5rem; }
.auth-wrap form.inline { border: 0; box-shadow: none; padding: 0; margin-block-start: .75rem; background: none; }
.auth-wrap label { font-weight: 600; font-size: .95rem; }
.auth-wrap input[type=email], .auth-wrap input[type=text] { inline-size: 100%; min-block-size: var(--pl-touch); font: inherit; font-size: 1rem; padding: .5rem .75rem; border: 1px solid var(--pl-active); border-radius: var(--pl-radius-field); background: var(--pl-surface); color: var(--pl-text); box-sizing: border-box; }
.auth-wrap input:focus-visible { outline: 2px solid var(--pl-focus); outline-offset: 2px; border-color: var(--pl-focus); }
.auth-wrap input#code { font-size: 1.5rem; letter-spacing: .35em; text-align: center; font-variant-numeric: tabular-nums; }
.auth-wrap .hint, .auth-wrap .sent, .auth-wrap .cooldown, .auth-wrap .nobody { color: var(--pl-muted); font-size: .9rem; margin: 0; overflow-wrap: anywhere; }
.auth-wrap .sent { background: var(--pl-primary-subtle); border-radius: var(--pl-radius-field); padding: .5rem .75rem; font-size: .95rem; }
.auth-wrap .alert { background: var(--pl-danger-subtle); color: var(--pl-danger); border-radius: var(--pl-radius-field); padding: .5rem .75rem; font-weight: 600; margin: 0; }
.auth-wrap button { min-block-size: var(--pl-touch); font: inherit; font-weight: 600; border-radius: var(--pl-radius-field); border: 1px solid transparent; cursor: pointer; }
.auth-wrap button.primary { background: var(--pl-primary); color: #fff; padding: .5rem 1rem; }
.auth-wrap button.primary:hover { background: var(--pl-primary-hover); }
.auth-wrap button.primary:focus-visible { outline: 2px solid var(--pl-text); outline-offset: 2px; }
.auth-wrap button.linklike { background: none; border: 0; color: var(--pl-primary); text-decoration: underline; padding-inline: 0; justify-self: start; }
.auth-wrap details { border-block-start: 1px solid var(--pl-border); padding-block-start: .5rem; }
.auth-wrap summary { cursor: pointer; font-weight: 600; font-size: .95rem; min-block-size: 2rem; }
.auth-wrap .back a, .auth-foot a { color: var(--pl-primary); }
.auth-foot { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin-block-start: 1.5rem; padding-block-start: 1rem; border-block-start: 1px solid var(--pl-border); }
.auth-foot a { display: inline-flex; align-items: center; min-block-size: var(--pl-touch); font-size: .9rem; }
@media (prefers-reduced-motion: no-preference) {
  .auth-wrap button, .auth-wrap input { transition: background-color .12s ease, border-color .12s ease; }
}
@media (min-width: 40rem) {
  .auth-wrap { padding-block: 4rem; }
  .auth-wrap form.card { padding: 1.75rem; gap: .75rem; }
}

/* The dashboard's own rules. */
:root { --sp-line: var(--pl-border); --sp-ink: var(--pl-text); --sp-muted: var(--pl-muted); }
body.panel { color: var(--sp-ink); font-family: 'Alexandria', ui-sans-serif, system-ui, sans-serif; background: var(--pl-bg); }
body.panel main { max-width: 64rem; margin-inline: auto; padding-inline: 1rem; }
body.panel .site-header nav { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: center; }
body.panel .site-header nav a { display: inline-flex; align-items: center; min-height: 44px; padding-inline: 0.35rem; }
body.panel .who, body.panel .hint { color: var(--sp-muted); }
body.panel section { padding-block: 1.25rem; border-block-start: 1px solid var(--sp-line); }
body.panel section h2 { margin-block: 0 0.25rem; font-size: 1.15rem; }
/* The overflow rule has to be on a block that is NOT the table: a table cannot
   scroll itself, and without this a 6-column key list pushes the whole document
   to 975px on a 360px phone (measured, browser pass 2026-09-27). */
body.panel .table-wrap { overflow-x: auto; overscroll-behavior-x: contain; }
body.panel table { border-collapse: collapse; width: max(100%, 34rem); font-size: 0.95rem; }
body.panel th, body.panel td { text-align: start; padding: 0.4rem 0.55rem; border-block-end: 1px solid var(--sp-line); overflow-wrap: anywhere; }
body.panel th { font-weight: 600; }
body.panel .rows > p, body.panel .empty { color: var(--sp-muted); }
body.panel .clients { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; padding-inline-start: 0; list-style: none; }
body.panel .role, body.panel .fee { font-size: 0.85em; color: var(--sp-muted); }
body.panel .signout { min-height: 44px; }
`;
