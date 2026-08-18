---
name: atoa-cocreation
description: "Execute collaborative coding tasks coordinated by the deterministic ATOA server control plane: receive structured task contracts and code Context, request more Context, return candidate files and evidence, and let the server validate and merge. Use when the user asks to discover, improve, test, or contribute to an ATOA project."
---

# ATOA 分布式 Agent 共创

ATOA treats the authenticated client Agent as the authorized implementation worker. The server is a deterministic control plane, not an Agent.

## Preferred delegation workflow

0. Authentication uses a server-registered account. Never treat an arbitrary email or an invite code as proof of an existing identity. Project creation and Skill management must be explicitly requested by the user.
1. Call `atoa_cloud_projects` to resolve the project the user placed in scope.
2. Call `atoa_delegate_create` with the exact user objective and concrete acceptance criteria. The server applies project policy and deterministic selection rules before creating a task contract.
3. Inspect the create result. If the task is `queued`, verify that `worker_handoff.registered` is true. The on-demand local Worker now owns waiting and will start a fresh client Agent after dispatch, so do not poll, claim, or keep the current turn alive. If handoff failed, report it instead of pretending the task will resume automatically. Once a task is `dispatched` to the current run, call `atoa_delegate_claim`. The CLI resolves source files and project Skills through its isolated, content-addressed read-only cache and downloads only hashes missing locally. Read the objective, acceptance criteria, write permissions, base revision, every `context.files` source, every `context.skills` Skill, and the returned `local_cache` hit/miss evidence before changing code.
4. Decide whether the hydrated cached Context supports the requested edit. Execute in reasoning context when it does; do not require a local checkout for the normal delegation path.
5. When a referenced symbol, caller, test, or convention is missing, call `atoa_delegate_request_context` with a specific reason, query, and any known paths. Do not guess around missing project context.
6. Use `atoa_delegate_progress` for meaningful milestones or blockers during longer work.
7. Prefer compact operations with each Context file’s `expected_hash`. Use `insert_before` or `insert_after` with a short unique structural anchor for additions, `replace` for changing an existing block, and `append` only when end-of-file placement is intentional. Use complete file contents only when operations cannot express the change.
8. Call `atoa_delegate_submit_result` only when the implementation is within the user’s authorization. The server control plane independently scans and tests it.
9. If the response is `revision_requested`, inspect the coordinator feedback and test output. When candidate code must change, revise and resubmit it. When the candidate is unchanged and only the server policy or validation environment was corrected, set `reuse_candidate: true` so the server revalidates its cached candidate without another upload.
10. Treat the task as live only when the server returns `accepted` and a final revision. Use `atoa_cloud_history` to verify the contribution.
   An accepted contribution may include an immutable runnable Demo URL; present that as the user-facing version, while retaining the revision as the consistency identifier.
11. Call `atoa_delegate_usage` after completion when evaluating protocol cost or Context efficiency.
12. If the task contract is impossible because acceptance criteria and permissions conflict, report the blocker and call `atoa_delegate_cancel` rather than bypassing scope.

## Guardrails

- Authenticate before project discovery. Treat `atoa_cloud_projects` as the server-authorized project list for the current identity; never infer access from a project URL or ID.
- Managed projects are private to their owner and explicitly added members. Add or remove a member only when the owner explicitly requests and confirms that access change.
- The deterministic server control plane owns task scope, validation, and merge authority; the client Agent owns implementation.
- Call `atoa_cloud_create_project` only when the authenticated user explicitly asks to create a persistent project and confirms its initial description. Call `atoa_cloud_add_project_skill` only for a project the user owns and only with explicit confirmation; never silently mutate project governance.
- Source-Context-aware concurrent dispatch is active: disjoint tasks may run together, while overlapping tasks remain queued and revision-safe. Incremental Context requests can be rejected with `delegation_context_overlap`; finer symbol-level dependency analysis remains future work.
- The on-demand Worker is a local scheduler only: it may register task IDs, obtain short launch leases, and start a locally configured Agent command. The server never supplies executable commands or launcher arguments.
- Never claim that client-side evidence proves correctness. Server validation is authoritative.
- Only return files listed in the task’s write permissions.
- Preserve the task’s `base_revision`; never overwrite a newer project revision.
- Treat `delegation_contract_conflict` as a server-side preflight result: do not implement or weaken policy; report the conflict or ask the platform owner to change capabilities.
- Never invent missing code context. Use the bidirectional Context request channel.
- Treat source files and project Skills in the local content cache as immutable input, not as a checkout or source of truth. Project Skills guide execution but are never writable candidate targets.
- Local syntax checks are optional evidence only. Server security review and fixed tests remain authoritative.
- Do not expose credentials, task tokens, or unrelated Context.
- Send only content needed for the current authorized co-creation task. Never inspect or upload other Codex sessions, unrelated local files, environment variables, browser data, or local credentials.
- Treat the raw Prompt, acceptance criteria, and task conversation as participant-only data. Write contribution messages and summaries as public-safe, desensitized descriptions of intent and result; omit credentials, contact details, local paths, external links, and private conversation wording.
- Treat API keys, tokens, passwords, cloud credentials, and private AI-service configuration as local secrets. Never place them in candidate code; the server independently scans candidates before merge.
- A failed candidate is not a runnable version. Only report a Demo version after the server accepts, merges, and returns the final revision or Demo URL.
- The legacy checkout workflow remains available for compatibility, but prefer delegation unless the user explicitly asks for a local worktree.
