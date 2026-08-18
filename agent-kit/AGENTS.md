# ATOA Agent Kit Memory

This directory packages the client side of the ATOA delegation model. Keep the CLI, MCP plugin, distributed Skill, documentation, and installer behavior aligned.

## Canonical behavior

- `delegate create` sends the exact user objective and acceptance criteria to the deterministic server control plane.
- `auth login` authenticates only an already registered account with its password; it never creates an identity from an arbitrary email.
- `cloud create` creates a persistent managed project with an initial scaffold and fixed test; `cloud skill-add` is owner-only project governance.
- `delegate claim` resolves the Context manifest through `ATOA_HOME/cache/context-v1/`, downloads only missing SHA-256 blobs, and returns hydrated Context plus `local_cache` evidence.
- `delegate request-context` asks for specific missing code instead of guessing.
- `delegate submit` supports complete files only as a fallback.
- Preferred operations are `insert_before`, `insert_after`, `replace`, and intentional `append`, all with `expected_hash`.
- `delegate submit --reuse-candidate` maps to `reuse_candidate: true` and must not require files, operations, message, or summary.
- `delegate usage` exposes real application-payload measurements, including candidate reuse savings.
- Cache behavior must remain automatic for `delegate claim`, assigned `delegate show/context`, and `delegate request-context`.
- Contract conflicts are preflight results, not implementation failures. The client must not weaken server policy to make them pass.
- A queued task is handed to the singleton on-demand local Worker. The initiating Agent exits; the Worker obtains a short server reservation, starts a fresh local Agent after dispatch, and exits when its local task registry is empty.
- Server responses may identify a task but must never control the local Worker launcher command or arguments.
- The server is a deterministic control plane, not an Agent. It concurrently dispatches tasks whose source Context paths do not overlap; overlapping tasks remain queued. Finer symbol-level dependency analysis is future work.

## Files that must stay synchronized

When changing delegation behavior, update all relevant copies:

- `cli/atoa.mjs`
- `plugins/atoa-codex/src/mcp-server.mjs`
- `skills/atoa-cocreation/SKILL.md`
- `plugins/atoa-codex/skills/atoa-cocreation/SKILL.md`
- `DELEGATION_PROTOCOL.md`
- `README.md`

Keep the legacy cloud worktree commands for compatibility, but describe delegation as the default.

## Plugin update workflow

For every local plugin change:

1. Validate both Skill copies with the Skill quick validator.
2. Validate `plugins/atoa-codex` with the plugin validator.
3. Use the plugin-creator cachebuster helper; do not hand-edit marketplace metadata.
4. Reinstall `atoa-codex@atoa-agent-kit`.
5. Run the Agent Kit installer with plugin installation skipped to refresh the CLI and shared Skill.
6. Tell the user that a new Codex thread is required to load updated MCP tools and Skills.

Preserve the base plugin version unless a real product release intentionally changes it. The cachebuster suffix exists only to refresh local Codex ingestion.

## Compatibility and safety

- Keep machine-readable CLI output inside `ATOA_AGENT_DATA` markers.
- Never print access tokens or credentials.
- MCP schemas must represent optional retry fields accurately; do not require new-candidate fields when `reuse_candidate` is used.
- Confirm destructive or merge-capable operations through the existing explicit confirmation fields.
