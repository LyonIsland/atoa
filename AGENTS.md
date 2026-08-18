# ATOA Platform Memory

## Product focus

ATOA is an Agent-native collaborative coding platform. Keep the product focused on project co-creation. Do not reintroduce feeds, private messages, broadcasts, general information exchange, or unrelated social features.

The primary model is:

1. A client Agent sends the user's modification request and concrete acceptance criteria.
2. The deterministic server control plane checks the contract against project policy before creating a task.
3. The server control plane selects scoped Context, permissions, and a base revision by explicit rules.
4. The client Agent claims the task and acts as the authorized implementation worker.
5. The client returns a candidate; only the server may validate, merge, and create a contribution record.

The client initiates the request. Do not describe the normal flow as the server independently deciding what the user wants.

## Default execution model

- Prefer `atoa-delegation/v1`; the legacy checkout/worktree flow is compatibility-only.
- The normal delegation path does not clone the project and does not create a client-side project copy.
- The server sends a Context manifest first. The CLI restores immutable blobs from its content-addressed local cache and downloads only missing hashes.
- The client works from the hydrated Context and requests incremental Context when a symbol, caller, test, or convention is missing.
- The server control plane owns scope, policy, validation, merge authority, and the final revision. It is not an Agent and does not implement tasks.
- The client Agent owns implementation and honest evidence, but its self-reported checks are never authoritative.
- Source-Context-aware concurrent dispatch is implemented: disjoint tasks may run together, while overlapping tasks remain ordered and revision-safe. Finer symbol-level dependency analysis remains future work.

## Task contracts and policy

- Run contract preflight before dispatch. Return `delegation_contract_conflict` and create no task when acceptance criteria require forbidden capabilities.
- Expose the effective project policy in the task contract.
- Current policy allows project-scoped `localStorage` for non-sensitive application state.
- Continue to reject `document.cookie`, `sessionStorage`, dynamic code, external network egress, external scripts, and obvious credentials.
- Acceptance criteria and write permissions must be mutually compatible. Never ask a client to modify a file that is not writable.
- Keep registration and login separate. An invite may authorize registration, but login must authenticate an existing account and must never create users implicitly.
- Browser sessions use Secure HttpOnly cookies; never place access tokens in localStorage or expose project pages before authentication.
- Filter every project, file, Context, task, contribution, preview, and Demo route through the same project ACL. Bundled projects may opt into registered-user visibility; managed projects default to owner plus explicit members.
- Managed project creation must persist outside the bundled project directory. Only a managed project's owner may manage members or add its project Skills.

## Context and candidate protocol

- Bind every candidate to `base_revision` and per-file `expected_hash`.
- Prefer compact operations over complete files.
- Use `insert_before` or `insert_after` with short, unique structural anchors for additions.
- Use `replace` for a specific existing block and `append` only when end-of-file placement is intentional.
- Missing or ambiguous anchors must fail atomically without changing project files.
- Cache the latest failed candidate privately on the server.
- If candidate code changes, submit a new candidate.
- If candidate code is unchanged and only server policy or validation environment changed, use `reuse_candidate: true` to revalidate without another upload.
- Never expose cached candidate contents through public task responses.

## Validation, history, and revisions

- Validate file scope, source size, dangerous capabilities, and fixed project tests before merge.
- A failed candidate produces `revision_requested`; it must not alter the public project or contribution history.
- An accepted candidate is applied atomically, produces a contribution record, and advances the project revision.
- Preserve revision conflict protection; stale tasks must never overwrite a newer project.
- Contribution history must include useful implementation summaries, changed files, review results, fixed-test output, author, base revision, and final revision.

## Cost observability

Track application-level JSON payload separately from model tokens and transport overhead:

- Context and validation bytes sent by the server.
- Task, progress, Context request, and candidate bytes sent by the client.
- API calls, Context deliveries, result submissions, candidate reuse count, and avoided candidate bytes.

Initial Context is normally the largest downlink cost. Avoid resending accumulated Context, complete unchanged files, or unchanged retry candidates.
Context blobs use full SHA-256 and are isolated by server, authenticated Agent identity, and project. They are read-only inputs, never an editable checkout or source of truth.

## Verification baseline

Run at minimum:

```bash
node --check server.js
npm test
git diff --check
```

Keep the end-to-end delegation test authoritative for protocol changes. When changing security policy, add both an allowed-case and a rejected-case regression test.
