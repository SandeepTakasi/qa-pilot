// Documentation site: renders the repo's own markdown, listed in docs.json, to site/dist.
// Every page comes from a file the plugin already keeps, so the site has no prose of its own
// to drift. The build fails on a broken link or a missing anchor.
//
//   npm run build         for GitHub Pages (base /qa-pilot/)
//   npm run build:local   base /, then preview with: npm run serve

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const SITE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SITE, '..');
const DIST = path.join(SITE, 'dist');
const SITE_URL = 'https://sandeeptakasi.github.io/qa-pilot/';
const GITHUB = 'https://github.com/SandeepTakasi/qa-pilot';
let BASE = process.env.BASE || '/qa-pilot/';
if (!BASE.startsWith('/')) BASE = '/' + BASE;
if (!BASE.endsWith('/')) BASE += '/';

const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'qa-pilot/.claude-plugin/plugin.json'), 'utf8')).version;
const HOME = {
  title: 'QA-Pilot', slug: '', source: 'README.md',
  description: 'A Claude Code plugin for feature testing. QA approves the cases, committed Playwright runs give the verdict, and every result carries a trace and a deploy SHA.',
};

const errors = [];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// GitHub-style heading ids, so links written for GitHub land on the same section here.
function slugger() {
  const seen = new Map();
  return (t) => {
    const base = t.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

// Skill files open with frontmatter written to trigger the skill; its description is the fallback lede.
function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: raw, description: '' };
  const d = (m[1].match(/^description:\s*(.*)$/m)?.[1] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  return { body: raw.slice(m[0].length), description: d.split(/\s*Use when/)[0] };
}

// Drop the named `##` sections, ignoring headings inside code fences.
function omit(body, names = []) {
  let fenced = false;
  let skip = false;
  return body.split('\n').filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced && line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h) skip = names.includes(h[1]);
    return !skip;
  }).join('\n');
}

// A link to another page in docs.json stays on the site; any other repo file goes to GitHub.
function href(link, page, bySource) {
  if (link.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(link)) return link;
  const [file, ...frag] = link.split('#');
  const hash = frag.length ? '#' + frag.join('#') : '';
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(page.source), file)).replace(/\/$/, '');
  if (bySource.has(target)) return BASE + bySource.get(target).slug + hash;
  const abs = path.join(REPO, target);
  if (!fs.existsSync(abs)) errors.push(`${page.source}: link to ${target}, which does not exist`);
  const dir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  return `${GITHUB}/${dir ? 'tree' : 'blob'}/main/${target}${dir ? '' : hash}`;
}

function render(body, page, bySource) {
  const id = slugger();
  const h2 = [];
  let first = true;
  const marked = new Marked({
    gfm: true,
    renderer: {
      // Raw HTML is shown as text: docs use placeholders such as <feature>.
      html({ text: t, block }) { return block ? `<p>${esc(t.trim())}</p>\n` : esc(t); },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const hid = id(text(inner));
        if (depth === 1 && first) { first = false; return ''; } // the page title is printed once, above
        const level = Math.max(depth, 2);
        if (level === 2) h2.push({ hid, label: text(inner) });
        return `<h${level} id="${hid}"><a href="#${hid}">${inner}</a></h${level}>\n`;
      },
      link({ href: h, title, tokens }) {
        const t = title ? ` title="${esc(title)}"` : '';
        return `<a href="${esc(href(h, page, bySource))}"${t}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  // Wide tables scroll on their own instead of widening the page.
  const html = marked.parse(body).replace(/<table>/g, '<div class="scroll"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, h2 };
}

function nav(groups, current) {
  return groups.map((g) => `<p>${esc(g.group)}</p><ul>${g.pages.map((p) =>
    `<li><a href="${BASE}${p.slug}"${p.slug === current ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul>`).join('\n');
}

function shell({ title, description, slug, lede = '', body, groups, toc = '' }) {
  const full = slug === '' ? `${title}: evidence-first feature testing for Claude Code` : `${title} · QA-Pilot`;
  const links = nav(groups, slug);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description)}">
${slug === null ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${SITE_URL}${slug}">`}
<link rel="icon" href="${BASE}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${BASE}site.css">
</head>
<body>
<header><a class="home" href="${BASE}">QA-Pilot</a> <span>${esc(VERSION)}</span><a href="${GITHUB}">GitHub</a></header>
<div class="layout">
<nav aria-label="Documentation"><details><summary>Contents</summary>${links}</details><div class="wide">${links}</div></nav>
<main>
<h1>${esc(title)}</h1>
${lede ? `<p class="lede">${lede}</p>` : ''}
${toc}
${body}
</main>
</div>
<footer>MIT licence. Built from the <a href="${GITHUB}">repository's</a> markdown at version ${esc(VERSION)}.</footer>
</body>
</html>
`;
}

function write(rel, data) {
  const f = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

// Every internal href and src must resolve to a file in dist, and every #fragment to an id there.
function check() {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.html') && files.push(path.join(d, e.name)));
  walk(DIST);
  const ids = new Map();
  const idsOf = (f) => ids.get(f) ?? ids.set(f, new Set([...fs.readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))).get(f);
  let links = 0;
  for (const f of files) {
    const rel = path.relative(DIST, f);
    const html = fs.readFileSync(f, 'utf8').replace(/<pre[\s\S]*?<\/pre>/g, '');
    for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const h = raw.replace(/&amp;/g, '&');
      if (/^[a-z][a-z0-9+.-]*:/i.test(h)) continue;
      links++;
      const [target, frag] = h.split('#');
      let file = f;
      if (target) {
        if (!target.startsWith(BASE)) { errors.push(`${rel}: ${h} is outside ${BASE}`); continue; }
        const abs = path.join(DIST, target.slice(BASE.length));
        file = fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : path.join(abs, 'index.html');
        if (!fs.existsSync(file)) { errors.push(`${rel}: broken link ${h}`); continue; }
      }
      if (frag && file.endsWith('.html') && !idsOf(file).has(decodeURIComponent(frag))) errors.push(`${rel}: ${h} points at a missing #${frag}`);
    }
  }
  return { pages: files.length, links };
}

const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'docs.json'), 'utf8'));
const groups = manifest.groups;
const pages = groups.flatMap((g) => g.pages);
const bySource = new Map([HOME, ...pages].map((p) => [p.source, p]));

// The site's own words are the ledes in docs.json; keep them free of em and en dashes.
for (const p of pages) if (/[\u2013\u2014]/.test(p.lede ?? '')) errors.push(`docs.json: the lede of ${p.slug} has an em or en dash`);

fs.rmSync(DIST, { recursive: true, force: true });
for (const page of [HOME, ...pages]) {
  const raw = fs.readFileSync(path.join(REPO, page.source), 'utf8');
  const { body, description } = frontmatter(raw);
  const { html, h2 } = render(omit(body, page.omit), page, bySource);
  const lede = page.lede ? new Marked().parseInline(page.lede) : '';
  const toc = page.slug !== '' && h2.length >= 3
    ? `<details class="toc"><summary>On this page</summary><ul>${h2.map((h) => `<li><a href="#${h.hid}">${esc(h.label)}</a></li>`).join('')}</ul></details>`
    : '';
  const desc = page.description ?? (page.lede ? text(lede) : description || `${page.title}, from the QA-Pilot documentation.`);
  write(path.join(page.slug, 'index.html'), shell({ title: page.title, description: desc, slug: page.slug, lede, body: html, groups, toc }));
}
write('404.html', shell({
  title: 'Page not found', description: 'This page does not exist.', slug: null, groups,
  body: `<p>The address may have changed. <a href="${BASE}docs/">The overview</a> lists every page.</p>`,
}));
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
  [HOME, ...pages].map((p) => `  <url><loc>${SITE_URL}${p.slug}</loc></url>`).join('\n')}\n</urlset>\n`);
write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
for (const f of ['site.css', 'favicon.svg']) fs.copyFileSync(path.join(SITE, 'assets', f), path.join(DIST, f));

const stats = check();
if (errors.length) {
  console.error(`Build failed with ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`Base ${BASE}, version ${VERSION}: ${stats.pages} pages, ${stats.links} internal links checked, none broken`);
