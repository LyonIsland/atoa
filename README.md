# ATOA Collaborative Coding

**English** | [简体中文](README.zh-CN.md)

ATOA is an agent-native platform for collaborative project creation. A user's local Coding Agent initiates a modification request, while the deterministic server control plane performs contract preflight, selects Context and permissions, manages Context-conflict queues, runs security scans and fixed tests, merges atomically, and assigns the final revision. The local Agent only performs the authorized implementation and never has server-side merge authority.

This open-source distribution includes one sample project: `courseplanner`, a course-planning assistant. It demonstrates course filtering, recommendations, workload summaries, schedule-conflict detection, automatic planning, and course reviews, with fixed Node.js tests.

## ATOA's Philosophy and Advantages

ATOA aims to establish a collaborative Vibe Coding model: each user's Agent and private conversation remain the place where creation happens, while a unified cloud service manages project facts, the runtime environment, and final delivery. Users do not need to give the platform their complete repository, full conversation history, or model credentials. The client sends only the goals, acceptance criteria, progress, candidate changes, and evidence required for the current task. The cloud merges approved results into an online version that every participant can immediately experience.

> **Current architecture:** The server is a rule-driven Node.js control plane, not an Agent, and it will not take on Agent reasoning or implementation responsibilities. The current release already schedules work concurrently by source Context path: tasks with non-overlapping Context may run together, while overlapping tasks remain queued. Finer-grained symbol and explicit dependency analysis is still under development.

The server does not call models or launch server-side Agents. It exposes project metadata, task contracts, Context, permissions, queue status, candidate submissions, validation results, and revision history through a standard REST API. The Agent Kit wraps these APIs as CLI commands, a Skill, and MCP tools that client Agents can use. The server runs only predefined fixed tests and deterministic rules; code understanding, solution design, and implementation always happen in the client Agent.

ATOA is built around four core advantages:

1. **No environment setup; deploy after acceptance.** The client does not need to clone the complete project, install dependencies, configure a runtime, or deploy manually. The server owns the authoritative environment and performs fixed tests, security scanning, atomic merges, and Demo deployment.
2. **Private conversations, shared outcomes.** A user's original prompts, experiments, and development conversations remain visible only to task participants. The public side shows only sanitized development intent, implementation summaries, validation results, revisions, and runnable Demos.
3. **Immediate collaboration with clear boundaries.** The control plane currently uses source Context paths as concurrency units. Non-overlapping tasks can be dispatched together; overlapping tasks wait in creation order and receive Context from the latest revision after the occupied scope is released. Incremental Context requests pass through the same conflict checks. Even if unrelated contributions advance the global revision, a candidate can be revalidated and safely merged when every target file still matches its SHA-256. If a target file changed, the server returns a revision conflict. Finer-grained symbol dependency analysis is still under development.
4. **Bring your own Agent and model.** Users choose their Coding Agent, model, and token, and retain control over model costs. The platform neither resells model capacity nor takes control of the client's Agent launcher or model credentials.

The implemented model is “personal Agent + server control plane.” The personal Agent understands intent, plans, implements, and returns a candidate. The control plane follows fixed policy for contract preflight, Context selection, file permissions, queues, base revisions, validation, merges, and final versions. Client-side checks are evidence only; a candidate can change the public project only after server validation succeeds. While a task is queued, the on-demand local Worker keeps waiting. Once dispatched, it launches a new client Agent, so the Agent that originally submitted the request does not need to remain blocked.

This is the first phase of source-Context-aware synchronized collaboration, not a server Agent. The control plane uses Context, write permissions, and file hashes to decide which tasks may run in parallel, then handles validation order and revision compatibility after candidates return. Finer-grained symbol and explicit dependency analysis will follow. Every accepted contribution still produces an auditable revision and an immutable runnable Demo, allowing collaborators to understand and experience what a version solves without pulling the code or setting up an environment.

## Open-Source Distribution Boundaries

The distribution does not include the following private or runtime data:

- Real Agent identities, sessions, tasks, prompts, candidates, or contribution databases;
- Deployed service domains, internal host-control scripts, or access tokens;
- `.env` files, Demo history, logs, caches, `node_modules`, or old Git history;
- Built-in platform projects other than the course-planning assistant.

`npm run check:release` checks the project count, forbidden files, private domains, host-integration traces, private keys, and common token formats. Before publishing, you should still run your organization's secret scanner and audit the Git history separately.

## Deploying the Server

The current release remains a single Node.js service. It uses embedded SQLite to persist identities, sessions, tasks, and contribution records, so no separate database service is required. Node.js 22 or later is required:

```bash
npm ci
mkdir -p data/demo-history
cp .env.example .env
npm start
```

By default, `.env.example` places runtime data under the Git-ignored `data/` directory in the source tree. At minimum, change these values for deployment:

```dotenv
PUBLIC_URL=https://atoa.example.com
ATOA_INVITE_CODE=a-long-random-string-generated-by-a-password-manager
```

Do not retain the development directory layout for an Internet-facing production deployment. Hardened
templates for an external data volume, a dedicated service account, `UMask=0077`, systemd filesystem
restrictions, Nginx download denial, and a startup configuration audit are under [`deploy/`](deploy/README.zh-CN.md).
Run `npm run check:production` in the configured production environment; development environments are not
expected to pass that check.

You can also start the service with environment variables:

```bash
PORT=7000 \
PUBLIC_URL=http://localhost:7000 \
ATOA_SQLITE_FILE="$PWD/data/atoa.sqlite" \
ATOA_MANAGED_PROJECTS_ROOT="$PWD/data/projects" \
ATOA_DEMO_HISTORY_ROOT="$PWD/data/demo-history" \
ATOA_CLOUD_ROOT="$PWD/cloud-projects" \
ATOA_INVITE_CODE='replace-with-a-long-random-value' \
npm start
```

For a long-running server, use systemd, Supervisor, or your deployment provider's existing Node.js process manager to keep `npm start` running. Put port 7000 behind Caddy, Nginx, or a cloud load balancer, and expose HTTPS only. The reverse proxy must preserve `Host` and `X-Forwarded-Proto`. `PUBLIC_URL` must be the HTTPS origin users actually visit, without a trailing `/`.

After deployment, verify:

```bash
curl https://atoa.example.com/api/v1
curl -I https://atoa.example.com/agent-kit/install.sh
curl -I https://atoa.example.com/cloud-apps/courseplanner/
```

SQLite uses WAL, foreign keys, a five-second busy timeout, full synchronization, and schema migrations. The application still runs as a single Node.js instance. Do not use PM2 cluster mode or allow multiple service processes to write to the same database. Before scaling horizontally, migrate to a shared database and a cross-instance transaction model.

Before upgrading, stop the ATOA process and back up the entire `data/` directory so the database, WAL, managed projects, and Demo history share one recovery point. To restore, stop the service, replace the complete `data/` directory, restart, and check `/api/v1`. Do not copy only the main `atoa.sqlite` file while the service is running, and never commit `.env`, databases, project runtime directories, or Demo history to Git.

### Migrating JSON Data from 2.2

Version 2.3 creates the SQLite schema on first startup. Existing deployments may keep their original `ATOA_DB_FILE=...json` setting: the service treats it as a read-only migration source, creates a SQLite database in the same directory or at the default `data/atoa.sqlite` path, and imports users, sessions, tasks, and contributions once. You can also configure the paths explicitly:

```dotenv
ATOA_SQLITE_FILE=./data/atoa.sqlite
ATOA_LEGACY_JSON_FILE=./data/atoa-data.json
```

The import record and source-file SHA-256 are written to `legacy_imports`, preventing duplicate imports after restarts. The original JSON file is not deleted automatically. After confirming that accounts, projects, and history are intact, move it to protected offline storage. If the JSON is corrupt or its collection structure is invalid, the service refuses to start instead of silently creating an empty database.

`ATOA_INVITE_CODE` authorizes account creation only. It cannot be used to log in or impersonate an existing account. Registration passwords are stored with a random salt and scrypt; client login accepts only an already registered email and its password. If you need email ownership or enterprise identity verification, deploy an identity-aware proxy in front of ATOA. See [SECURITY.md](SECURITY.md) for full guidance.

### Current Validation Boundary

The server accepts only files authorized by the task contract and deterministically validates the `base_revision`, per-file SHA-256, file allowlist, source size, dangerous capabilities, and fixed tests. Candidates are materialized in a temporary copy first. Failed candidates never alter the public project, merges remain atomic, and accepted versions can be restored from Demo history.

The current release runs fixed tests in restricted local child processes with timeouts and output limits, but it does not provide an operating-system-level sandbox for untrusted code. This fits the current product stage, where the deployer manages projects, Skills, fixed tests, and invited members. To accept completely untrusted arbitrary code execution, deployers must integrate their own isolated execution or publishing mechanism; that mechanism is outside the current data communication protocol.

## Browser Login, Registration, and Project Permissions

Unauthenticated visitors to the server home page are redirected to `/login`. Registration requires a deployer-provided invite code; login accepts only an already registered email and password. Browser sessions use Secure HttpOnly cookies and never put access tokens in `localStorage`, `sessionStorage`, or page JavaScript. Project directories, dashboards, previews, Demos, files, Context, tasks, and contribution APIs all pass through the server's project ACL. Hiding buttons is never a substitute for authorization checks.

The bundled `courseplanner` project allows participation by all registered users. User-created managed projects are private by default and are visible only to their creator and explicitly added members. Only the creator can manage members and project Skills.

## Creating Projects, Adding Members, and Managing Skills with the CLI

The invite code is used only during registration:

```bash
read -rsp "ATOA invite code: " ATOA_INVITE_CODE; echo
read -rsp "New ATOA password: " ATOA_PASSWORD; echo
export ATOA_INVITE_CODE ATOA_PASSWORD
atoa auth register --email user@example.com --name "Your name"
unset ATOA_INVITE_CODE
atoa auth login --email user@example.com
unset ATOA_PASSWORD
```

Login never creates an account implicitly. Unregistered emails, incorrect passwords, and weak passwords are rejected. Create a persistent project and add a project Skill:

```bash
atoa cloud create \
  --id release-notes \
  --name "Release Notes" \
  --description "A shared project for preparing reviewed product release notes."

atoa cloud skill-add \
  --project release-notes \
  --id release-checklist \
  --name "Release Checklist" \
  --description "Conventions for reviewable release notes" \
  --instructions "Preserve headings, identify compatibility changes, and include validation evidence." \
  --triggers '["release","发布","changelog"]'
```

A project creator can add another registered account to a private project:

```bash
atoa cloud member-add --project release-notes --email teammate@example.com
atoa cloud member-list --project release-notes
# After member-list returns a stable member ID, access can be revoked
atoa cloud member-remove --project release-notes --member agt_xxx --confirm
```

Removing a member also cancels that member's active tasks in the project. New projects include an initial page, four editable files, and fixed tests, and are immediately ready for delegation, Context delivery, validation, merging, and runnable version publishing.

## Distributing the Agent Kit to Users

The server publishes the protocol-matched CLI, Skill, and Codex plugin directly from `/agent-kit/`. Replace `https://atoa.example.com` below with your domain, then send the instructions to invited users.

Linux / macOS:

```bash
curl -fsSL https://atoa.example.com/agent-kit/install.sh \
  | env ATOA_BASE_URL=https://atoa.example.com/agent-kit \
        ATOA_ENDPOINT=https://atoa.example.com \
        bash

atoa auth login --email user@example.com
atoa doctor
```

Windows PowerShell:

```powershell
$env:ATOA_BASE_URL = "https://atoa.example.com/agent-kit"
$env:ATOA_ENDPOINT = "https://atoa.example.com"
irm https://atoa.example.com/agent-kit/install.ps1 | iex
atoa auth login --email user@example.com
atoa doctor
```

The installer saves the target server address, installs the `atoa` CLI, and synchronizes the `atoa-cocreation` Skill. When it detects Codex CLI, it also registers the repository marketplace and installs the `atoa-codex` plugin. Codex users should first install and sign in to Codex by following the [official OpenAI Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli). Start a new Codex session after plugin installation so the new Skill and MCP tools are loaded.

Users without Codex can use the `atoa` CLI directly. The local Worker's default Agent launcher is `codex exec`; users may select another trusted launcher on their machine with `ATOA_WORKER_AGENT_COMMAND` and `ATOA_WORKER_AGENT_ARGS_JSON`. The server cannot provide or modify this command.

### Suggested Quick Start for Users

1. Install Node.js 22+ and your preferred Coding Agent.
2. Run the Agent Kit installation command supplied by the administrator.
3. The administrator invites the user to register; the user then logs in with the registered email and their own password.
4. Start a new Agent session and ask: “List the ATOA projects currently open for collaboration.”
5. Give `courseplanner` a clear modification goal and concrete acceptance criteria.

## Verifying the Open-Source Copy

```bash
npm ci
node --check server.js
npm test
npm run check:release
git diff --check
```

See [CLOUD_PROTOCOL.md](CLOUD_PROTOCOL.md) for the protocol and [agent-kit/README.md](agent-kit/README.md) for client details.

## License

MIT. See [LICENSE](LICENSE).
