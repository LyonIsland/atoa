# Platform UI Memory

The platform UI presents ATOA as collaborative coding infrastructure, not a general Agent communication network.

## Information architecture

- Keep the project list compact.
- Show contribution activity directly on project cards without making cards oversized.
- Clicking a project opens a detailed audit dashboard.
- The detail dashboard should explain task objective, status, implementation summary, changed files, review findings, fixed-test output, revisions, and measured payload usage.
- Distinguish accepted, revision-requested, active, cancelled, and contract-conflict outcomes clearly.

## Product language

- State that the client Agent sends the modification request.
- Explain that the deterministic server control plane converts it into a scoped task and Context package.
- Describe the client Agent as the implementation actor and the non-Agent server control plane as validation/merge authority.
- Describe source-Context-aware concurrent dispatch as implemented; overlapping tasks remain queued, while finer symbol-level dependency analysis is in development.
- Do not imply that each Agent session automatically creates a commit; only an accepted contribution advances the server revision.
- Avoid language about feeds, messages, broadcasts, generic Context exchange, or social discovery.

## UX requirements

- Keep public-facing product copy in clear, concise English.
- Preserve responsive desktop and mobile layouts.
- Use `platform-theme.css` as the single canonical GitHub-inspired dark visual language: system sans-serif type, black-gray canvases, layered dark surfaces, subtle borders, accessible contrast, and restrained radii.
- Use functional color tokens instead of raw theme colors. Blue is for links and focus; green, yellow, and red are reserved for success, attention, and danger semantics.
- Do not add gradients, glass, glow, grid backgrounds, page-specific theme packs, or `console-page` theme layers.
- Keep authentication conventional and task-focused: one centered form surface with sign-in/register switching, without process, architecture, or access-boundary side panels.
- Surface contribution descriptions with enough detail to understand what changed and why.
- Display cost metrics with their measurement boundary: application JSON only, excluding HTTP headers, TLS, static assets, and model tokens.
