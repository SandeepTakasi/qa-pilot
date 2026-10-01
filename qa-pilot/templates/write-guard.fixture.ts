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
// for setScope. Requests are only as well classified as the host's write_signatures.
//
// Under any policy but unrestricted, the request paths a spec reaches for are refused: the
// request fixture, page.request and context.request, the request export of @playwright/test
// (playwright.request.newContext), Node's global fetch(), browser.newContext and newPage
// outside the test's own context (beforeAll and beforeEach included), and every browser
// type's launch and connect. Every guarded test gets the built-in context, used or not, so
// the window that lets Playwright create it is always closed again.
//
// Not refused, and so ceilings: Node's own node:http, node:https and node:net, and calling
// a route method off the prototype (Object.getPrototypeOf(context).unrouteAll.call(...)) to
// get past the guard's replacements. Both are deliberate subversion rather than ordinary
// spec code; review catches them.

import { test as base, expect } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Page, Route, Request, TestInfo } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
  // Only the fixture knows it, so only the fixture can change the page's scope.
  readonly token = randomUUID();
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
  // The scope lives here, not on window, so the page cannot widen it. It changes only through
  // a setter that is fixed in place and needs a token the page never sees.
  let SCOPE = null;
  const TOKEN = ${JSON.stringify(state.token)};
  Object.defineProperty(window, '__qaPilotSetScope', {
    value: (token, url) => { if (token === TOKEN) SCOPE = typeof url === 'string' ? url : null; },
    writable: false, configurable: false, enumerable: false,
  });
  // Captured once, before any page script runs, so the page cannot swap it out and hide
  // the blocks it is told about.
  const bind = window.__qaPilotReport;
  const report = (e) => { try { bind(e); } catch (_) {} };
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
      { policy: POLICY.policy, prefix: POLICY.prefix, scopeUrl: SCOPE },
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
// The worker's unpatched browser.newContext, for newGuardedContext.
let workerNewContext: Browser['newContext'] | null = null;
// Open only while Playwright builds the test's own context, which it does through the public
// browser.newContext(); closed for the rest of the test and for every hook.
let builtinWindow = false;
const scopeScript = (state: GuardState, url: string) =>
  `window.__qaPilotSetScope(${JSON.stringify(state.token)}, ${JSON.stringify(url)});`;

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
  if (state.scopeUrls.length) await ctx.addInitScript({ content: scopeScript(state, state.scopeUrls.at(-1)!) });

  // Our catch-all sees every request no spec handler took. Allow and observe fall back, so
  // a spec's own routes still apply and the request otherwise reaches the network. A
  // predicate rather than a glob, so no unroute(url) can name it.
  await ctx.route(() => true, async (route) => {
    if ((await state.judge(route)) === 'pass') await route.fallback();
  });

  // A spec's own handler would run before ours (later handlers win) and could continue a
  // request unseen, so every handler a spec registers is made to ask the guard first. They
  // are tracked, so unroute and unrouteAll remove exactly the spec's own handlers (by the
  // original handler, too) and never the guard's.
  const wrap = (handler: any) => async (route: Route, request: Request) => {
    if ((await state.judge(route)) === 'pass') return handler(route, request);
  };
  const patchRoutes = (target: BrowserContext | Page) => {
    const route = target.route.bind(target);
    const unroute = target.unroute.bind(target);
    const tracked: { url: any; handler: any; wrapped: any }[] = [];
    (target as any).route = (url: any, handler: any, options?: any) => {
      const wrapped = wrap(handler);
      tracked.push({ url, handler, wrapped });
      return route(url, wrapped, options);
    };
    // The same URL as Playwright judges it: a RegExp by its source and flags, anything else
    // by value.
    const sameUrl = (a: any, b: any) => a === b
      || (a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags);
    (target as any).unroute = async (url: any, handler?: any) => {
      for (const t of tracked.filter((x) => sameUrl(x.url, url) && (!handler || x.handler === handler))) {
        tracked.splice(tracked.indexOf(t), 1);
        await unroute(t.url, t.wrapped);
      }
    };
    (target as any).unrouteAll = async () => {
      for (const t of tracked.splice(0)) await unroute(t.url, t.wrapped);
    };
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
  if (!current || !workerNewContext) throw new Error('newGuardedContext() can only be called inside a test that uses the write guard');
  const ctx = await workerNewContext({ ...options, serviceWorkers: 'block' });
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

type Fixtures = { writeGuard: WriteGuard; guardState: GuardState; _writeGuardOpen: void; _writeGuardContext: void };

export const test = base.extend<Fixtures, { _writeGuardWorker: void }>({
  // Service workers can issue requests the route never sees.
  serviceWorkers: 'block',

  // Once per worker, so beforeAll hooks are covered: every way to get a browser, context or
  // request client the guard does not sit in front of is refused.
  _writeGuardWorker: [async ({ browser, playwright }, use) => {
    const { policy } = readPolicy(); // malformed input fails the whole worker, never runs unguarded
    workerNewContext = browser.newContext.bind(browser);
    const restore: (() => void)[] = [];
    const lock = (obj: any, name: string, label: string, allow?: () => boolean) => {
      if (typeof obj?.[name] !== 'function') return;
      const original = obj[name];
      restore.push(() => { obj[name] = original; });
      obj[name] = async (...args: any[]) => {
        if (allow?.()) return original.apply(obj, args);
        throw refuse(label, policy);
      };
    };
    if (policy !== 'unrestricted') {
      lock(browser, 'newContext', 'browser.newContext() (use newGuardedContext instead)', () => builtinWindow);
      lock(browser, 'newPage', 'browser.newPage() (use newGuardedContext instead)');
      lock(playwright.request, 'newContext', 'request.newContext() (the request export of @playwright/test)');
      // globalThis.fetch: Node's own fetch, the obvious workaround once the request fixture refuses.
      lock(globalThis, 'fetch', 'fetch() (Node\'s own, from the spec)');
      for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
        for (const m of ['launch', 'launchPersistentContext', 'launchServer', 'connect', 'connectOverCDP']) {
          lock(type, m, `${type.name()}.${m}()`);
        }
      }
    }
    try {
      await use();
    } finally {
      for (const r of restore.reverse()) r();
      workerNewContext = null;
    }
  }, { scope: 'worker', auto: true }],

  // Registered before the context fixture is forced below, so the window is open exactly while
  // Playwright builds this test's context, and shut whatever happens.
  _writeGuardOpen: [async ({}, use) => {
    builtinWindow = true;
    try { await use(); } finally { builtinWindow = false; }
  }, { auto: true }],

  // Every guarded test gets the built-in context, so the window always closes in the context
  // fixture below rather than staying open through a test that never asked for a page.
  _writeGuardContext: [async ({ context }, use) => { await use(); }, { auto: true }],

  guardState: async ({}, use) => {
    const { policy, prefix } = readPolicy();
    const raw = readRawConfig();
    const state = new GuardState(policy, prefix, raw, compileConfig(raw, DEFAULT_DENY));
    await use(state);
  },

  // Wraps the built-in context rather than creating one, so storageState, video and trace
  // settings all survive.
  context: async ({ context, guardState }, use, testInfo: TestInfo) => {
    builtinWindow = false; // Playwright has built the context; nothing else may.
    await installGuard(context, guardState);
    current = { state: guardState, newContext: workerNewContext! };
    try {
      await use(context);
    } finally {
      current = null;
      // Extra contexts from newGuardedContext belong to this test's record. Close them before
      // the record is written, so one kept past the test cannot keep writing into nothing.
      for (const extra of guardState.contexts) if (extra !== context) await extra.close().catch(() => {});
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
          await ctx.addInitScript({ content: scopeScript(guardState, url) });
          for (const p of ctx.pages()) {
            await p.evaluate(([t, u]) => (window as any).__qaPilotSetScope(t, u), [guardState.token, url]).catch(() => {});
          }
        }
      },
    });
  },
});

export { expect };
