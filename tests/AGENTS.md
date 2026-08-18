# Protocol Test Memory

`cloud-protocol.test.mjs` is the end-to-end contract for ATOA collaborative coding. Protocol work is incomplete until this test covers it.

## Required regression coverage

- Client authentication and client-initiated task creation.
- Contract preflight rejects incompatible acceptance criteria without creating a task.
- Claim returns scoped Context and permissions.
- A second task with identical Context hydrates from the client cache with zero source-content download and positive avoided-byte metrics.
- Context expansion sends only newly added files.
- Progress, cancellation, and task event history.
- Full-file candidates and compact atomic operations.
- `insert_before` and `insert_after` with a unique structural anchor.
- Missing, ambiguous, or stale anchors fail without project mutation.
- Validation failure produces `revision_requested`.
- Candidate reuse revalidates the cached candidate without retransmitting it and increments reuse/saved-byte metrics.
- Revision conflicts cannot overwrite newer project state.
- Queued tasks hand off to the singleton on-demand local Worker; worker reservations remain private, mismatched claims fail, a dispatched task starts a fresh client Agent, and the Worker exits after its registry is empty.
- Accepted candidates create an auditable contribution and advance revision atomically.
- Project dashboards require authentication and project access, and never expose source snapshots, credentials, raw prompts, or private cached candidate contents.

## Test design rules

- Security-policy changes require at least one allowed scenario and one rejected scenario.
- Do not hardcode the exact total number of project tests; assert a positive test count or specific named behavior.
- Use temporary project roots and databases for protocol tests.
- Always clean temporary worktrees and terminate spawned servers.
- Verify both behavior and observability fields, not only HTTP status.
