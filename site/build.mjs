// QA-Pilot site build: markdown docs + HTML fragments -> static site in site/dist.
// Run `node site/build.mjs` (BASE=/ for a local preview, default /qa-pilot/ for GitHub Pages).
// Contract: site/DESIGN.md sections 2, 5 and 6.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { createHighlighter } from 'shiki';
import * as pagefind from 'pagefind';
import { transform } from 'esbuild';

// ---------------------------------------------------------------- config

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SITE_DIR, '..');
// SITE_OVERRIDE points src/, content/ and assets/ at another directory (for testing only).
const ROOT = process.env.SITE_OVERRIDE ? path.resolve(process.env.SITE_OVERRIDE) : SITE_DIR;
// DIST_DIR lets a second build (or a test) write somewhere other than site/dist.
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(SITE_DIR, 'dist');
const NM = path.join(SITE_DIR, 'node_modules');

const SITE_URL = 'https://sandeeptakasi.github.io/qa-pilot/';
const GITHUB = 'https://github.com/SandeepTakasi/qa-pilot';
let BASE = process.env.BASE || '/qa-pilot/';
if (!BASE.startsWith('/')) BASE = '/' + BASE;
if (!BASE.endsWith('/')) BASE += '/';

const plugin = JSON.parse(fs.readFileSync(path.join(REPO, 'qa-pilot/.claude-plugin/plugin.json'), 'utf8'));
const VERSION = plugin.version;
const VERSION_SHORT = VERSION.split('.').slice(0, 2).join('.');

const LANDING_TITLE = 'QA-Pilot: evidence-first feature testing for Claude Code';
const LANDING_DESCRIPTION =
  'A Claude Code plugin for feature testing. QA approves the cases, committed Playwright runs give the verdict, and every result carries a trace and a deploy SHA.';

// Fonts: DESIGN.md section 2 name <- file inside the font package.
const FONTS = {
  'newsreader-400': ['@fontsource/newsreader', 'newsreader-latin-400-normal'],
  'plex-sans-400': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal'],
  'plex-sans-400-italic': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-italic'],
  'plex-sans-600': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal'],
  'plex-mono-400': ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal'],
};

// Pages whose body fragment lives in site/src (DESIGN.md section 5, "Landing and other pages").
const STATIC_PAGES = [
  { src: 'index.html', out: 'index.html', url: '', title: LANDING_TITLE, description: LANDING_DESCRIPTION, htmlClass: 'page-landing', index: true },
  { src: '404.html', out: '404.html', url: null, title: 'Page not found · QA-Pilot', description: 'The page you asked for does not exist. Search the docs or start from the overview.', htmlClass: 'page-landing', noindex: true },
  { src: 'styleguide.html', out: 'styleguide/index.html', url: 'styleguide/', title: 'Styleguide · QA-Pilot', description: 'Every site component in both colour themes. Not part of the public navigation.', htmlClass: 'page-landing', noindex: true, mainAttrs: ' data-pagefind-ignore' },
];

// Links to these may be dead only because an optional input was missing and its page was skipped.
const warnings = [];
const errors = [];
const skippedUrls = new Set();
const warn = (m) => { warnings.push(m); console.warn('warn: ' + m); };

// ---------------------------------------------------------------- small helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
const stripTags = (h) => unesc(h.replace(/<[^>]*>/g, ''));
const stripPre = (h) => h.replace(/<pre[\s\S]*?<\/pre>/g, '');
// Light HTML minify: drop line indentation outside <pre> and <textarea>, where whitespace is content.
const minifyHtml = (html) =>
  html.split(/(<(pre|textarea)\b[\s\S]*?<\/\2>)/).map((part, i) => (i % 3 === 0 ? part.replace(/\n[ \t]+/g, '\n') : i % 3 === 1 ? part : '')).join('');
const write = (rel, data) => {
  if (rel.endsWith('.html')) data = minifyHtml(data);
  const f = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};

// GitHub-style heading slugs, deduplicated with -1, -2 ...
function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

// Meta description under 160 chars: whole sentences while they fit (and say enough), else cut at a word.
function describe(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 157) return t;
  const sentences = t.split(/(?<!\be\.g|\bi\.e)(?<=[.!?])\s+(?=[A-Z])/);
  let out = '';
  for (const s of sentences) {
    if ((out ? out + ' ' + s : s).length > 157) break;
    out = out ? out + ' ' + s : s;
  }
  if (out.length >= 60) return out;
  return t.slice(0, 154).replace(/\s+\S*$/, '').replace(/[,;:(]$/, '') + '...';
}

// ---------------------------------------------------------------- templates

const readTpl = (name) => fs.readFileSync(path.join(SITE_DIR, 'templates', name + '.html'), 'utf8');
// One pass: `{{> partial}}` includes and `{{name}}` values. Substituted values are never rescanned,
// so literal braces in page content are safe.
function fill(text, vars) {
  return text.replace(/\{\{(?:>\s*([\w-]+)|(\w+))\s*\}\}/g, (_, partial, key) => {
    if (partial) return fill(readTpl('partials/' + partial), vars);
    if (!(key in vars)) throw new Error(`template placeholder {{${key}}} has no value`);
    return vars[key];
  });
}

const MENU_TOGGLE =
  '<button class="menu-toggle" type="button" aria-expanded="false" aria-controls="doc-sidebar" data-menu-toggle>Menu</button>';

// pageUrl is the page's site-relative URL ('docs/ci/') or null; it marks the primary nav.
function shell({ title, description, pageUrl, canonical, noindex, htmlClass, mainAttrs = '', content }) {
  // Open Graph and Twitter tags; og:url only exists where a canonical URL does.
  const social = [
    ['og:title', title],
    ['og:description', description],
    ['og:type', htmlClass === 'page-doc' ? 'article' : 'website'],
    canonical && ['og:url', SITE_URL + pageUrl],
    ['og:site_name', 'QA-Pilot'],
  ].filter(Boolean).map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`);
  const headExtra = [
    canonical ? `<link rel="canonical" href="${SITE_URL}${pageUrl}">` : '',
    noindex ? '<meta name="robots" content="noindex">' : '',
    ...social,
    '<meta name="twitter:card" content="summary">',
  ].filter(Boolean).join('\n');
  const cur = (u) => (pageUrl === u ? ' aria-current="page"' : '');
  return fill(readTpl('base'), {
    base: BASE,
    version: VERSION,
    version_short: VERSION_SHORT,
    title: esc(title),
    description: esc(description),
    head_extra: headExtra,
    inline_css: htmlClass === 'page-doc' ? INLINE_CSS_DOCS : INLINE_CSS,
    // Preload the faces in each page type's first screen. Landing: the serif display headline.
    // Docs: bold and mono, which sit in the first screen of text, where a late swap re-wraps
    // paragraphs even with metric-matched fallbacks; the serif preload would only compete there.
    preload_fonts: (htmlClass === 'page-doc' ? ['plex-sans-600', 'plex-mono-400'] : ['newsreader-400'])
      .map((f) => `<link rel="preload" href="${BASE}assets/fonts/${f}.woff2" as="font" type="font/woff2" crossorigin>`).join('\n'),
    html_class: htmlClass,
    main_attrs: mainAttrs,
    menu_toggle: htmlClass === 'page-doc' ? MENU_TOGGLE : '',
    cur_docs: cur('docs/'),
    cur_run_tests: cur('docs/run-tests/'),
    cur_production: cur('docs/production/'),
    content,
  });
}

// ---------------------------------------------------------------- markdown

const SHIKI_LANGS = ['bash', 'sh', 'js', 'ts', 'json', 'yaml', 'yml', 'diff', 'md'];
// min-light and min-dark ship a few token colours under 4.5:1 on the code backgrounds
// (#FBFAF7 light, #1A1A17 dark). These swap them for muted colours that reach AA; every
// replacement was measured, not eyeballed (light: 5.16 to 5.40, dark: 5.77).
const SHIKI_COLORS = {
  'min-light': { '#c2c3c5': '#6b675d', '#22863a': '#1f7a36', '#1976d2': '#1769b5' },
  'min-dark': { '#6b737c': '#8e959e', '#6a737d': '#8e959e' },
};
let highlighter;

function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: raw, description: '' };
  const d = m[1].match(/^description:\s*(.*)$/m);
  let description = d ? d[1].trim() : '';
  if (/^[>|]/.test(description)) throw new Error(`${file}: multi-line frontmatter description is not supported`);
  description = description.replace(/^(["'])([\s\S]*)\1$/, '$2');
  return { body: raw.slice(m[0].length), description };
}

// Drop the named `##` sections (heading through to the next `##`), skipping fenced code blocks.
function omitSections(body, names) {
  if (!names?.length) return body;
  const out = [];
  let fenced = false;
  let skipping = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced && line.match(/^##\s+(.*?)\s*#*\s*$/);
    if (h) skipping = names.includes(h[1]);
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

// Skill frontmatter descriptions are written to trigger a Claude skill, not to introduce a page.
// Fallback when docs.json has no `lede`: the first sentence, cut before "Use when".
function fallbackLede(description) {
  const head = description.split(/\s*Use when/)[0];
  return (head.match(/^.*?[.!?](?=\s|$)/) || [head])[0].trim();
}

// Resolve a markdown href found in `entry`'s source to a site URL, a GitHub URL, or leave it.
function rewriteHref(href, entry, bySource) {
  if (href.startsWith('#')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  const [pathPart, ...frag] = href.split('#');
  const fragment = frag.length ? '#' + frag.join('#') : '';
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.source), pathPart));
  const sibling = bySource.get(target);
  if (sibling) return BASE + sibling.slug + fragment;
  const abs = path.join(REPO, target);
  if (!fs.existsSync(abs)) warn(`${entry.source}: link target ${target} does not exist in the repo`);
  const isDir = pathPart.endsWith('/') || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
  return `${GITHUB}/${isDir ? 'tree' : 'blob'}/main/${target.replace(/\/$/, '')}${isDir ? '' : fragment}`;
}

function renderMarkdown(body, entry, bySource) {
  const slug = makeSlugger();
  const headings = []; // { depth, id, text } for h2 and h3
  let droppedTitle = false;

  const marked = new Marked({
    gfm: true,
    renderer: {
      // Raw HTML never passes through: placeholders like <writes> show as text.
      html({ text, block }) {
        return block ? `<p>${esc(text.trim())}</p>\n` : esc(text);
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const id = slug(stripTags(inner));
        if (depth === 1 && !droppedTitle) { droppedTitle = true; return ''; }
        const level = Math.max(depth, 2);
        if (level > 3) return `<h${level} id="${id}">${inner}</h${level}>\n`;
        headings.push({ depth: level, id, text: stripTags(inner) });
        return `<h${level} id="${id}">${inner} <a class="anchor" href="#${id}" aria-label="Link to this section" data-pagefind-ignore>#</a></h${level}>\n`;
      },
      code({ text, lang }) {
        const requested = (lang || '').split(/\s+/)[0].toLowerCase();
        const known = requested && requested !== 'text' && highlighter.getLoadedLanguages().includes(requested);
        const pre = highlighter.codeToHtml(text, {
          lang: known ? requested : 'text',
          themes: { light: 'min-light', dark: 'min-dark' },
          defaultColor: false,
          colorReplacements: SHIKI_COLORS,
        });
        const caption = known ? `<figcaption class="code__lang">${esc(requested)}</figcaption>` : '';
        return `<figure class="code">${caption}${pre}<button class="code__copy" type="button">Copy</button></figure>\n`;
      },
      link({ href, title, tokens }) {
        const url = rewriteHref(href, entry, bySource);
        const rel = /^https?:/i.test(url) ? ' rel="noopener"' : '';
        const t = title ? ` title="${esc(title)}"` : '';
        return `<a href="${esc(url)}"${t}${rel}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });

  let html = marked.parse(body);
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, headings, marked };
}

function renderToc(headings) {
  if (!headings.some((h) => h.depth === 2)) return '';
  let out = '<ol>';
  let open = false; // an h2 <li> is open
  let sub = false; // its nested <ol> is open
  for (const h of headings) {
    const a = `<a href="#${h.id}">${esc(h.text)}</a>`;
    if (h.depth === 2) {
      if (sub) out += '</ol>';
      if (open) out += '</li>';
      out += `<li>${a}`;
      open = true; sub = false;
    } else if (open) {
      out += sub ? '' : '<ol>';
      sub = true;
      out += `<li>${a}</li>`;
    }
  }
  if (sub) out += '</ol>';
  if (open) out += '</li>';
  out += '</ol>';
  return `<aside class="toc" aria-label="On this page">\n    <p class="toc__title">On this page</p>\n    ${out}\n  </aside>`;
}

// ---------------------------------------------------------------- build steps

function copyFonts() {
  fs.mkdirSync(path.join(DIST, 'assets/fonts'), { recursive: true });
  for (const [name, [pkg, file]] of Object.entries(FONTS)) {
    const from = path.join(NM, pkg, 'files', file + '.woff2');
    if (!fs.existsSync(from)) throw new Error(`font file missing: ${from}`);
    fs.copyFileSync(from, path.join(DIST, 'assets/fonts', name + '.woff2'));
  }
}

// The minified stylesheet, inlined into every page's <head>. At about 7.5 KB gzipped it costs
// less than the render-blocking request it replaces. Font URLs are made absolute because an
// inline <style> resolves relative URLs against the page, not against assets/.
let INLINE_CSS = '';
let INLINE_CSS_DOCS = '';

// Copy assets to dist, minifying site.css and site.js on the way (sources stay readable).
async function copyAssets(assets) {
  if (!fs.existsSync(assets)) return warn('site/assets is missing, nothing copied');
  const out = path.join(DIST, 'assets');
  fs.cpSync(assets, out, { recursive: true });
  const minify = { 'site.css': { loader: 'css' }, 'site.js': { loader: 'js', target: 'es2020' } };
  for (const [name, opts] of Object.entries(minify)) {
    const f = path.join(out, name);
    if (fs.existsSync(f)) fs.writeFileSync(f, (await transform(fs.readFileSync(f, 'utf8'), { ...opts, minify: true })).code);
  }
  const src = path.join(assets, 'site.css');
  if (fs.existsSync(src)) {
    const full = fs.readFileSync(src, 'utf8');
    // Docs pages skip the landing (7) and style guide (12) sections; section markers are the
    // stylesheet's own numbered headings, so a renumbered stylesheet fails loudly here.
    const cut = (from, to) => {
      const a = full.indexOf(from);
      const b = to ? full.indexOf(to) : full.length;
      if (a < 0 || b < 0 || b < a) throw new Error(`site.css section marker missing: ${from}`);
      return full.slice(0, a) + full.slice(b);
    };
    const docs = cut('/* 12. Style guide', null);
    const docsOnly = docs.slice(0, docs.indexOf('/* 7. Components: landing')) + docs.slice(docs.indexOf('/* 8. Components: docs'));
    const inline = async (text) => {
      const code = (await transform(text, { loader: 'css', minify: true })).code
        .replace(/url\((["']?)fonts\//g, `url($1${BASE}assets/fonts/`);
      if (code.includes('</style')) throw new Error('site.css contains "</style", which cannot be inlined');
      return code;
    };
    INLINE_CSS = await inline(full);
    INLINE_CSS_DOCS = await inline(docsOnly);
  }
}

function sidebar(groups, current) {
  return groups.map((g) => {
    const items = g.pages.map((p) => {
      const cur = p === current ? ' aria-current="page"' : '';
      return `      <li><a href="${BASE}${p.slug}"${cur}>${esc(p.title)}</a></li>`;
    }).join('\n');
    return `    <p class="doc-sidebar__group">${esc(g.group)}</p>\n    <ul>\n${items}\n    </ul>`;
  }).join('\n');
}

function buildDocs(groups, flat, bySource, sourceTexts) {
  const pages = [];
  flat.forEach((entry, i) => {
    const raw = fs.readFileSync(entry.file, 'utf8');
    sourceTexts.push({ file: entry.source, text: raw, repoDoc: !entry.source.startsWith('site/') });
    const parsed = parseFrontmatter(raw, entry.source);
    const body = omitSections(parsed.body, entry.omit);
    const ledeText = entry.lede ?? (parsed.description ? fallbackLede(parsed.description) : '');
    const { html, headings, marked } = renderMarkdown(body, entry, bySource);

    const lede = ledeText ? `<p class="doc__lede">${marked.parseInline(ledeText)}</p>` : '';
    const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1]));
    const lead = paragraphs.find((p) => p.split(/\s+/).length >= 8) || entry.title;
    const description = describe(ledeText ? stripTags(marked.parseInline(ledeText)) : lead);

    const prev = flat[i - 1];
    const next = flat[i + 1];
    const pager = [
      prev && `        <a class="pager__prev" href="${BASE}${prev.slug}"><span>Previous</span>${esc(prev.title)}</a>`,
      next && `        <a class="pager__next" href="${BASE}${next.slug}"><span>Next</span>${esc(next.title)}</a>`,
    ].filter(Boolean).join('\n');

    const content = fill(readTpl('doc'), {
      sidebar: sidebar(groups, entry),
      eyebrow: esc(entry.group),
      h1: esc(entry.title),
      lede,
      prose: html,
      source: entry.source,
      pager,
      toc: renderToc(headings),
    });
    const out = entry.slug + 'index.html';
    write(out, shell({
      title: `${entry.title} · QA-Pilot`, description, pageUrl: entry.slug, canonical: true, htmlClass: 'page-doc', content,
    }));
    pages.push({ url: entry.slug, file: out, indexable: true });
  });
  return pages;
}

function buildStatic(sourceTexts) {
  const pages = [];
  for (const p of STATIC_PAGES) {
    const from = path.join(ROOT, 'src', p.src);
    if (!fs.existsSync(from)) {
      warn(`site/src/${p.src} is missing, page skipped`);
      skippedUrls.add(p.out);
      if (p.url !== null) skippedUrls.add(p.url);
      continue;
    }
    const fragment = fs.readFileSync(from, 'utf8');
    sourceTexts.push({ file: 'site/src/' + p.src, text: fragment, repoDoc: false });
    const content = fragment.replaceAll('{{base}}', BASE).replaceAll('{{version}}', VERSION);
    write(p.out, shell({ ...p, pageUrl: p.url, canonical: p.url !== null && !p.noindex, content }));
    pages.push({ url: p.url, file: p.out, indexable: !p.noindex });
  }
  return pages;
}

function writeSiteFiles(pages) {
  const urls = pages.filter((p) => p.indexable).map((p) => `  <url><loc>${SITE_URL}${p.url}</loc></url>`);
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);
  write('.nojekyll', '');
}

// ---------------------------------------------------------------- checks

function walkHtml(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(f, acc);
    else if (e.name.endsWith('.html')) acc.push(f);
  }
  return acc;
}

function checkOutput(sourceTexts) {
  const files = walkHtml(DIST);
  const idCache = new Map();
  const idsOf = (f) => {
    if (!idCache.has(f)) idCache.set(f, new Set([...fs.readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    return idCache.get(f);
  };
  let words = 0;
  let links = 0;
  let broken = 0;

  for (const f of files) {
    const rel = path.relative(DIST, f);
    const html = stripPre(fs.readFileSync(f, 'utf8'));
    words += stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '')).split(/\s+/).filter(Boolean).length;

    const h1s = (html.match(/<h1[\s>]/g) || []).length;
    if (h1s !== 1) errors.push(`${rel}: expected exactly one <h1>, found ${h1s}`);

    // Directory of this page, as a site-relative URL, for resolving relative hrefs.
    const pageDir = path.posix.dirname(rel.split(path.sep).join('/'));
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const href = unesc(m[1]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      links++;
      let [target, frag] = href.split('#');
      target = target.split('?')[0];
      let site; // path inside dist
      if (target === '') site = rel.split(path.sep).join('/');
      else if (target.startsWith('/')) {
        if (!target.startsWith(BASE)) { errors.push(`${rel}: ${href} is outside the base path ${BASE}`); broken++; continue; }
        site = target.slice(BASE.length);
      } else site = path.posix.normalize(path.posix.join(pageDir, target));

      let found = null;
      const abs = path.join(DIST, site);
      if (site !== '' && !site.endsWith('/') && fs.existsSync(abs) && fs.statSync(abs).isFile()) found = abs;
      else if (fs.existsSync(path.join(abs, 'index.html'))) found = path.join(abs, 'index.html');

      if (!found) {
        if (skippedUrls.has(site) || skippedUrls.has(site.replace(/index\.html$/, ''))) continue;
        errors.push(`${rel}: broken link ${href}`);
        broken++;
      } else if (frag && found.endsWith('.html') && !idsOf(found).has(decodeURIComponent(frag))) {
        errors.push(`${rel}: link ${href} points at a missing id #${frag}`);
        broken++;
      }
    }
  }

  // Site-authored text must not contain em or en dashes; repo docs only warn.
  let repoDashes = 0;
  for (const s of sourceTexts) {
    const n = (s.text.match(/[\u2013\u2014]/g) || []).length;
    if (!n) continue;
    if (s.repoDoc) repoDashes += n;
    else errors.push(`${s.file}: ${n} em or en dash character(s); use commas, colons, full stops or parentheses`);
  }
  if (repoDashes) warn(`${repoDashes} em or en dash character(s) in repository docs rendered as-is`);

  return { pages: files.length, words, links, broken };
}

// ---------------------------------------------------------------- main

async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  copyFonts();
  await copyAssets(path.join(ROOT, 'assets'));

  // Manifest: drop entries whose source file does not exist yet (only the site-authored ones may be absent).
  const manifest = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'docs.json'), 'utf8'));
  const sourceFile = (s) => (s.startsWith('site/') ? path.join(ROOT, s.slice(5)) : path.join(REPO, s));
  const flat = [];
  const groups = [];
  for (const g of manifest.groups) {
    const pages = [];
    for (const p of g.pages) {
      const entry = { ...p, group: g.group, file: sourceFile(p.source) };
      if (!fs.existsSync(entry.file)) {
        if (!p.source.startsWith('site/')) throw new Error(`docs source missing: ${p.source}`);
        warn(`${p.source} is missing, page ${p.slug} skipped`);
        skippedUrls.add(p.slug);
        skippedUrls.add(p.slug + 'index.html');
        continue;
      }
      pages.push(entry);
      flat.push(entry);
    }
    groups.push({ group: g.group, pages });
  }
  const bySource = new Map(flat.map((e) => [e.source, e]));

  highlighter = await createHighlighter({ themes: ['min-light', 'min-dark'], langs: SHIKI_LANGS });

  const sourceTexts = [];
  const pages = [...buildDocs(groups, flat, bySource, sourceTexts), ...buildStatic(sourceTexts)];
  writeSiteFiles(pages);

  const stats = checkOutput(sourceTexts);
  if (errors.length) {
    console.error(`\nBuild failed with ${errors.length} problem(s):`);
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }

  const { index } = await pagefind.createIndex();
  await index.addDirectory({ path: DIST });
  await index.writeFiles({ outputPath: path.join(DIST, 'pagefind') });
  await pagefind.close();
  // The site ships its own search UI; only the search API, worker, wasm and index are used.
  const pf = path.join(DIST, 'pagefind');
  for (const f of fs.readdirSync(pf)) {
    if (/^pagefind-(ui|component-ui|modular-ui|highlight)\./.test(f)) fs.rmSync(path.join(pf, f));
  }

  console.log(`\nBase ${BASE}, version ${VERSION}`);
  console.log(`${stats.pages} pages (${flat.length} docs), ${stats.words} words, ${stats.links} internal links checked, broken links ${stats.broken}`);
  console.log(`${warnings.length} warning(s). Search index: dist/pagefind`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
