// QA-Pilot write guard: the decision logic. Copy next to write-guard.fixture.ts in your
// repo; the fixture wires these functions into Playwright. Zero dependencies, no I/O.
//
// Every function below is self-contained: it references nothing outside its own arguments,
// because the fixture injects their source text into the page (a capture-phase click
// listener must decide synchronously, so it cannot call back into Node). Keep it that way.
// Schemas: qa-pilot/schemas/qa-pilot.config.schema.md ("What counts as a write") and
// cases.schema.md ("May these tests write?").
//
// ponytail: ceilings, by design. Not seen: drag-and-drop, keyboard activation other than
// Enter/Space, WebSocket frames, and popups opened outside the guarded context. Requests are
// only as well classified as the host's write_signatures make them.

// Generic on purpose. Host-specific words and icons belong in the host profile's
// mutation.deny_controls, which is added to these, never replacing them.
export const DEFAULT_DENY = {
  text: ['save', 'delete', 'remove', 'publish', 'share', 'submit', 'send', 'archive', 'upload',
    'import', 'rename', 'duplicate', 'update', 'confirm', 'pay', 'purchase', 'invite', 'reset',
    'restore', 'approve', 'reject', 'log out', 'sign out'],
  icons: ['mdi-delete', 'mdi-trash', 'mdi-pencil', 'mdi-content-save', 'mdi-share', 'mdi-upload',
    'mdi-send', 'mdi-archive', 'mdi-logout'],
};

/**
 * Compile the host profile's raw `mutation` block (JSON, as QA_PILOT_MUTATION_CONFIG carries
 * it) onto the defaults. Throws on anything malformed, so a broken config fails every test
 * instead of guarding nothing.
 * @returns {{ text: RegExp, icons: string[], writes: object[], allows: object[] }}
 */
export function compileConfig(raw, defaults) {
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*'];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const list = (v, at) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`mutation.${at}: must be a list`);
    return v;
  };
  const compile = (src, at, flags) => {
    if (typeof src !== 'string' || src === '') throw new Error(`mutation.${at}: must be a non-empty regex string`);
    try { return new RegExp(src, flags); } catch (e) { throw new Error(`mutation.${at}: does not compile: ${e.message}`); }
  };
  const signatures = (v, key) => list(v, key).map((s, i) => {
    const at = `${key}[${i}]`;
    if (!isObj(s)) throw new Error(`mutation.${at}: must be a mapping`);
    if (!METHODS.includes(s.method)) throw new Error(`mutation.${at}.method: must be one of ${METHODS.join(' | ')}`);
    return {
      method: s.method,
      url: compile(s.url, `${at}.url`, ''),
      body: s.body === undefined || s.body === null ? null : compile(s.body, `${at}.body`, ''),
    };
  });

  const cfg = raw ?? {};
  if (!isObj(cfg)) throw new Error('mutation: must be a mapping');
  const deny = cfg.deny_controls ?? {};
  if (!isObj(deny)) throw new Error('mutation.deny_controls: must be a mapping');

  // Default verbs match as whole words ("save", not "saved"); host patterns are regexes.
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hostText = list(deny.text, 'deny_controls.text');
  hostText.forEach((s, i) => compile(s, `deny_controls.text[${i}]`, 'i'));
  const parts = [`\\b(?:${defaults.text.map(escape).join('|')})\\b`, ...hostText.map((s) => `(?:${s})`)];
  const hostIcons = list(deny.icons, 'deny_controls.icons');
  if (!hostIcons.every((s) => typeof s === 'string' && s !== '')) {
    throw new Error('mutation.deny_controls.icons: every entry must be a non-empty string');
  }

  return {
    text: new RegExp(parts.join('|'), 'i'),
    icons: [...defaults.icons, ...hostIcons],
    writes: signatures(cfg.write_signatures, 'write_signatures'),
    allows: signatures(cfg.allow_signatures, 'allow_signatures'),
  };
}

/**
 * Decide one control activation. The caller computes `ownRowText` (the control's own row
 * or dialog, per the cases schema) and `icons` (the control's icon class names).
 * @returns {{ action: 'allow' | 'block', reason: string }}
 */
export function decideControl({ label, icons, pageUrl, ownRowText }, { policy, prefix, scopeUrl }, cfg) {
  const text = String(label ?? '').trim();
  const icon = (icons ?? []).find((c) => cfg.icons.some((p) => String(c).startsWith(p)));
  const textHit = text !== '' && cfg.text.test(text);
  if (!textHit && !icon) return { action: 'allow', reason: 'not a write control' };
  const what = textHit ? `"${text.slice(0, 80)}" matches a deny word` : `icon ${icon} matches a deny icon`;

  if (policy === 'unrestricted') return { action: 'allow', reason: `${what}; policy unrestricted` };
  if (policy === 'scoped-write') {
    let inScopeUrl = false;
    try { inScopeUrl = typeof scopeUrl === 'string' && scopeUrl !== '' && new RegExp(scopeUrl).test(String(pageUrl ?? '')); } catch { inScopeUrl = false; }
    if (inScopeUrl) return { action: 'allow', reason: `${what}; page is inside the scope URL` };
    if (typeof prefix === 'string' && prefix !== '' && String(ownRowText ?? '').includes(prefix)) {
      return { action: 'allow', reason: `${what}; its own row carries the prefix` };
    }
    return { action: 'block', reason: `${what}; outside the scoped-write scope` };
  }
  if (policy === 'read-only') return { action: 'block', reason: `${what}; policy read-only` };
  return { action: 'block', reason: `${what}; unknown policy "${policy}"` };
}

/**
 * Decide one network request. `body` is `request.postData()`, null when there is none.
 * @returns {{ action: 'allow' | 'block' | 'observe', reason: string }}
 */
export function decideRequest({ method, url, body }, { policy }, cfg) {
  const m = String(method ?? '').toUpperCase();
  const u = String(url ?? '');
  const matches = (s) => (s.method === '*' || s.method === m) && s.url.test(u)
    && (s.body === null || (typeof body === 'string' && s.body.test(body)));
  const hit = cfg.writes.findIndex(matches);
  if (hit === -1) return { action: 'allow', reason: 'matches no write signature' };
  const allowed = cfg.allows.findIndex(matches);
  if (allowed !== -1) return { action: 'allow', reason: `allow_signatures[${allowed}] marks it a read` };
  const what = `${m} matches write_signatures[${hit}]`;
  if (policy === 'read-only') return { action: 'block', reason: `${what}; policy read-only` };
  if (policy === 'scoped-write' || policy === 'unrestricted') return { action: 'observe', reason: `${what}; recorded under ${policy}` };
  return { action: 'block', reason: `${what}; unknown policy "${policy}"` };
}
