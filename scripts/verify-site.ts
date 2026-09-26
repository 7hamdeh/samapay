// COVERS: site/index.html site/ar.html site/docs.html site/docs.ar.html site/style.css docs/API.md docs/API.ar.md scripts/build-site.ts scripts/verify-api-docs.ts
//
// THE PUBLIC SITE CANNOT DRIFT FROM THE CODE. The chain is:
//   src/  ──verify-api-docs.ts──▶  docs/API.md  ──build-site.ts──▶  site/docs.html
//                                  docs/API.ar.md ─(parity below)─▶  site/docs.ar.html
// 1. verify-api-docs.ts runs here and must pass: API.md's routes, error codes, statuses, scopes,
//    event types, headers, JSON field sets and constants all equal src/.
// 2. site/docs*.html must be BYTE-IDENTICAL to a fresh render of docs/API*.md: nobody edits the
//    HTML by hand, and a stale page after a doc change fails here.
// 3. The Arabic doc translates PROSE ONLY: its inline code tokens, code blocks, error table
//    (HTTP + code), section ids and every number equal the English doc's.
// 4. Every page: no script, no inline handler, no external request (no remote href/src, no CSS
//    url()/@import), a viewport meta, lang/dir set (ar = rtl), and every local link + #anchor resolves.
// No database. Run: ./node_modules/.bin/tsx scripts/verify-site.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PAGES, renderDocsPage } from "./build-site.js";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`); }
const read = (p: string) => readFileSync(p, "utf8");
const diff = (a: Iterable<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

// ── 1. API.md ⇄ src ──
const api = spawnSync("./node_modules/.bin/tsx", ["scripts/verify-api-docs.ts"], { encoding: "utf8" });
const apiLine = (api.stdout ?? "").trim().split("\n").at(-1) ?? "";
check(api.status === 0 && / 0 failed$/.test(apiLine), "1. verify-api-docs.ts passes: docs/API.md equals src/", apiLine || (api.stderr ?? "").slice(0, 300));

// ── 2. the pages are the render of the docs ──
for (const p of PAGES) {
  const fresh = renderDocsPage(read(p.src), p.lang);
  const committed = existsSync(p.out) ? read(p.out) : "";
  check(committed === fresh, `2. ${p.out} is byte-identical to build-site.ts(${p.src})`, committed === fresh ? "" : "stale or hand-edited — run scripts/build-site.ts");
}

// ── 3. Arabic = English, prose aside ──
const en = read("docs/API.md"), ar = read("docs/API.ar.md");
const fences = (s: string) => [...s.matchAll(/```\w*\n[\s\S]*?```/g)].map((m) => m[0]);
const stripFences = (s: string) => s.replace(/```\w*\n[\s\S]*?```/g, "");
const inlineCode = (s: string) => new Set([...stripFences(s).matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string));
const errorRows = (s: string) => new Set([...s.matchAll(/^\| (\d{3}) \| `([a-z_]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`));
const sections = (s: string) => new Set([...s.matchAll(/^## (\d+)\. /gm)].map((m) => m[1] as string));
const numbers = (s: string) => new Set([...stripFences(s).replace(/`[^`\n]+`/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]));
const fe = fences(en), fa = fences(ar);
check(fe.length > 0 && JSON.stringify(fe) === JSON.stringify(fa), "3a. every code block (curl, JSON, Node, headers) is identical in both languages", `en ${fe.length}, ar ${fa.length}`);
const ie = inlineCode(en), ia = inlineCode(ar);
check(diff(ie, ia).length === 0 && diff(ia, ie).length === 0, "3b. the inline code tokens (routes, fields, codes, statuses) are the same set", `missing in ar: ${diff(ie, ia).join(" | ")} · extra in ar: ${diff(ia, ie).join(" | ")}`);
const re = errorRows(en), ra = errorRows(ar);
check(re.size >= 15 && diff(re, ra).length === 0 && diff(ra, re).length === 0, "3c. the error table (HTTP status + code) is identical", `en ${re.size}, ar ${ra.size}`);
const se = sections(en), sa = sections(ar);
check(se.size >= 9 && diff(se, sa).length === 0 && diff(sa, se).length === 0, "3d. the numbered sections (link anchors sec-N) match", [...se].join(","));
const ne = numbers(en), na = numbers(ar);
check(diff(ne, na).length === 0, "3e. every number the English prose states also appears in the Arabic", `missing in ar: ${diff(ne, na).join(", ")}`);

// ── 4. every page is static, private, mobile-ready, and its links resolve ──
const html = readdirSync("site").filter((f) => f.endsWith(".html"));
check(["index.html", "ar.html", "docs.html", "docs.ar.html"].every((f) => html.includes(f)), "4a. the four pages exist", html.join(", "));
const ids = new Map(html.map((f) => [f, new Set([...read(`site/${f}`).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string))]));
for (const f of html) {
  const s = read(`site/${f}`);
  const isAr = f === "ar.html" || f.endsWith(".ar.html");
  check(!/<script/i.test(s) && !/\son[a-z]+\s*=/i.test(s), `4b. ${f}: no script, no inline event handler`);
  const remote = [...s.matchAll(/\s(?:href|src|action)="([^"]+)"/g)].map((m) => m[1] as string).filter((u) => /^[a-z]+:/i.test(u) || u.startsWith("//"));
  check(remote.length === 0 && !/<iframe|<img|<link(?![^>]*href="style\.css")/i.test(s), `4c. ${f}: no external request (links, images, frames, stylesheets other than style.css)`, remote.join(", "));
  check(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(s), `4d. ${f}: viewport meta for phones`);
  check(isAr ? /<html lang="ar" dir="rtl">/.test(s) : /<html lang="en" dir="ltr">/.test(s), `4e. ${f}: lang/dir ${isAr ? "ar/rtl" : "en/ltr"}`);
  const broken = [...s.matchAll(/\shref="([^"]+)"/g)].map((m) => m[1] as string).filter((u) => !/^[a-z]+:/i.test(u)).filter((u) => {
    const [file, frag] = u.split("#") as [string, string | undefined];
    const target = file === "" ? f : file;
    if (target !== "style.css" && !html.includes(target)) return true;
    return frag !== undefined && !(ids.get(target)?.has(frag) ?? false);
  });
  check(broken.length === 0, `4f. ${f}: every local link and #anchor resolves`, broken.join(", "));
}
const css = read("site/style.css");
check(!/url\(|@import|https?:/i.test(css), "4g. style.css: no url(), @import or remote reference (system fonts only)");
// 360 px: nothing may force a box wider than the phone outside the ≥ 761 px layout.
const wide = [...css.replace(/@media \(max-width: 760px\)[\s\S]*$/, "").matchAll(/(?:^|[;{\s])(?:width|min-width):\s*(\d+)px/g)].map((m) => Number(m[1])).filter((n) => n > 328);
check(wide.length === 0 && /\.table-wrap \{ overflow-x: auto/.test(css) && /pre \{[^}]*overflow-x: auto/.test(css), "4h. style.css: no fixed width over 328 px (360 − 2×16 gutter); tables and code scroll inside themselves", wide.join(","));

console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail === 0) { console.log("*** VOID — no check executed. This is NOT a pass. ***"); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
