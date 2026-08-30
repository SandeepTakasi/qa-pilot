# QA-Pilot

Evidence-first feature testing for Claude Code. Any developer can generate and execute feature tests in their own session; every executed case produces the same report structure with mandatory evidence; QA reviews instead of executing; ClickUp holds one live view of testing confidence per feature.

The design rests on two ideas. **Uniformity is enforced by tooling, not discipline** — anything that depends on five people remembering a convention during crunch fails inside a week. And **the committed Playwright spec is the durable asset** — agentic sessions are scaffolding that authors and triages; the spec is what runs today for evidence and forever in CI.

## The pipeline

```
/qa-init          →  discover the host repo, write qa-pilot.config.yaml   (once per project)
/setup-profiles   →  log in once per account, save the session            (once per developer)
/generate-tests   →  author cases.yaml, create ClickUp tasks              (per feature)
      ↓  QA approves the scenario matrix and the cases
/run-tests        →  committed specs run against a deployed env, with evidence
/publish-results  →  validate, then write verdicts and evidence to ClickUp
/qa-review        →  QA's queue: approve, reject with a reason, or retest
```

## What it refuses to do

These are gates, not warnings. Each one exists because the alternative silently produces confidence nobody should have.

- **A verdict without evidence.** A Playwright trace and a deploy SHA read from the environment are required for every executed case. The publish script refuses the report; QA never has to police it.
- **A verdict from anywhere but a committed spec run.** An agentic browser session produces no video, no trace, no machine-readable result — so it structurally cannot publish. "Claude clicked through it and it looked fine" is the claim this system exists to kill.
- **A verdict from a local or sandbox environment.** Mock backends are seeded and always succeed. Runs against them are useful for stabilizing specs and are stamped as such, but they cannot carry a verdict.
- **A pass that was really a retry.** Pass-on-retry is recorded `flaky`, always, derived from the attempt results rather than from Playwright's own status field so no config change can turn it green.
- **A verdict from a case QA never approved.**
- **A run that lost its ground truth.** If the deployed build changes mid-run, every case is `blocked` — half tested one build and half another. If more than 10% of cases are blocked, the run halts: the environment failed, not the feature.

## Evidence

One artifact per case per run: **`trace.zip`, attached to the case's ClickUp task.** A trace carries the video byte-for-byte, the console output, the screenshot film-strip, DOM snapshots and the network log — so it replaces uploading a video and a console log separately, which would store the same bytes twice and split one investigation across three files.

Reviewers drag it onto <https://trace.playwright.dev>, which runs entirely in the browser and transmits nothing. No second storage system, no extra credentials, and the evidence sits on the task the reviewer is already looking at.

You set up the ClickUp side once, by hand — the plugin writes into it but does not create it. [SETUP-CLICKUP.md](./SETUP-CLICKUP.md) is the exact checklist: the statuses, the custom fields and their options, and the two settings that matter (**Private Attachment Links**, off by default and leaving attachment URLs public; and a **per-developer API token**, since the 100 requests/minute budget is per token, not per person). Fifteen minutes, once per workspace. `/qa-init` reminds you and fills in the host-specific dropdown values.

Retention is manual — ClickUp has no delete-attachment endpoint, so traces are pruned from task attachment lists by hand. Budget a quarterly pass: oldest passing runs first, keep every failure.

## Portability

The plugin ships generic. Everything project-specific — environment URLs, auth mechanics, selector policy, assertion constraints, evidence requirements, propagation windows — lives in `qa-pilot.config.yaml`, committed in the consuming repo and owned by QA. Onboarding a second project is one `/qa-init` run and a profile review, with no plugin-code changes.

## Install

```bash
claude plugin marketplace add <this-repo-url>
claude plugin install qa-pilot
```

Or for local development: `claude --plugin-dir /path/to/QAED/qa-pilot`.

Requires Node ≥ 18 (scripts are zero-dependency ESM) and, in the host repo, Playwright ≥ 1.51 — `storageState({ indexedDB: true })` landed there, and IndexedDB-persisted auth such as Firebase silently fails to restore below it.

## Model fitting

| Stage | Model |
|---|---|
| `generate-tests` | **The strongest available.** Case design is the only stage where model judgment decides quality, and the 25-case cap makes it cheap. The host profile's `models.generation_approved` gates this: cases stamped with an unapproved model are rejected by the validator, so a model upgrade cannot quietly change what the suite tests. |
| `run-tests` | Sonnet-class for ordinary spec authoring; reach higher for cross-app multi-context specs and stubborn flake triage. |
| everything else | Any current model. Discovery, mechanical writes, and presentation. |

Execution itself costs no tokens: it is `npx playwright test`.

## Layout

```
skills/            the five entry points plus setup-profiles
scripts/           deterministic validators and transforms (zero deps, node --test)
schemas/           the host profile, case, and report contracts
hooks/             ClickUp write guard — the scripted path is the only write path
SETUP-CLICKUP.md   one-time workspace setup you do by hand
```

The only third-party code is `scripts/lib/yaml.mjs`, a bundled copy of [yaml](https://github.com/eemeli/yaml) (MIT). Node ships no YAML parser, the host profile is hand-edited by QA and needs comments (so JSON is out), and bundling keeps consuming repos install-free.

## Development

```bash
node --test "qa-pilot/scripts/tests/*.test.mjs"
claude plugin validate ./qa-pilot
```
