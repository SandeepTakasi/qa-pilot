# qa-review on ClickUp

Read this when the profile's `tracker` is `clickup`. It holds the ClickUp-only parts of steps 1, 3, 4 and 5 of `SKILL.md`.

## Queue (step 1)

Resolve each lifecycle key to this host's status name through the profile's `clickup.statuses` before you query or write: the board uses the host's wording. Query the feature's list with `clickup_filter_tasks`.

## Opening a trace (step 3)

Only when the environment sets `evidence_upload: tracker` is `trace.zip` attached to the case task. Download it and open it with `npx playwright show-trace <file>`, which runs on this machine. Prefer that to the hosted viewer: a trace holds a live session, and a local open means you need not rely on the viewer's no-transmission claim.

## Write flag and decisions (step 4)

Set the flag at the repo root, next to the profile, before any ClickUp write in this skill (decisions and bugs), and remove it after:

```bash
mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes
# ... writes ...
rm -f .qa-pilot/allow-clickup-writes
```

It expires after 30 minutes; re-`touch` it if a long session starts getting denied.

Move the task to this host's status name for the decision: `approved_for_execution` (design approval), `approved`, `rejected` (with the reason tag), or `retest`.

## Filing bugs (step 5)

The write flag must be set. For each `create[]` entry:

- File a new task with `title` and `body` as given; apply `tags`; set the priority from `priority`.
- Link it to the case task with `clickup_add_task_link`. Use native links, not a custom field: a bug's lifecycle belongs to the developers.
- If `supersedes` is set, say so in a comment on the older bug; never close it, since only a human decides it is dead.

For each `comment[]` entry, post the comment on the existing bug instead of creating a second one.

Bugs land in the profile's `clickup.bug_list`. If it is unset they land in the feature list beside the case tasks and the script warns; name a bug list to keep the case board readable.

Write `ledger` back to `testing/<feature>/bugs.json` with each new task's `task_id` filled in from the ClickUp response, and commit it. Without the IDs, every regression run refiles every open bug.
