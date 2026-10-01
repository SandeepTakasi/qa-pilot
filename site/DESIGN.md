# QA-Pilot site: design contract

The site is a product page and the full documentation for QA-Pilot, published with GitHub Pages
at `https://sandeeptakasi.github.io/qa-pilot/`. This file is the contract every page, stylesheet
and build step follows. When code and this file disagree, fix the code or change this file
deliberately; never let them drift.

## 1. Direction: editorial precision

QA-Pilot's whole argument is "a verdict you can open, not a claim". The site makes the same
argument visually: it shows real artefacts (a write record, a refused publish, a report row)
instead of illustrations, and it is set like a well-edited technical book, not a startup page.

Reference points: printed engineering manuals, the Stripe and Linear docs at their most
restrained, a good newspaper's typography. Light, warm paper; near-black ink; one accent; hairline
rules; generous space; type doing the work.

### Banned (this is what reads as AI-generated)

- Gradients, glows, glassmorphism, blurred blobs, noise textures, neon, purple.
- Emoji, decorative icon sets, rows of three identical "feature cards" with an icon on top.
- Rounded "pill" everything. Radius is small and consistent (section 3).
- Scroll-triggered fade-ins, parallax, typing animations, auto-playing anything.
- Stock phrases: supercharge, seamless, effortless, unlock, elevate, revolutionize, game-changer,
  next-level, "in today's fast-paced world", "say goodbye to", exclamation marks.
- Invented product output. Every gate message, field name and command shown on the site must exist
  in the code (`qa-pilot/scripts/*.mjs`, `qa-pilot/templates/*`). Grep before you write it.
- Em dashes and en dashes anywhere in site text. Use commas, colons, full stops or parentheses.
- Any name, URL or data from a real project that uses QA-Pilot. Examples use neutral nouns
  (checkout, order, project, item) and example hosts (`app.example.com`, `.test`). Builds look like
  `a1f9c3e` or `Bx7kQ2mN`.

## 2. Typography

| Role | Family | Use |
|---|---|---|
| Display and headings h1, h2 | **Newsreader** (variable, wght 300-700, opsz) | serif, editorial voice |
| Body, UI, h3 and below | **IBM Plex Sans** 400, 500, 600 | calm, technical, very legible |
| Code, artefacts, commands, labels | **IBM Plex Mono** 400, 500 | the product's own material |

All fonts are self-hosted (no third-party requests). The build copies them to these exact paths
in the output, and `site.css` references exactly these:

```
assets/fonts/newsreader-wght-normal.woff2
assets/fonts/newsreader-wght-italic.woff2
assets/fonts/plex-sans-400.woff2
assets/fonts/plex-sans-500.woff2
assets/fonts/plex-sans-600.woff2
assets/fonts/plex-mono-400.woff2
assets/fonts/plex-mono-500.woff2
```

Latin subset only. `font-display: swap`. Preload the Newsreader normal and Plex Sans 400 files.

Scale (fluid with `clamp()`, rem at a 16px root):

| Token | Size | Line height | Family / weight | Notes |
|---|---|---|---|---|
| `--fs-display` | clamp(2.75rem, 1.6rem + 4.6vw, 5.25rem) | 1.02 | Newsreader 380, opsz auto | letter-spacing -0.022em; landing hero only |
| `--fs-h1` | clamp(2.125rem, 1.6rem + 2vw, 3rem) | 1.1 | Newsreader 420 | -0.015em |
| `--fs-h2` | clamp(1.5rem, 1.25rem + 1vw, 2rem) | 1.2 | Newsreader 450 | -0.01em |
| `--fs-h3` | 1.125rem | 1.4 | Plex Sans 600 | |
| `--fs-body` | 1.0625rem | 1.65 | Plex Sans 400 | prose measure 68ch |
| `--fs-lede` | clamp(1.1875rem, 1.1rem + 0.4vw, 1.375rem) | 1.55 | Plex Sans 400 | colour `--ink-2` |
| `--fs-small` | 0.875rem | 1.5 | Plex Sans 400/500 | |
| `--fs-label` | 0.75rem | 1.3 | Plex Mono 500 | uppercase, letter-spacing 0.08em |
| `--fs-mono` | 0.875em of context | 1.6 | Plex Mono 400 | |

Landing section titles (`h2.section__title`) deliberately use `--fs-h1`: under an 84px display
headline they are the page's chapter heads. Docs pages keep the table's h1 and h2 sizes.

Numerals: `font-variant-numeric: tabular-nums` in tables and artefacts.
Never fake bold or italic; never set body text in the serif (one exception: Plex Sans ships no
italic here, so `em`, `i` and `cite` use Newsreader italic at 1.06em); never set headings in mono.

## 3. Colour, space, shape

Tokens live on `:root` in `site.css`. Dark mode follows `prefers-color-scheme` and a manual toggle
(`<html data-theme="light|dark">`, stored in `localStorage` key `qp-theme`, wrapped in try/catch).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#F6F4EE` | `#121210` | page background |
| `--paper-raised` | `#FBFAF7` | `#1A1A17` | artefacts, code, header on scroll |
| `--paper-sunk` | `#EFECE4` | `#0D0D0B` | inline code, table header |
| `--ink` | `#17160F` | `#ECE9E1` | primary text |
| `--ink-2` | `#45423A` | `#B9B5AA` | secondary text, lede |
| `--ink-3` | `#6B675D` | `#8F8B80` | meta, captions (meets 4.5:1 on paper) |
| `--rule` | `#DDD8CC` | `#2B2A26` | hairlines |
| `--rule-strong` | `#C5BFB1` | `#3D3B35` | table header rule, focus of artefacts |
| `--accent` | `#0E6B4E` | `#62C29A` | the one accent: links, primary button, pass |
| `--accent-hover` | `#0A5640` | `#7FD3AE` | |
| `--accent-wash` | `#E2EDE6` | `#16261F` | pass tag background |
| `--on-accent` | `#F6F4EE` | `#0D1A14` | text on accent fill |
| `--refuse` | `#9C2B1F` | `#E5806F` | REFUSED, fail (semantic only, never decorative) |
| `--refuse-wash` | `#F3E3DE` | `#2A1714` | |
| `--caution` | `#7F5600` | `#E2B45C` | flaky, warnings |
| `--caution-wash` | `#F2E8D2` | `#2A2112` | |
| `--blocked` | `#4E5A66` | `#A3AFBB` | blocked |
| `--blocked-wash` | `#E5E8EB` | `#1C2025` | |

Every text and background pair above meets WCAG AA (4.5:1 body, 3:1 large). Check new pairs before
using them.

Space: a 4px base. `--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 32px;
--s-7: 48px; --s-8: 64px; --s-9: 96px; --s-10: 128px`. Section rhythm on the landing page is
`--s-9` (desktop) and `--s-8` (mobile).

Shape: `--radius: 4px` everywhere (buttons, artefacts, code, tags, inputs). Tags use 3px. Nothing
is fully rounded except the theme toggle's focus ring. Borders are 1px `--rule`; emphasis is a
heavier rule, not a shadow. One shadow exists, for the search dialog only:
`0 24px 64px -24px rgb(0 0 0 / 0.28)`.

Motion: colour and background transitions of 120ms, nothing else animates. Honour
`prefers-reduced-motion` by removing even those.

## 4. Layout

- Container: `max-width: 1200px`, side padding `clamp(16px, 4vw, 40px)`. No horizontal page
  scroll at any width down to 320px. Wide tables and code scroll inside their own box.
- Landing: a 12-column grid with 24px gaps on desktop, single column below 768px.
- Docs (three columns):
  - left sidebar navigation, 248px, sticky, scrolls on its own;
  - content column, prose at 68ch max;
  - right "On this page" table of contents, 208px, sticky, shown at 1200px and wider only.
  - 960 to 1199px: sidebar plus content. Below 960px: content only, and the sidebar opens as a
    full-height drawer from the header's "Menu" button (focus trapped, Escape closes, body scroll
    locked while open).

## 5. Markup contract

The build (`site/build.mjs`) produces this markup; `site.css` and `site.js` style and wire exactly
these classes. Template placeholders use `{{name}}`; `{{base}}` is the site base path with a
trailing slash (`/qa-pilot/` on Pages, `/` for a local preview).

### Shell

```html
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="site-header__inner container">
    <a class="wordmark" href="{{base}}">QA-Pilot<span class="wordmark__version">0.3</span></a>
    <nav class="site-nav" aria-label="Primary">
      <a href="{{base}}docs/">Docs</a>
      <a href="{{base}}docs/run-tests/">Running tests</a>
      <a href="{{base}}docs/production/">Production</a>
      <a href="https://github.com/SandeepTakasi/qa-pilot">GitHub</a>
    </nav>
    <button class="search-trigger" type="button" aria-label="Search the docs" data-search-open>
      <span>Search</span><kbd>/</kbd>
    </button>
    <button class="theme-toggle" type="button" aria-label="Switch colour theme" data-theme-toggle></button>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="doc-sidebar" data-menu-toggle>Menu</button>
  </div>
</header>
<main id="main"> ... </main>
<footer class="site-footer"> ... </footer>
<dialog class="search" data-search>
  <form method="dialog" class="search__form" role="search">
    <label class="visually-hidden" for="search-input">Search the docs</label>
    <input id="search-input" class="search__input" type="search" placeholder="Search the docs" autocomplete="off">
    <button class="search__close" value="close" aria-label="Close search">Esc</button>
  </form>
  <ol class="search__results" aria-live="polite"></ol>
</dialog>
```

`.menu-toggle` renders only on docs pages. Primary nav collapses into the docs drawer below 768px
on docs pages, and into a simple stacked list on the landing page.

### Docs page

```html
<div class="doc-layout container">
  <nav class="doc-sidebar" id="doc-sidebar" aria-label="Documentation">
    <p class="doc-sidebar__group">Get started</p>
    <ul>
      <li><a href="{{base}}docs/" aria-current="page">Overview</a></li>
      ...
    </ul>
    ...
  </nav>
  <article class="doc" data-pagefind-body>
    <p class="doc__eyebrow">Guides</p>
    <h1>Running in CI</h1>
    <p class="doc__lede">...</p>            <!-- only when the page has one -->
    <div class="prose"> ...rendered markdown... </div>
    <footer class="doc__footer">
      <a class="doc__edit" href="https://github.com/SandeepTakasi/qa-pilot/blob/main/{{source}}">Edit this page on GitHub</a>
      <nav class="pager" aria-label="Previous and next">
        <a class="pager__prev" href="..."><span>Previous</span>Setting up ClickUp</a>
        <a class="pager__next" href="..."><span>Next</span>Spec conventions</a>
      </nav>
    </footer>
  </article>
  <aside class="toc" aria-label="On this page">
    <p class="toc__title">On this page</p>
    <ol><li><a href="#section-id">Section</a></li> ...</ol>
  </aside>
</div>
```

Inside `.prose`:

- Headings: `<h2 id="slug">Text <a class="anchor" href="#slug" aria-label="Link to this section">#</a></h2>`
  (same for h3). The anchor shows on hover and focus only.
- Code blocks: `<figure class="code"><figcaption class="code__lang">bash</figcaption>{shiki pre}<button class="code__copy" type="button">Copy</button></figure>`.
  Shiki renders with `themes: { light: 'min-light', dark: 'min-dark' }` and `defaultColor: false`,
  so colours arrive as `--shiki-light` / `--shiki-dark` variables that `site.css` switches.
  A block with no language gets `text` and no caption.
- Tables: wrapped in `<div class="table-wrap">`.
- Inline code: plain `<code>`.
- Links to other docs pages are rewritten to their site URLs; links to other repository files go
  to `https://github.com/SandeepTakasi/qa-pilot/blob/main/<path>`; external links get
  `rel="noopener"` and no `target`.

### Landing components

```html
<section class="section" aria-labelledby="x">            <!-- vertical rhythm, top hairline -->
<p class="eyebrow">The pipeline</p>                        <!-- mono label, --ink-3 -->
<h2 class="section__title" id="x">...</h2>
<p class="lede">...</p>

<div class="cmd"><code>claude plugin install qa-pilot</code><button class="cmd__copy" type="button">Copy</button></div>
<a class="btn btn--primary" href="...">Read the docs</a>   <!-- also .btn--quiet -->

<figure class="artifact">                                  <!-- a real product artefact -->
  <figcaption class="artifact__label">writes.json</figcaption>
  <pre><code>...</code></pre>
</figure>

<span class="tag tag--pass">pass</span>                    <!-- tag--flaky, tag--fail, tag--blocked, tag--refused -->

<ol class="pipeline"> <li class="pipeline__step"> <code class="pipeline__cmd">/qa-pilot:run-tests</code> <h3>...</h3> <p>...</p> </li> </ol>
<li class="pipeline__gate">QA approves the cases</li>   <!-- a human checkpoint between steps -->

<ol class="refusals"> <li class="refusal"> <h3>...</h3> <p>...</p> <code class="refusal__out">...</code> </li> </ol>

<div class="split"> <div class="split__text">...</div> <div class="split__media">...</div> </div>
```

`site/src/styleguide.html` renders every component above in both themes, as the review surface
(excluded from search and from navigation, `noindex`).

## 6. Docs information architecture

Source of truth: `site/docs.json`. URL slugs are short and stable.

| Group | Page | Slug | Source |
|---|---|---|---|
| Get started | Overview | `docs/` | `qa-pilot/README.md` |
| Get started | Setting up a project | `docs/qa-init/` | `qa-pilot/skills/qa-init/SKILL.md` |
| Get started | Saving logins | `docs/setup-profiles/` | `qa-pilot/skills/setup-profiles/SKILL.md` |
| The pipeline | Generating cases | `docs/generate-tests/` | `qa-pilot/skills/generate-tests/SKILL.md` |
| The pipeline | Running tests | `docs/run-tests/` | `qa-pilot/skills/run-tests/SKILL.md` |
| The pipeline | Publishing results | `docs/publish-results/` | `qa-pilot/skills/publish-results/SKILL.md` |
| The pipeline | Reviewing as QA | `docs/qa-review/` | `qa-pilot/skills/qa-review/SKILL.md` |
| Guides | Spec conventions | `docs/spec-conventions/` | `qa-pilot/skills/run-tests/references/spec-conventions.md` |
| Guides | Writing cases | `docs/case-style/` | `qa-pilot/skills/generate-tests/references/case-style.md` |
| Guides | Running in CI | `docs/ci/` | `qa-pilot/SETUP-CI.md` |
| Guides | Setting up ClickUp | `docs/clickup/` | `qa-pilot/SETUP-CLICKUP.md` |
| Guides | ClickUp fields | `docs/clickup-fields/` | `qa-pilot/skills/publish-results/references/clickup-fields.md` |
| Reference | Host profile | `docs/profile/` | `qa-pilot/schemas/qa-pilot.config.schema.md` |
| Reference | Cases file | `docs/cases/` | `qa-pilot/schemas/cases.schema.md` |
| Reference | Report and gate | `docs/report/` | `qa-pilot/schemas/report.schema.md` |
| Project | Production | `docs/production/` | the "Production" section of `qa-pilot/README.md` is the overview's; this page is `site/content/production.md`, written for the site |
| Project | What it enforces | `docs/decisions/` | `qa-pilot/DECISIONS.md` |
| Project | Write guard internals | `docs/architecture/` | `docs/architecture.md` |
| Project | Decision 0001 | `docs/adr-0001/` | `docs/decisions/0001-write-signatures-default-deny.md` |
| Project | Changelog | `docs/changelog/` | `qa-pilot/CHANGELOG.md` |
| Project | Third-party notices | `docs/notices/` | `qa-pilot/THIRD_PARTY_NOTICES.md` |

Skill pages (`SKILL.md`) have YAML frontmatter: strip it, take the title from the table above, and
use the frontmatter `description` as the lede. The first `# Heading` of every source becomes the
page `<h1>` only when the table gives no title; otherwise it is dropped so the page has one h1.

## 7. Voice

Plain, exact, declarative, like the README. Say what the tool does and what it refuses, with the
reason. Short sentences are fine; fragments are not. Numbers are specific ("10% blocked halts the
run"), never "many" or "lots". The landing page may compress the README, never contradict it.

## 8. Quality bar

- Lighthouse: Performance, Accessibility, Best Practices, SEO all 100 on the landing page and a docs
  page, mobile and desktop.
- No JavaScript is required to read any page. Search, the theme toggle, copy buttons, the drawer and
  the table-of-contents highlight are progressive enhancements.
- Keyboard: every control reachable and visible on focus (`:focus-visible`, 2px `--accent` outline,
  2px offset). `/` opens search, Escape closes it, arrow keys move through results.
- Semantics: one `h1` per page, landmarks as in section 5, `aria-current="page"` in navigation.
- No analytics, no cookies, no third-party requests at all.
- Total landing page weight under 200 KB transferred, excluding fonts under 150 KB.
