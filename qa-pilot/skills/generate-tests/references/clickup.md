# generate-tests: ClickUp steps

Read this only when `tracker: clickup`. It covers finding the feature's task (step 1) and creating the case tasks (step 4).

## Find the feature's task (step 1)

Find it with `clickup_search` / `clickup_get_task`, or use the ID or URL the user gave. Read the description, acceptance criteria and comments.

## Create the case tasks (step 4)

Skip this if the ClickUp MCP tools are unavailable: the validated `cases.yaml` stands, the user can re-run to sync. Say clearly that sync was skipped.

1. Create the write flag the guard hook checks, at the repo root next to the profile: `mkdir -p .qa-pilot && touch .qa-pilot/allow-clickup-writes` (it expires after 30 minutes).
2. Read `testing/<feature>/clickup-map.json` if it exists. **Every case already in the map is updated, never recreated**; never look tasks up by name.

   **If you changed an existing case's steps, expected outcomes, priority or type, move it back to `case_review`** and say which cases you reset and why: editing an approved case and leaving it approved walks a changed test past the design gate. Pure wording or title tidying with identical behaviour needs no reset, but when in doubt, reset.
3. Locate the feature's list: it is named after the feature, in the profile's `clickup.folder` inside `clickup.space`. **Resolve the folder first, then the list within it**; searching the space by list name can land on someone else's manual QA list. If the profile has no folder, ask the user which to use and suggest adding `clickup.folder`.
4. For each unmapped case, create a task in that list:
   - title: `<CASE-ID> <Title>`
   - description: preconditions, steps and expected outcomes as written
   - status: this host's name for `case_review`, from `clickup.statuses`
   - custom fields: Priority, Type, Model Version
5. Pace the calls: one request per second, sequential (100 requests per minute per token).
6. Write the merged mapping back to `testing/<feature>/clickup-map.json` (`{"CASE-ID": "task-id"}`); it is meant to be committed.
7. Remove the flag: `rm -f .qa-pilot/allow-clickup-writes`
