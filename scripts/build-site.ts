// BUILD THE PUBLIC DOCS PAGES from the one source: docs/API.md (and its Arabic
// twin docs/API.ar.md) → site/docs.html and site/docs.ar.html. Static HTML, no
// script, no external font, no tracking. scripts/verify-site.ts re-renders both
// and requires the committed files to be byte-identical, and verify-api-docs.ts
// pins docs/API.md to src/ — so the published page cannot drift from the code.
//
//   ./node_modules/.bin/tsx scripts/build-site.ts          (writes site/docs*.html)
import { readFileSync, writeFileSync } from "node:fs";

export type Lang = "en" | "ar";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline markdown: `code`, **bold**, *em*. Code spans are cut out first so nothing inside them is formatted. */
export function inline(s: string): string {
  return s.split(/(`[^`]+`)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }).join("");
}

/** A heading "6. Flow 1…": the number is isolated with <bdi>, so in RTL it reads "6." and not ".6". */
const headingHtml = (text: string) => { const m = /^(\d+\.)\s+(.*)$/.exec(text); return m ? `<bdi>${m[1]}</bdi> ${inline(m[2] as string)}` : inline(text); };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The markdown subset docs/API*.md uses: headings, rules, fences, tables, (nested) lists, paragraphs. */
export function renderMarkdown(md: string): { html: string; toc: Array<{ id: string; text: string }> } {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const toc: Array<{ id: string; text: string }> = [];
  let i = 0, headingNo = 0;
  const isListLine = (l: string) => /^(\s*)(-|\d+\.)\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") { i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push(`<pre${fence[1] ? ` class="lang-${fence[1]}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^---\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] as string).length, text = h[2] as string;
      // "## 6. …" → id "sec-6" in BOTH languages, so a link survives translation.
      const num = level === 2 ? /^(\d+)\.\s/.exec(text) : null;
      const id = num ? `sec-${num[1]}` : `s${++headingNo}`;
      if (level === 2) toc.push({ id, text });
      out.push(`<h${level} id="${id}">${headingHtml(text)}</h${level}>`); i++; continue;
    }
    if (line.startsWith("|") && /^\|[\s|:-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = cells(line); i += 2;
      const body: string[][] = [];
      while (i < lines.length && (lines[i] as string).startsWith("|")) body.push(cells(lines[i++] as string));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (isListLine(line)) {
      // Items with their continuation lines; nesting by indent (0 = outer, ≥ 2 = inner).
      type Item = { depth: number; ordered: boolean; text: string };
      const items: Item[] = [];
      while (i < lines.length && (lines[i] as string).trim() !== "" && (isListLine(lines[i] as string) || /^\s{2,}\S/.test(lines[i] as string))) {
        const l = lines[i++] as string;
        const m = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(l);
        if (m) items.push({ depth: (m[1] as string).length >= 2 ? 1 : 0, ordered: m[2] !== "-", text: m[3] as string });
        else if (items.length) (items[items.length - 1] as Item).text += " " + l.trim();
      }
      const html: string[] = [];
      let open0 = "", open1 = "";
      for (const it of items) {
        const tag = it.ordered ? "ol" : "ul";
        if (it.depth === 0) {
          if (open1) { html.push(`</${open1}>`); open1 = ""; }
          if (!open0) { html.push(`<${tag}>`); open0 = tag; } else html.push("</li>");
          html.push(`<li>${inline(it.text)}`);
        } else {
          if (!open1) { html.push(`<${tag}>`); open1 = tag; }
          html.push(`<li>${inline(it.text)}</li>`);
        }
      }
      if (open1) html.push(`</${open1}>`);
      if (open0) html.push(`</li></${open0}>`);
      out.push(html.join(""));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== "" && !/^(```|#{1,4}\s|---\s*$|\|)/.test(lines[i] as string) && !isListLine(lines[i] as string)) para.push((lines[i++] as string).trim());
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return { html: out.join("\n"), toc };
}

const T = {
  en: { dir: "ltr", title: "pay.mntad.com — API documentation", home: "Home", docs: "Docs", other: "العربية", otherHref: "docs.ar.html", homeHref: "index.html", contents: "Contents", foot: "USDT payments on TRC20 and BEP20." },
  ar: { dir: "rtl", title: "pay.mntad.com — توثيق الواجهة البرمجية", home: "الرئيسية", docs: "التوثيق", other: "English", otherHref: "docs.html", homeHref: "ar.html", contents: "المحتويات", foot: "مدفوعات USDT على TRC20 وBEP20." },
} as const;

export function renderDocsPage(md: string, lang: Lang): string {
  const t = T[lang];
  const { html, toc } = renderMarkdown(md);
  return `<!doctype html>
<html lang="${lang}" dir="${t.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(t.title)}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${t.homeHref}">pay.mntad.com</a><nav><a href="${t.homeHref}">${t.home}</a><a href="${lang === "en" ? "docs.html" : "docs.ar.html"}" aria-current="page">${t.docs}</a><a href="${t.otherHref}" lang="${lang === "en" ? "ar" : "en"}">${t.other}</a></nav></div></header>
<main class="wrap doc">
<nav class="toc" aria-label="${t.contents}"><strong>${t.contents}</strong><ul>${toc.map((x) => `<li><a href="#${x.id}">${headingHtml(x.text)}</a></li>`).join("")}</ul></nav>
<article>
${html}
</article>
</main>
<footer class="wrap foot">${t.foot}</footer>
</body>
</html>
`;
}

export const PAGES: Array<{ src: string; out: string; lang: Lang }> = [
  { src: "docs/API.md", out: "site/docs.html", lang: "en" },
  { src: "docs/API.ar.md", out: "site/docs.ar.html", lang: "ar" },
];

if (process.argv[1]?.endsWith("build-site.ts")) {
  for (const p of PAGES) { writeFileSync(p.out, renderDocsPage(readFileSync(p.src, "utf8"), p.lang)); console.log(`wrote ${p.out}`); }
}
