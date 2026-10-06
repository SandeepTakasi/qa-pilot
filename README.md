# QA-Pilot

**Evidence-first feature testing for Claude Code.** A verdict you can open, not a claim.

QA-Pilot runs feature tests against a deployed environment and publishes a verdict only after a
script has checked its evidence. Every executed case leaves a committed Playwright spec, a trace,
and the deploy SHA read from the running environment, so QA reviews evidence instead of re-running
the tests. ClickUp holds the record, or plain local files when you run without a tracker.

**Documentation:** [sandeeptakasi.github.io/qa-pilot](https://sandeeptakasi.github.io/qa-pilot/)

## Install

```bash
claude plugin marketplace add https://github.com/SandeepTakasi/qa-pilot
claude plugin install qa-pilot
```

Requires Node 20 or newer and, in the repo you test, Playwright 1.51 or newer. Then run
`/qa-pilot:qa-init` in that repo to write its host profile:
[Setting up a project](https://sandeeptakasi.github.io/qa-pilot/docs/qa-init/).

## Why

"Claude clicked through it and it looked fine" is a sentence, not evidence. It names no build,
holds no recording, and gives a second person nothing to open. QA-Pilot replaces it with three
things that can be checked: a committed spec that produced the verdict and regresses the feature
in CI later, one `trace.zip` per case (video, console, DOM snapshots and network log in one file),
and the deployed build the run was against, read before and after the run.

## How it works

Six commands, with QA approving between design and execution:

```
/qa-pilot:qa-init          write the project's host profile (once)
/qa-pilot:setup-profiles   save a login per account (once per developer)
/qa-pilot:generate-tests   author the feature's cases from its task and code
    QA approves the scenarios, the write policy and the cases
/qa-pilot:run-tests        run committed specs against a deployed build
/qa-pilot:publish-results  validate the run, then publish verdicts
/qa-pilot:qa-review        approve, reject with a reason, or retest
```

## What it refuses to publish

The publish step is a script, not a judgement call. It rejects:

- **a verdict without evidence:** every executed case needs a trace and a deploy SHA;
- **a verdict from a sandbox:** mock backends always succeed, so they can stabilise specs but never
  carry a verdict;
- **a pass that was really a retry:** pass-on-retry is `flaky`, always;
- **a verdict for a case QA never approved:** checked against the case's recorded status at run time;
- **a run that lost its ground truth:** if the deployed build changes mid-run, every case is
  `blocked`, and past 10% blocked the run halts;
- **a run that broke its write policy:** each feature declares whether its tests may write, and the
  write guard records every write it saw.

## Production, without the damage

An environment declares its `kind` instead of the tool guessing from its hostname. A production
environment must also name its `test_account`, the account the runs sign in as and how it is
restricted (its own tenant, no admin rights, no billing); the write guard is the second layer under
that account, never the boundary, and the field is an attestation nothing verifies. On production,
traces stay on the executor's machine (never attached to the tracker, uploaded by CI or committed),
every case keeps a full trace, and a feature must be `read-only` or `scoped-write` under a live write
guard. The guard needs no help from the specs: clicks are judged in the page before the app sees
them, requests at the network layer. The tracker record of a production run carries no application
data. [Production](https://sandeeptakasi.github.io/qa-pilot/docs/production/) has the details, and
says plainly what the gates cannot verify.

## Documentation

| Start here | Reference | Project |
|---|---|---|
| [Overview](https://sandeeptakasi.github.io/qa-pilot/docs/) | [Host profile](https://sandeeptakasi.github.io/qa-pilot/docs/profile/) | [What it enforces, and why](https://sandeeptakasi.github.io/qa-pilot/docs/decisions/) |
| [Setting up a project](https://sandeeptakasi.github.io/qa-pilot/docs/qa-init/) | [Cases file](https://sandeeptakasi.github.io/qa-pilot/docs/cases/) | [Write guard internals](https://sandeeptakasi.github.io/qa-pilot/docs/architecture/) |
| [Running tests](https://sandeeptakasi.github.io/qa-pilot/docs/run-tests/) | [Report and gate](https://sandeeptakasi.github.io/qa-pilot/docs/report/) | [Changelog](https://sandeeptakasi.github.io/qa-pilot/docs/changelog/) |
| [Running in CI](https://sandeeptakasi.github.io/qa-pilot/docs/ci/) | [Spec conventions](https://sandeeptakasi.github.io/qa-pilot/docs/spec-conventions/) | [Setting up ClickUp](https://sandeeptakasi.github.io/qa-pilot/docs/clickup/) |

## Repository layout

```
qa-pilot/    the plugin: skills, zero-dependency scripts, schemas, the ClickUp guard hook,
             and templates (the write guard, a CI workflow) to copy into a host repo
site/        the documentation site, built from the plugin's own markdown (site/DESIGN.md)
docs/        architecture notes and decision records
fixtures/    a fake host repo the tests and the browser proof of the write guard run against
```

## Development

```bash
node --test qa-pilot/scripts/tests/*.test.mjs
claude plugin validate ./qa-pilot
```

[CLAUDE.md](./CLAUDE.md) lists the checks to run before every commit, including the write guard's
real-browser proof.

## Licence

MIT. The one bundled dependency, a copy of [yaml](https://github.com/eemeli/yaml), is ISC licensed;
see [THIRD_PARTY_NOTICES.md](./qa-pilot/THIRD_PARTY_NOTICES.md).
