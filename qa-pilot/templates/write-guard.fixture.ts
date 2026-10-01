// QA-Pilot write guard: the Playwright wiring. Copy next to write-guard.mjs in your spec
// directory, and import `test` and `expect` from here instead of '@playwright/test'.
//
// It enforces the feature's mutation policy (cases.yaml `mutation`) without any help from
// the specs: they call ordinary locator.click(). Controls are judged in the page, by
// capture-phase listeners injected before any app script runs; requests are judged at the
// network layer. Each test attempt leaves a writes.json the publish gate re-reads, so a
// guard that never ran cannot pass for a clean run.
//
//   QA_PILOT_MUTATION         {"policy": "...", "prefix": "..."}; unset means read-only
//   QA_PILOT_MUTATION_CONFIG  the host profile's mutation block, as JSON
//   QA_PILOT_FIXTURE_DIR      where shared-fixture identities live for this run
//
// Schemas: qa-pilot/schemas/report.schema.md ("The write guard's record") and
// cases.schema.md ("May these tests write?").
//
// ponytail: ceilings, by design. Not seen: drag-and-drop, pointer or mouse handlers that act
// before click, keyboard activation other than Enter/Space, WebSocket frames, routeFromHAR,
// popups opened outside the guarded context, and frames other than each page's main frame
// for setScope. A spec's route handlers are wrapped, so unroute(url, handler) with the
// original handler does not remove them; unroute(url) does. Requests are only as well
// classified as the host's write_signatures.

import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Page, Route, Request, TestInfo } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DENY, compileConfig, decideControl, decideRequest } from './write-guard.mjs';

type Policy = 'read-only' | 'scoped-write' | 'unrestricted';
type GuardEvent = {
  kind: 'control' | 'request'; action: 'block' | 'observe'; reason: string;
  label?: string; method?: string; url?: string; at: string;
};

const POLICIES: Policy[] = ['read-only', 'scoped-write', 'unrestricted'];
const PREFIX_RE = /^[A-Za-z0-9_-]{3,}$/;

/** The declared policy. Unset is read-only; anything malformed throws, never unrestricted. */
function readPolicy(): { policy: Policy; prefix: string | null } {
  const raw = process.env.QA_PILOT_MUTATION;
  if (raw === undefined || raw.trim() === '') return { policy: 'read-only', prefix: null };
  let v: any;
  try { v = JSON.parse(raw); } catch {
    throw new Error('QA_PILOT_MUTATION is not valid JSON; refusing to run unguarded');
  }
  if (!POLICIES.includes(v?.policy)) throw new Error(`QA_PILOT_MUTATION.policy must be one of ${POLICIES.join(' | ')}`);
  if (v.policy === 'scoped-write') {
    if (typeof v.prefix !== 'string' || !PREFIX_RE.test(v.prefix)) {
      throw new Error(`QA_PILOT_MUTATION.prefix must match ${PREFIX_RE.source} under scoped-write`);
    }
    return { policy: v.policy, prefix: v.prefix };
  }
  if (v.prefix !== undefined && v.prefix !== null) throw new Error('QA_PILOT_MUTATION.prefix is only allowed under scoped-write');
  return { policy: v.policy, prefix: null };
}

/** The host's raw mutation block. Unset means the generic defaults and no signatures. */
function readRawConfig(): unknown {
  const raw = process.env.QA_PILOT_MUTATION_CONFIG;
  if (raw === undefined || raw.trim() === '') return null;
  try { return JSON.parse(raw); } catch {
    throw new Error('QA_PILOT_MUTATION_CONFIG is not valid JSON; refusing to run with a guard that knows no writes');
  }
}

/** Everything one test attempt's guard knows. One per test, shared by every guarded context. */
class GuardState {
  installed = false;
  routed = 0;
  blocked = 0;
  observed = 0;
  events: GuardEvent[] = [];
  scopeUrls: string[] = [];
  decided = new WeakSet<Request>();
  contexts: BrowserContext[] = [];
  constructor(
    readonly policy: Policy,
    readonly prefix: string | null,
    readonly raw: unknown,
    readonly cfg: ReturnType<typeof compileConfig>,
  ) {}

  record(): object {
    return {
      installed: this.installed,
      policy: this.policy,
      prefix: this.prefix,
      scope_urls: this.scopeUrls,
      write_signatures: this.cfg.writes.length,
      routed_requests: this.routed,
      blocked: this.blocked,
      observed: this.observed,
      events: this.events,
    };
  }

  /** Decide a request once, however many route handlers see it. */
  async judge(route: Route): Promise<'abort' | 'pass'> {
    const req = route.request();
    if (this.decided.has(req)) return 'pass';
    this.decided.add(req);
    this.routed++;
    const v = decideRequest({ method: req.method(), url: req.url(), body: req.postData() }, { policy: this.policy }, this.cfg);
    if (v.action === 'allow') return 'pass';
    const ev: GuardEvent = { kind: 'request', action: v.action, reason: v.reason, method: req.method(), url: req.url(), at: new Date().toISOString() };
    this.events.push(ev);
    if (v.action === 'block') { this.blocked++; await route.abort('blockedbyclient'); return 'abort'; }
    this.observed++;
    return 'pass';
  }
}

// The page side. Built from source, because a capture-phase listener must decide
// synchronously and cannot await Node. Reports are fire-and-forget so a navigation that
// follows a blocked click cannot lose them.
function pageScript(state: GuardState): string {
  return `(() => {
  if (window.__qaPilotGuard) return;
  window.__qaPilotGuard = true;
  const compileConfig = ${compileConfig.toString()};
  const decideControl = ${decideControl.toString()};
  const cfg = compileConfig(${JSON.stringify(state.raw)}, ${JSON.stringify(DEFAULT_DENY)});
  const POLICY = ${JSON.stringify({ policy: state.policy, prefix: state.prefix })};
  const report = (e) => { try { window.__qaPilotReport(e); } catch (_) {} };
  const ROW = 'tr, [role=row], li, [role=listitem], .v-list-item';
  const CONTROL = 'button, a, [role=button], [role=menuitem], [role=link], [role=tab], input[type=submit], input[type=button], input[type=image], summary, [onclick], [tabindex]';
  // The control's own row, or the dialog holding it, never a container of several rows.
  const ownRowText = (el) => {
    const parts = [];
    for (const scope of [el.closest(ROW), el.closest('[role=dialog]')]) {
      if (!scope || scope.querySelectorAll(ROW).length > 1) continue;
      parts.push(scope.innerText || '');
      for (const i of scope.querySelectorAll('input, textarea')) parts.push(i.value || '');
    }
    return parts.join('\\n');
  };
  const labelOf = (el) => {
    for (const v of [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.value]) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const iconsOf = (el) => {
    const out = [];
    for (const n of [el, ...el.querySelectorAll('[class]')]) {
      for (const c of (typeof n.className === 'string' ? n.className : n.getAttribute('class') || '').split(/\\s+/)) if (c) out.push(c);
    }
    return out;
  };
  const judge = (target, e) => {
    if (!(target instanceof Element)) return;
    const el = target.closest(CONTROL) || target;
    const label = labelOf(el);
    const v = decideControl(
      { label, icons: iconsOf(el), pageUrl: location.href, ownRowText: ownRowText(el) },
      { policy: POLICY.policy, prefix: POLICY.prefix, scopeUrl: window.__qaPilotScope || null },
      cfg,
    );
    if (v.action !== 'block') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    report({ kind: 'control', action: 'block', reason: v.reason, label: label.slice(0, 120), at: new Date().toISOString() });
  };
  window.addEventListener('click', (e) => judge(e.target, e), true);
  window.addEventListener('submit', (e) => judge(e.submitter || e.target, e), true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') judge(document.activeElement || e.target, e);
  }, true);
  report({ kind: 'heartbeat' });
})();`;
}

let current: { state: GuardState; newContext: Browser['newContext'] } | null = null;

const refuse = (what: string, policy: Policy) => new Error(
  `${what} is disabled under mutation policy ${policy}: it sends requests the write guard cannot see. ` +
  'Drive the app through the page, or declare the feature unrestricted where that is allowed.');

/** Install the guard on one context: binding, init script, network route, wrapped routes. */
async function installGuard(ctx: BrowserContext, state: GuardState): Promise<void> {
  state.contexts.push(ctx);
  await ctx.exposeBinding('__qaPilotReport', (_source, e: any) => {
    if (e?.kind === 'heartbeat') { state.installed = true; return; }
    if (e?.kind === 'control' && e.action === 'block') { state.blocked++; state.events.push(e); }
  });
  await ctx.addInitScript({ content: pageScript(state) });
  if (state.scopeUrls.length) {
    await ctx.addInitScript({ content: `window.__qaPilotScope = ${JSON.stringify(state.scopeUrls.at(-1))};` });
  }

  // Our catch-all sees every request no spec handler took. Allow and observe fall back, so
  // a spec's own routes still apply and the request otherwise reaches the network.
  await ctx.route('**/*', async (route) => {
    if ((await state.judge(route)) === 'pass') await route.fallback();
  });

  // A spec's own handler would run before ours (later handlers win) and could continue a
  // request unseen, so every handler a spec registers is made to ask the guard first.
  const wrap = (handler: any) => async (route: Route, request: Request) => {
    if ((await state.judge(route)) === 'pass') return handler(route, request);
  };
  const patchRoutes = (target: BrowserContext | Page) => {
    const route = target.route.bind(target);
    (target as any).route = (url: any, handler: any, options?: any) => route(url, wrap(handler), options);
  };
  patchRoutes(ctx);

  // The request object stays readable, because Playwright's own teardown reads it; only the
  // methods that would send something are refused.
  const SENDS = new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'head']);
  const lockRequest = (target: BrowserContext | Page, name: string) => {
    if (state.policy === 'unrestricted') return;
    const original = (target as any).request;
    const locked = new Proxy(original, {
      get(obj, prop) {
        if (typeof prop === 'string' && SENDS.has(prop)) {
          return async () => { throw refuse(`${name}.${prop}()`, state.policy); };
        }
        const v = Reflect.get(obj, prop, obj);
        return typeof v === 'function' ? v.bind(obj) : v;
      },
    });
    Object.defineProperty(target, 'request', { get: () => locked, configurable: true });
  };
  lockRequest(ctx, 'context.request');
  const onPage = (page: Page) => {
    patchRoutes(page);
    lockRequest(page, 'page.request');
    // A native confirm() before a delete is a write path too: decline it under read-only.
    if (state.policy === 'read-only') page.on('dialog', (d) => d.dismiss().catch(() => {}));
  };
  for (const p of ctx.pages()) onPage(p);
  ctx.on('page', onPage);
}

/**
 * A second browser context for a cross-app spec, guarded exactly like the built-in one and
 * recorded in the same writes.json. browser.newContext() is disabled under any policy but
 * unrestricted; use this instead.
 */
export async function newGuardedContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
  if (!current) throw new Error('newGuardedContext() can only be called inside a test that uses the write guard');
  const ctx = await current.newContext({ ...options, serviceWorkers: 'block' });
  await installGuard(ctx, current.state);
  return ctx;
}

/** Record a shared fixture's identity, for the cases that run inside it. */
export function saveFixture(name: string, identity: unknown): void {
  const dir = fixtureDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(identity, null, 2));
}

/** Read a shared fixture's identity, written by its setup spec in this run. */
export function loadFixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureDir(), `${name}.json`), 'utf8'));
}

function fixtureDir(): string {
  const dir = process.env.QA_PILOT_FIXTURE_DIR;
  if (!dir) throw new Error('QA_PILOT_FIXTURE_DIR is not set; /qa-pilot:run-tests sets it to this run\'s fixtures directory');
  return dir;
}

type WriteGuard = {
  readonly policy: Policy;
  /** Allow write controls on pages whose URL matches this regex (scoped-write only). */
  setScope(scope: { url: string }): Promise<void>;
};

export const test = base.extend<{ writeGuard: WriteGuard; guardState: GuardState }>({
  // Service workers can issue requests the route never sees.
  serviceWorkers: 'block',

  guardState: async ({}, use) => {
    const { policy, prefix } = readPolicy();
    const raw = readRawConfig();
    const state = new GuardState(policy, prefix, raw, compileConfig(raw, DEFAULT_DENY));
    await use(state);
  },

  // Wraps the built-in context rather than creating one, so storageState, video and trace
  // settings all survive.
  context: async ({ context, browser, guardState }, use, testInfo: TestInfo) => {
    await installGuard(context, guardState);
    const newContext = browser.newContext.bind(browser);
    const newPage = browser.newPage.bind(browser);
    if (guardState.policy !== 'unrestricted') {
      browser.newContext = (async () => { throw refuse('browser.newContext() (use newGuardedContext instead)', guardState.policy); }) as any;
      browser.newPage = (async () => { throw refuse('browser.newPage() (use newGuardedContext instead)', guardState.policy); }) as any;
    }
    current = { state: guardState, newContext };
    try {
      await use(context);
    } finally {
      current = null;
      browser.newContext = newContext;
      browser.newPage = newPage;
      // Written once, then attached by path. The gate matches this file to Playwright's copy
      // by sha256, so it must not change after this.
      const file = testInfo.outputPath('writes.json');
      writeFileSync(file, JSON.stringify(guardState.record(), null, 2));
      await testInfo.attach('writes.json', { path: file, contentType: 'application/json' });
    }
  },

  request: async ({ request, guardState }, use) => {
    if (guardState.policy !== 'unrestricted') throw refuse('The request fixture', guardState.policy);
    await use(request);
  },

  writeGuard: async ({ guardState }, use) => {
    await use({
      policy: guardState.policy,
      async setScope({ url }) {
        new RegExp(url); // a scope that does not compile is a spec bug; fail here, not silently
        guardState.scopeUrls.push(url);
        for (const ctx of guardState.contexts) {
          // Later documents get the new scope; the current ones are updated in place.
          await ctx.addInitScript({ content: `window.__qaPilotScope = ${JSON.stringify(url)};` });
          for (const p of ctx.pages()) await p.evaluate((u) => { (window as any).__qaPilotScope = u; }, url).catch(() => {});
        }
      },
    });
  },
});

export { expect };
