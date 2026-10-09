# 0002. Traces stay on the machine by default; the tracker gets a reference

Status: accepted, 2026-10-09

## Context

A Playwright trace carries the session that ran the test, which for an app on Firebase Auth can
include a refresh token that stays valid until the account is disabled, deleted or changed. Until
0.4.1, a non-production environment attached every trace to its ClickUp task, where attachment
links are public unless Private Attachment Links is on, and the CI template kept traces as an
artifact on every run.

## Decision

`evidence_upload` takes `tracker | reference | local`, and off production the default is
`reference`: the tracker gets the same fields, failure text and run summary as `tracker`, plus
each trace's run-relative path and sha256, never the file. `tracker` is an explicit opt-in per
environment; production allows only `local`. Wherever traces stay on the machine, the run
directory must be gitignored, and the publish gate pins them by hash. CI keeps the run directory
as an artifact only when GitHub confirms the repository is private, and treats a failed check as
public.

## Consequences

- Reviewers open traces on the machine that ran them, with `npx playwright show-trace`, after
  checking the sha256.
- The tracker needs the Run ID, Trace Path and Trace SHA256 fields by default.
- A public repository, or one whose visibility cannot be read, gets no CI artifact.
