# 0001. Write signatures are default-deny per channel

Status: accepted, 2026-10-01

## Context

The write guard blocks a request only when it matches a `write_signatures` entry. Anything that
matches nothing passes. The first real host profile listed the writes it knew of, channel by
channel. A review found that most of one channel's writes passed: the inventory had been taken
from one call shape, and calls written another way were missed. Two more channels (identity
provider account changes, a file-processing service) were missing entirely.

## Decision

For every channel where reads and writes share a method and host (RPC-style APIs that POST every
operation, callable cloud functions, GraphQL), write one signature that matches the whole channel
and list the **reads** in `allow_signatures`, by exact name or by a verb the backend's own model
declares. A new operation is then blocked and shows up in `writes.json`, instead of passing
silently. Allow entries are anchored to their host, because an allow entry overrides every write
signature.

Keep a replay check next to the profile that loads it through `profile.mjs`, judges requests with
the guard's own `decideRequest` / `decideControl`, and takes its expected answers from the host's
source (every live operation and function name), never from the profile. Run it after every
profile change and after every host release.

## Consequences

- A new read is blocked until it is added, which is the safe direction; a read-only run that
  touches it is refused and names it.
- Functions with side effects outside the app's data (model quota, mail) stay blocked; a feature
  that needs them runs `scoped-write`, where calls are recorded, not stopped.
- The check is host code and lives with the host profile, not in this repository.
