# What QA-Pilot enforces, and why

A record of the technology this plugin requires of a host project, how tightly each choice
is bound in, and what it would cost to change. Written so the question does not have to be
re-litigated from memory every time someone new looks at it.

Last verified 2026-08-30, against the commands in the final section.

## Enforced

| Requirement | Depth | Reason |
|---|---|---|
| Claude Code | Absolute | It is a plugin. There is no version of this that runs elsewhere. |
| Playwright | Hard, deliberate | The deepest coupling in the system, and the one worth having. See below. |
| Node 18 or newer | Trivial | Scripts are zero-dependency ESM. Any machine running Vite already qualifies. |
| Git | Trivial | The host profile must be committed, so five developers share one definition of the truth rather than five local ones. |
| ClickUp | Surface only | Much shallower than the name suggests. See below. |
| YAML for config | Cosmetic | One file, one vendored parser. Chosen over JSON because the profile is hand-edited by QA and needs comments. |
| Deployed environments with a readable build SHA | Hard, but it is process rather than technology | Applies whatever tracker or runner you use. A verdict that cannot be pinned to a build is not a verdict. |

## Deliberately not enforced

Worth stating, because it is the longer list and people assume otherwise.

No frontend framework assumption: nothing in the plugin knows or cares about Vue, React, or
anything else. No test-id attribute name. No assertion style. No mock-mode mechanism. No
status vocabulary. No spec directory layout. No environment naming.

No CI system either, with one qualification worth being exact about. `ci-gate.mjs` is plain
Node and knows nothing about any runner; it answers "what did QA approve" and "what does
this run mean for the build", and the runner invokes the tests. What ships GitHub-shaped is
`templates/qa-pilot-ci.yml`, a file hosts copy and edit. Porting it is a translation of six
steps, not a change to the plugin.

All of those live in the committed host profile, which is the whole portability premise:
onboarding a second project is one `/qa-init` run, not a fork.

## ClickUp is shallower than it looks

**No script in this plugin talks to ClickUp.** Not one network call. Every ClickUp mention
inside `scripts/` is a comment, a doc-string, a warning message, or a read of
`profile.clickup.statuses`.

That is a happy accident rather than foresight. Scripts cannot call MCP tools, so the writes
had to live in skill instructions. That constraint left the deterministic core
tracker-agnostic:

- `case-status.mjs` consumes a plain `{"CASE-ID": "status"}` JSON produced by the model. It
  has no idea where those statuses came from.
- `validate-report.mjs` takes two plain JSON objects: `--map` for key membership, and
  `--statuses` for the status each case carried when it ran. It resolves those status
  names through `clickup.statuses` in the profile, which is a host's own vocabulary rather
  than anything ClickUp-shaped, and it never learns where the names came from.
- `report.json` contains no tracker-specific field at all.

Real coupling is confined to three places: the `clickup-guard.mjs` hook and its matcher in
`hooks.json`, the skill prose that names ClickUp MCP tools, and five profile fields
(`plan_tier`, `space`, `folder`, `bug_list`, `statuses`). Of those five, only `plan_tier`
is genuinely ClickUp-shaped; the rest name a place and a vocabulary that any tracker has.

**Cost to support Jira, Linear, or GitHub Issues: roughly a day, almost entirely prose.**
Rename `clickup-map.json` to `tracker-map.json`, rename the profile block to `tracker:` with
a `type:` discriminator, generalise the guard matcher, and rewrite the three skill sections
that name MCP tools. The scripts barely change.

## Playwright is deep, and that is the point

This is the real lock-in:

- `parse-report.mjs` parses Playwright's specific JSON reporter shape, including its status
  vocabulary (`expected`, `unexpected`, `timedOut`, `interrupted`) and its per-project
  `tests[]` nesting.
- `save-storage-state.mjs` uses the Playwright API directly, and
  `storageState({ indexedDB: true })` has no equivalent in other runners.
- **The evidence model is the trace.** One file carrying the video, console output, DOM
  snapshots, network log, and a scrubable film-strip, openable client-side at
  trace.playwright.dev with no upload and no account.

**Cost to support another runner: one adapter, but you would be trading away the best part
of the design.** `parse-report.mjs` is the seam, since `report.json` downstream is generic,
so a Cypress adapter is about 180 lines. What does not survive the move is the trace:
Cypress has videos and screenshots, but nothing equivalent to a single-file time-travel
artifact, so evidence would go back to three files and a worse review experience.

Recommendation: treat Playwright as a fixed premise. If a host cannot use it, this is the
wrong tool for that host.

## The position

For a team already on ClickUp, enforcing it is fine, and the plugin now speaks the host's own
status vocabulary rather than imposing one.

For wider distribution, ClickUp is the weakest constraint, and that is acceptable, because
the expensive kind of lock-in is the kind buried in business logic. This one is in prose and
a hook matcher.

**Do not build a tracker abstraction speculatively.** With one team on one tracker it buys
nothing and costs clarity in every skill file. If a second project ever adopts this on a
different tracker, do the renames then, as part of that adoption.

## Re-verifying these claims

The measurements above will rot if the code changes. Re-run these before trusting them:

```bash
# 1. No script may call the ClickUp API. Expected output: nothing.
grep -rn 'api\.clickup\|clickup\.com' qa-pilot/scripts/ | grep -v yaml.mjs

# 2. Only the guard may know ClickUp tool names.
#    Expected output: qa-pilot/scripts/clickup-guard.mjs, and nothing else.
grep -rl 'mcp__' qa-pilot/scripts/*.mjs qa-pilot/scripts/lib/*.mjs | grep -v yaml.mjs

# 3. Where Playwright coupling lives. Expected exactly these five:
#      lib/profile.mjs          version floor check only
#      parse-report.mjs         the real one: parses the JSON reporter format
#      save-storage-state.mjs   the other real one: uses the Playwright API
#      validate-report.mjs      mentions it in messages only
#      bug-report.mjs           mentions it in the bug text only
#    ci-gate.mjs must NOT appear: it reasons about approval and verdicts, and
#    the runner is what knows how to invoke a test.
grep -rl 'playwright' qa-pilot/scripts/*.mjs qa-pilot/scripts/lib/*.mjs \
  | grep -v yaml.mjs | sort
```

If command 1 prints anything, a script has started calling ClickUp and the tracker-agnostic
core is gone. If command 2 lists a second file, tracker knowledge has leaked out of the
guard. Either way this document is out of date and the day-to-swap estimate no longer holds.
