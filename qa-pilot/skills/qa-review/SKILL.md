---
name: qa-review
description: The QA reviewer's cockpit — pull the Under Review queue for a feature from ClickUp, sorted by priority with failures first and evidence links attached, enforce the evidence sampling rules, and record Approve, Reject-with-reason, or Retest decisions back to ClickUp. Also runs design review on freshly authored cases awaiting approval. Use when the user says "qa review", "review the run", "review the cases", or "/qa-review <feature>".
argument-hint: "<feature>"
---

# qa-review — QA's queue, not QA's execution

QA owns every verdict in this system. This skill exists to make reviewing fast enough that one reviewer can keep up with five producers — by sorting the queue, attaching the evidence, and tracking the sampling quotas, so QA spends their attention on judgment instead of navigation.

You are the assistant here, not the reviewer. Never mark a case Approved on your own reading of the evidence. Present, then record what the human decides.

Recommended model: any current model.

## 0. Profile gate

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/profile.mjs" <profile-path>
```

Nonzero exit → STOP, point at `/qa-pilot:qa-init`.

## 1. Pick the queue

Ask which the user wants, or infer from what is actually waiting:

- **Design review** — cases in `Case Review`, authored but not yet executable
- **Result review** — cases in `Under Review` or `Quarantined`, executed and awaiting a verdict decision

Use `clickup_filter_tasks` on the feature's list.

## 2. Design review

QA reviews the **scenario matrix first**, then individual cases. Present:

1. The scenario mix: which of happy / negative / boundary / permission / data-validation are covered, and the stated reason for anything marked `n_a`. A missing permission case on a role-aware feature is the hole to catch here — not a formatting problem, a coverage one.
2. **Every P0 and P1 case individually**: title, steps, expected outcomes. These are the ones whose assertions decide whether the feature reads Ready.
3. **P2 cases in bulk**, at matrix level — one judgment across the group. Reviewing 25 cases × 5 developers individually recreates the bottleneck at the design gate, which is the thing this system is built to avoid.

For each decision, move the task: `Approved for Execution`, or `Rejected` with a tagged reason. Nothing executes until it is approved.

## 3. Result review and the sampling rules

Not every pass needs to be watched, but the sampling must be honest and tracked:

| | Requirement |
|---|---|
| **All failures** | Watch the evidence. Every one. |
| **P0 passes** | Watch 100%. |
| **P1 passes** | Sample at least 30%. |
| **P2 passes** | Sample at least 10%. |
| **Any executor over the false-pass threshold** | Raise their rates until it comes down. |

Compute the quotas from the actual queue and tell the user the numbers up front ("7 items must be watched: 2 failures, 4 P0 passes, and 1 of 3 P1 passes"). Track which have been watched as you go, and say plainly when the quota is unmet — an unmet sampling quota means the confidence number is less trustworthy than it looks.

Present the queue sorted: failures first, then by priority. For each item give the case title, verdict, executor, environment and SHA, and the trace attachment on its task. For a failure, show the `failure_summary` from the report — it is the Playwright error verbatim, which is what makes it triageable.

**How to watch a case.** Download its `trace.zip` from the ClickUp task and drop it on <https://trace.playwright.dev>. The viewer runs entirely in the browser — Playwright's docs state it "does not transmit any data externally" — so nothing is uploaded and no account is needed. `npx playwright show-trace <file>` opens the same thing locally.

Tell reviewers what the trace gives them, because it is more than the old video was: a scrubable film-strip of every action, the DOM at each step, the console output, and the network log, all on one timeline. "Watching the evidence" means scrubbing to the failing action and reading the DOM there — not just watching a recording and forming an impression.

## 4. Record decisions

Set the write flag before ClickUp writes and remove it after:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

The flag expires after 30 minutes; re-`touch` it if a long review session starts getting denied.

- **Approve** → status `Approved`. The case counts toward the confidence numerator, and it stays executable: the next build regresses it automatically, with no reset by anyone. That persistence is what turns this from a one-shot into a suite.
- **Reject** → status `Rejected` **plus a reason tag**. Use a consistent vocabulary: `bad-assertion`, `env-issue`, `wrong-expected`, `insufficient-evidence`, `selector-fragile`, `test-data-collision`, `feature-actually-broken`. These tags are the feedback loop — the weekly standards review reads their distribution and edits the skills and host profile accordingly. A rejection with no tag teaches nothing.
- **Retest** → status `Retest`. For environment problems and expired sessions, not for real failures.

A `fail` verdict that QA confirms is a real defect: the case stays `Rejected` only if the *test* was wrong. If the test was right and the feature is broken, that is a bug — record it as such against the feature, and do not weaken the case to make it pass.

## 5. Close out

Report: how many were reviewed, the decisions taken, whether the sampling quotas were met, the updated confidence score, and whether the feature reads Ready or Not Ready. **Any P0 not Approved means Not Ready regardless of score** — say it explicitly rather than letting a high percentage speak for itself.

Then flag anything that should feed the weekly standards edit: repeated rejection reasons, cases that flake across runs, selectors that keep breaking.
