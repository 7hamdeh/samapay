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
export const PANEL_CSS = `:root { --sp-line: #d8d8d8; --sp-ink: #1c1c1c; --sp-muted: #5a5a5a; }
body.panel { color: var(--sp-ink); }
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
