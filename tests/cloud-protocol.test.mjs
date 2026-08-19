import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const root = path.resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);

function readSqliteState(file) {
  const database = new Database(file, { readonly: true });
  try {
    const state = {};
    for (const table of ['agents', 'sessions', 'cloud_changes', 'delegations']) {
      state[table] = database.prepare(`SELECT payload_json FROM ${table} ORDER BY position ASC`).all()
        .map(row => JSON.parse(row.payload_json));
    }
    state.schema_version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    state.legacy_imports = database.prepare('SELECT source_path, source_sha256 FROM legacy_imports').all();
    return state;
  } finally {
    database.close();
  }
}

async function waitForServer(base, child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/v1`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待测试服务启动超时');
}

async function waitFor(check, message, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function request(base, route, { token, cookie, origin, method = 'GET', body, redirect = 'follow' } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    redirect,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data, headers: response.headers };
}

async function runCli(home, args, extraEnv = {}) {
  const result = await execFileAsync(process.execPath, [path.join(root, 'agent-kit', 'cli', 'atoa.mjs'), ...args], {
    cwd: root,
    env: { ...process.env, ATOA_HOME: home, ATOA_WORKER_DISABLE: '1', ...extraEnv },
    timeout: 15_000,
    maxBuffer: 512_000
  });
  return JSON.parse(result.stdout);
}

async function runCliFailure(home, args) {
  try {
    await execFileAsync(process.execPath, [path.join(root, 'agent-kit', 'cli', 'atoa.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, ATOA_HOME: home },
      timeout: 15_000,
      maxBuffer: 512_000
    });
  } catch (error) {
    return { code: error.code, stderr: error.stderr };
  }
  throw new Error(`命令本应失败：${args.join(' ')}`);
}

test('客户端 Agent 可以完成服务端委派、动态 Context、候选验证和 revision-safe 提交', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atoa-cloud-test-'));
  const cloudRoot = path.join(tempRoot, 'cloud-projects');
  const managedProjectsRoot = path.join(tempRoot, 'managed-projects');
  const legacyDbFile = path.join(tempRoot, 'atoa-data.json');
  const sqliteFile = path.join(tempRoot, 'atoa.sqlite');
  const atoaHome = path.join(tempRoot, 'atoa-home');
  fs.mkdirSync(cloudRoot);
  fs.cpSync(path.join(root, 'cloud-projects', 'courseplanner'), path.join(cloudRoot, 'courseplanner'), { recursive: true });
  fs.writeFileSync(legacyDbFile, JSON.stringify({ contexts: [] }));

  const port = 18000 + (process.pid % 1000);
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_URL: base,
      ATOA_SQLITE_FILE: sqliteFile,
      ATOA_LEGACY_JSON_FILE: legacyDbFile,
      ATOA_CLOUD_ROOT: cloudRoot,
      ATOA_MANAGED_PROJECTS_ROOT: managedProjectsRoot,
      ATOA_PROGRAM_PROJECTS: '',
      ATOA_INVITE_CODE: 'release-test-invite-only'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  try {
    await waitForServer(base, child);

    const identity = await request(base, '/api/v1');
    assert.equal(identity.data.name, 'ATOA Collaborative Coding');
    assert.equal(identity.data.version, '2.3.0');
    assert.deepEqual(identity.data.persistence, {
      engine: 'sqlite',
      schema_version: 1,
      deployment_mode: 'single-instance'
    });
    assert.equal(identity.data.registration.login_requires_registered_account, true);
    assert.deepEqual(identity.data.capabilities, [
      'auth',
      'sqlite-persistence',
      'registered-user-login',
      'browser-session-login',
      'cloud-projects',
      'project-access-control',
      'project-member-management',
      'managed-project-create',
      'project-skill-create',
      'server-control-plane-delegation',
      'context-aware-concurrent-dispatch',
      'on-demand-client-worker',
      'dynamic-context',
      'client-sub-agents',
      'candidate-validation',
      'revision-safe-submit',
      'runnable-demo-history'
    ]);
    assert.ok(identity.data.data_boundary.sent_by_client.some(item => /当前共创任务/.test(item)));
    assert.ok(identity.data.data_boundary.never_collected.some(item => /其他 Codex 对话 session/.test(item)));
    assert.ok(identity.data.data_boundary.server_protection.some(item => /API Key/.test(item)));
    assert.ok(identity.data.data_boundary.public_sharing.some(item => /原始 Prompt/.test(item)));

    const gatedHome = await request(base, '/', { redirect: 'manual' });
    assert.equal(gatedHome.status, 302);
    assert.match(gatedHome.headers.get('location'), /^\/login\?next=/);
    const loginPage = await fetch(`${base}/login`).then(response => response.text());
    assert.match(loginPage, /Welcome back/);
    assert.match(loginPage, /Register and sign in/);
    const gatedCatalog = await request(base, '/api/cloud-projects');
    assert.equal(gatedCatalog.status, 401);
    const gatedPreview = await request(base, '/cloud-apps/courseplanner/', { redirect: 'manual' });
    assert.equal(gatedPreview.status, 302);
    const philosophy = await fetch(`${base}/philosophy.html`).then(response => response.text());
    assert.match(philosophy, /Private session/);
    assert.match(philosophy, /unified cloud Server/);
    assert.match(philosophy, /No environment setup\. Direct deployment\./);
    assert.match(philosophy, /Private sessions\. Shared outcomes\./);
    assert.match(philosophy, /Instant collaboration/);
    assert.match(philosophy, /source Context paths do not overlap/);
    assert.match(philosophy, /Finer symbol-level dependency analysis is in development/);
    assert.match(philosophy, /does not call a model or run an Agent/);
    assert.match(philosophy, /Bring your own Agent and tokens/);
    assert.match(philosophy, /Four Features of ATOA/);
    assert.match(philosophy, /Personal Agent and Server Control Plane/);
    assert.match(philosophy, /The Protocol Protects Self-Privacy/);
    assert.equal((philosophy.match(/<article class="advantage">/g) || []).length, 7);
    assert.ok(philosophy.indexOf('Four Features of ATOA') < philosophy.indexOf('RESPONSIBILITY MODEL'));
    assert.match(philosophy, /collaborative Vibe Coding/i);
    assert.doesNotMatch(philosophy, /From private intent|Core thesis/i);
    assert.doesNotMatch(philosophy, /Codex/i);
    assert.doesNotMatch(philosophy, /GitHub/);
    assert.doesNotMatch(philosophy, /YOUR_DOMAIN/);
    assert.match(philosophy, /ATOA_BASE_URL=\$\{atoaOrigin\}\/agent-kit/);
    assert.match(philosophy, /ATOA_ENDPOINT=\$\{atoaOrigin\}/);

    const agentKitReadme = await fetch(`${base}/agent-kit/README.md`).then(response => response.text());
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(agentKitReadme, new RegExp(`${escapedBase}/agent-kit/install\\.sh`));
    assert.match(agentKitReadme, new RegExp(`ATOA_ENDPOINT=${escapedBase}`));
    assert.doesNotMatch(agentKitReadme, /atoa\.example\.com|localhost:7000/);
    assert.match(agentKitReadme, /动态生成，命令已经绑定到当前 ATOA 服务端/);

    await runCli(atoaHome, ['server', 'add', '--name', 'test', '--endpoint', base]);
    await runCli(atoaHome, ['server', 'use', '--name', 'test']);
    const rejectedLogin = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'unregistered@example.invalid',
        password: 'Unregistered1234',
        invite_code: 'release-test-invite-only'
      }
    });
    assert.equal(rejectedLogin.status, 401);
    assert.equal(rejectedLogin.data.error, 'invalid_email_or_password');
    const rejectedRegistration = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: 'cloud-protocol-test@example.invalid',
        name: 'Protocol Test Agent',
        password: 'ProtocolPassword123'
      }
    });
    assert.equal(rejectedRegistration.status, 403);
    assert.equal(rejectedRegistration.data.error, 'valid_invite_code_required');
    const weakRegistration = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: 'cloud-protocol-test@example.invalid',
        name: 'Protocol Test Agent',
        password: 'short',
        invite_code: 'release-test-invite-only'
      }
    });
    assert.equal(weakRegistration.status, 400);
    assert.equal(weakRegistration.data.error, 'strong_password_required');
    const registration = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: 'cloud-protocol-test@example.invalid',
        name: 'Protocol Test Agent',
        password: 'ProtocolPassword123',
        invite_code: 'release-test-invite-only'
      }
    });
    assert.equal(registration.status, 201);
    assert.equal(registration.data.registered, true);
    assert.equal(Object.hasOwn(registration.data.agent, 'password_hash'), false);
    const duplicateRegistration = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: 'cloud-protocol-test@example.invalid',
        name: 'Duplicate Agent',
        password: 'ProtocolPassword123',
        invite_code: 'release-test-invite-only'
      }
    });
    assert.equal(duplicateRegistration.status, 409);
    const wrongPassword = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'cloud-protocol-test@example.invalid', password: 'IncorrectPassword123' }
    });
    assert.equal(wrongPassword.status, 401);
    const login = await runCli(
      atoaHome,
      ['auth', 'login', '--email', 'cloud-protocol-test@example.invalid'],
      { ATOA_PASSWORD: 'ProtocolPassword123' }
    );
    assert.equal(login.logged_in, true);
    const clientConfigText = fs.readFileSync(path.join(atoaHome, 'config.json'), 'utf8');
    assert.doesNotMatch(clientConfigText, /ProtocolPassword123/);
    const token = JSON.parse(clientConfigText).servers.test.token;
    const browserLogin = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: {
        email: 'cloud-protocol-test@example.invalid',
        password: 'ProtocolPassword123',
        browser_session: true
      }
    });
    assert.equal(browserLogin.status, 200);
    assert.equal(Object.hasOwn(browserLogin.data, 'access_token'), false);
    const browserCookie = browserLogin.headers.get('set-cookie').split(';')[0];
    assert.match(browserLogin.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(browserLogin.headers.get('set-cookie'), /SameSite=Lax/i);
    const home = await fetch(base, { headers: { Cookie: browserCookie } }).then(response => response.text());
    assert.match(home, /Collaborative Coding/);
    assert.match(home, /Use your personal Agent/);
    assert.match(home, /to co-create online app/);
    assert.match(home, /runnable Demo/);
    assert.doesNotMatch(home, /Send only what this task needs|Other sessions are never collected/);
    assert.doesNotMatch(home, /信息流|私信|广播/);
    const authorizedCatalog = await request(base, '/api/cloud-projects', { cookie: browserCookie });
    assert.equal(authorizedCatalog.status, 200);
    assert.deepEqual(authorizedCatalog.data.projects.map(project => project.id), ['courseplanner']);
    assert.equal(authorizedCatalog.data.projects[0].access.role, 'participant');
    const authorizedProject = await request(base, '/api/cloud-projects/courseplanner', { cookie: browserCookie });
    assert.equal(authorizedProject.status, 200);
    const projectDashboard = await fetch(`${base}/projects/courseplanner`, { headers: { Cookie: browserCookie } }).then(response => response.text());
    assert.match(projectDashboard, /Project Contribution Audit/);
    const rejectedCookieMutation = await request(base, '/api/v1/cloud/projects/courseplanner/test', {
      cookie: browserCookie,
      method: 'POST',
      body: {}
    });
    assert.equal(rejectedCookieMutation.status, 403);
    assert.equal(rejectedCookieMutation.data.error, 'same_origin_required');
    for (const route of ['/api/v1/items/search', '/api/v1/feed', '/api/v1/messages/unread', '/api/hub', '/api/context']) {
      const removed = await request(base, route, { token });
      assert.equal(removed.status, 404, `${route} 应已删除`);
    }
    const removedCli = await runCliFailure(atoaHome, ['feed', 'poll']);
    assert.equal(removedCli.code, 2);
    assert.match(removedCli.stderr, /未知命令/);

    const projects = await runCli(atoaHome, ['cloud', 'list']);
    assert.equal(projects.projects[0].id, 'courseplanner');
    const baseRevision = projects.projects[0].revision;

    const managedProject = await runCli(atoaHome, [
      'cloud', 'create',
      '--id', 'release-notes',
      '--name', 'Release Notes Workspace',
      '--description', 'A persistent workspace for preparing reviewed product release notes.'
    ]);
    assert.equal(managedProject.project.id, 'release-notes');
    assert.equal(managedProject.project.source.type, 'managed_project');
    assert.equal(managedProject.validation.passed, true);
    assert.match(managedProject.validation.tests.output, /pass/i);
    assert.equal(fs.existsSync(path.join(managedProjectsRoot, 'release-notes', 'project.json')), true);
    const managedPreview = await fetch(`${base}/cloud-apps/release-notes/`, { headers: { Cookie: browserCookie } }).then(response => response.text());
    assert.match(managedPreview, /Release Notes Workspace/);
    const addedSkill = await runCli(atoaHome, [
      'cloud', 'skill-add',
      '--project', 'release-notes',
      '--id', 'release-checklist',
      '--name', 'Release Checklist',
      '--description', 'Conventions for safe and reviewable release notes',
      '--instructions', 'When editing release notes, preserve headings, identify compatibility changes, and include validation evidence.',
      '--triggers', JSON.stringify(['release', '发布', 'changelog'])
    ]);
    assert.equal(addedSkill.skill.id, 'release-checklist');
    assert.equal(fs.existsSync(path.join(managedProjectsRoot, 'release-notes', 'skills', 'release-checklist', 'SKILL.md')), true);
    const managedDelegation = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'release-notes',
      '--objective', '按照 release checklist 改进发布说明',
      '--acceptance', JSON.stringify(['保持固定测试通过'])
    ]);
    assert.equal(managedDelegation.task.status, 'dispatched');
    assert.ok(managedDelegation.task.context.skills.some(skill => skill.skill_id === 'release-checklist'));
    await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', managedDelegation.task.id,
      '--reason', '托管项目 Skill Context 测试完成',
      '--confirm'
    ]);
    const secondRegistration = await request(base, '/api/v1/auth/register', {
      method: 'POST',
      body: {
        email: 'second-owner@example.invalid',
        name: 'Second Owner',
        password: 'SecondPassword123',
        invite_code: 'release-test-invite-only'
      }
    });
    assert.equal(secondRegistration.status, 201);
    const secondLogin = await request(base, '/api/v1/auth/login', {
      method: 'POST',
      body: { email: 'second-owner@example.invalid', password: 'SecondPassword123' }
    });
    assert.equal(secondLogin.status, 200);
    const secondToken = secondLogin.data.access_token;
    const secondProjectsBeforeAccess = await request(base, '/api/v1/cloud/projects', { token: secondToken });
    assert.deepEqual(secondProjectsBeforeAccess.data.projects.map(project => project.id), ['courseplanner']);
    const hiddenPrivateProject = await request(base, '/api/v1/cloud/projects/release-notes', { token: secondToken });
    assert.equal(hiddenPrivateProject.status, 404);
    const hiddenPrivateFile = await request(base, '/api/v1/cloud/projects/release-notes/files?path=public/app.js', { token: secondToken });
    assert.equal(hiddenPrivateFile.status, 404);
    const hiddenPrivateDelegation = await request(base, '/api/v1/delegations', {
      token: secondToken,
      method: 'POST',
      body: { project_id: 'release-notes', objective: 'Attempt unauthorized project work' }
    });
    assert.equal(hiddenPrivateDelegation.status, 404);
    const memberAdded = await request(base, '/api/v1/cloud/projects/release-notes/members', {
      token,
      method: 'POST',
      body: { email: 'second-owner@example.invalid' }
    });
    assert.equal(memberAdded.status, 201);
    assert.equal(memberAdded.data.member.id, secondLogin.data.agent.id);
    const ownerMembers = await runCli(atoaHome, ['cloud', 'member-list', '--project', 'release-notes']);
    assert.deepEqual(ownerMembers.members.map(member => member.email), ['second-owner@example.invalid']);
    const visiblePrivateProject = await request(base, '/api/v1/cloud/projects/release-notes', { token: secondToken });
    assert.equal(visiblePrivateProject.status, 200);
    assert.equal(visiblePrivateProject.data.project.access.role, 'member');
    const forbiddenSkill = await request(base, '/api/v1/cloud/projects/release-notes/skills', {
      token: secondToken,
      method: 'POST',
      body: {
        id: 'unauthorized-skill',
        name: 'Unauthorized Skill',
        description: 'This account does not own the managed project',
        instructions: 'This instruction must never be added to the project.'
      }
    });
    assert.equal(forbiddenSkill.status, 403);
    assert.equal(forbiddenSkill.data.error, 'project_owner_required');
    const memberTask = await request(base, '/api/v1/delegations', {
      token: secondToken,
      method: 'POST',
      body: { project_id: 'release-notes', objective: 'Improve the private project introduction while preserving its test' }
    });
    assert.equal(memberTask.status, 201);
    const memberRemoved = await request(base, `/api/v1/cloud/projects/release-notes/members/${secondLogin.data.agent.id}`, {
      token,
      method: 'DELETE'
    });
    assert.equal(memberRemoved.status, 200);
    const revokedProject = await request(base, '/api/v1/cloud/projects/release-notes', { token: secondToken });
    assert.equal(revokedProject.status, 404);
    const revokedTask = await request(base, `/api/v1/delegations/${memberTask.data.task.id}`, { token: secondToken });
    assert.equal(revokedTask.status, 404);
    const revokedTaskRecord = readSqliteState(sqliteFile).delegations
      .find(task => task.id === memberTask.data.task.id);
    assert.equal(revokedTaskRecord.status, 'cancelled');
    assert.equal(revokedTaskRecord.latest_feedback.reason, 'project_access_revoked');

    const read = await runCli(atoaHome, ['cloud', 'read', '--project', 'courseplanner', '--path', 'public/app.js']);
    assert.equal(read.revision, baseRevision);
    assert.match(read.content, /mountCourseAssistant/);

    const worktree = path.join(tempRoot, 'agent-worktree');
    const checkedOut = await runCli(atoaHome, [
      'cloud', 'checkout',
      '--project', 'courseplanner',
      '--dir', worktree
    ]);
    assert.equal(checkedOut.checked_out, true);
    assert.equal(checkedOut.worktree, worktree);
    const metadata = JSON.parse(fs.readFileSync(path.join(worktree, '.atoa-project.json'), 'utf8'));
    assert.equal(metadata.protocol, 'atoa-worktree/v1');
    assert.equal(metadata.base_revision, baseRevision);

    const changedContent = `${read.content}\n// ATOA Cloud Protocol integration test\n`;
    fs.writeFileSync(path.join(worktree, 'public', 'app.js'), changedContent);

    const validated = await runCli(atoaHome, [
      'cloud', 'validate',
      '--worktree', worktree
    ]);
    assert.equal(validated.passed, true);
    assert.match(validated.tests.output, /pass/i);
    assert.match(validated.validation_id, /^val_[a-f0-9]{16}$/);
    assert.equal(validated.base_revision, baseRevision);

    const afterValidation = await runCli(atoaHome, ['cloud', 'show', '--project', 'courseplanner']);
    assert.equal(afterValidation.project.revision, baseRevision);
    const emptyHistory = await request(base, '/api/v1/cloud/projects/courseplanner/changes', { token });
    assert.deepEqual(emptyHistory.data.changes, []);

    const rejectedValidation = await request(base, '/api/v1/cloud/projects/courseplanner/validate', {
      token,
      method: 'POST',
      body: {
        base_revision: baseRevision,
        files: [{ path: 'public/app.js', content: `${changedContent}\nfetch('https://example.com/private');` }]
      }
    });
    assert.equal(rejectedValidation.status, 422);
    assert.equal(rejectedValidation.data.passed, false);
    assert.equal(rejectedValidation.data.review.passed, false);
    const historyAfterValidation = await request(base, '/api/v1/cloud/projects/courseplanner/changes', { token });
    assert.deepEqual(historyAfterValidation.data.changes, []);

    const persistentStateValidation = await request(base, '/api/v1/cloud/projects/courseplanner/validate', {
      token,
      method: 'POST',
      body: {
        base_revision: baseRevision,
        files: [{
          path: 'public/app.js',
          content: `${changedContent}\n// 项目可使用 localStorage.setItem('atoa-project-state', 'value') 保存非敏感应用状态`
        }]
      }
    });
    assert.equal(persistentStateValidation.status, 200);
    assert.equal(persistentStateValidation.data.review.passed, true);
    assert.equal(persistentStateValidation.data.tests.passed, true);

    const secretValidation = await request(base, '/api/v1/cloud/projects/courseplanner/validate', {
      token,
      method: 'POST',
      body: {
        base_revision: baseRevision,
        files: [{
          path: 'public/app.js',
          content: `${changedContent}\nconst apiKey = "1234567890abcdefPRIVATE";`
        }]
      }
    });
    assert.equal(secretValidation.status, 422);
    assert.equal(secretValidation.data.review.passed, false);
    assert.ok(secretValidation.data.review.findings.some(finding => finding.rule === 'no-assigned-secret'));

    const accepted = await runCli(atoaHome, [
      'cloud', 'submit',
      '--worktree', worktree,
      '--message', '验证云端贡献闭环；联系 dev@example.com；参考 /private/example/plan.md',
      '--confirm'
    ]);
    assert.equal(accepted.change.status, 'accepted');
    assert.equal(accepted.change.tests.passed, true);
    assert.notEqual(accepted.change.revision, baseRevision);
    assert.equal(accepted.change.demo.revision, accepted.change.revision);
    assert.equal(accepted.change.demo.immutable, true);
    assert.match(accepted.change.message, /\[email hidden\]/);
    assert.match(accepted.change.message, /\[local path hidden\]/);
    assert.doesNotMatch(accepted.change.message, /dev@example\.com|\/private\/example/);
    assert.match(accepted.change.demo.path, /^\/demo-history\/courseplanner\/[a-f0-9]{16}\/$/);
    const browserSessionStillValid = await request(base, '/api/v1/agents/me', { cookie: browserCookie });
    assert.equal(browserSessionStillValid.status, 200);
    const acceptedDemo = await request(base, accepted.change.demo.path, {
      cookie: browserCookie,
      redirect: 'manual'
    });
    assert.equal(acceptedDemo.status, 200, acceptedDemo.headers.get('location') || 'demo request failed');
    assert.match(acceptedDemo.data, /Student Course Planner/);
    assert.equal(accepted.worktree.cleaned, true);
    assert.equal(fs.existsSync(worktree), false);

    const replay = await request(base, '/api/v1/cloud/projects/courseplanner/changes', {
      token,
      method: 'POST',
      body: {
        base_revision: baseRevision,
        message: '验证云端贡献闭环；联系 dev@example.com；参考 /private/example/plan.md',
        files: [{ path: 'public/app.js', content: changedContent }]
      }
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(replay.data.change.id, accepted.change.id);
    assert.equal(replay.data.preview_url, `${base}${accepted.change.demo.path}`);

    const conflict = await request(base, '/api/v1/cloud/projects/courseplanner/changes', {
      token,
      method: 'POST',
      body: {
        base_revision: baseRevision,
        message: '旧版本不应覆盖新版本',
        files: [{ path: 'public/app.js', content: `${changedContent}\n// stale` }]
      }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error, 'cloud_revision_conflict');

    const rejected = await request(base, '/api/v1/cloud/projects/courseplanner/changes', {
      token,
      method: 'POST',
      body: {
        base_revision: accepted.change.revision,
        message: '危险网络调用应被拒绝',
        files: [{ path: 'public/app.js', content: `${changedContent}\nfetch('https://example.com/private');` }]
      }
    });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.data.change.status, 'rejected');
    assert.equal(rejected.data.change.review.passed, false);

    const retest = await request(base, '/api/v1/cloud/projects/courseplanner/test', {
      token,
      method: 'POST',
      body: {}
    });
    assert.equal(retest.status, 200);
    assert.equal(retest.data.passed, true);

    const history = await request(base, '/api/v1/cloud/projects/courseplanner/changes', { token });
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.changes.map(change => change.status), ['rejected', 'accepted']);
    const publicHistory = await request(base, '/api/cloud-projects/courseplanner', { token });
    assert.equal(publicHistory.data.project.contributions.total, 2);
    assert.equal(publicHistory.data.project.contributions.accepted, 1);
    assert.equal(publicHistory.data.project.contributions.runnable, 1);
    assert.equal(publicHistory.data.project.contributions.rejected, 1);
    assert.deepEqual(publicHistory.data.changes.map(change => change.status), ['rejected', 'accepted']);
    assert.equal(publicHistory.data.changes[0].review.passed, false);
    assert.match(publicHistory.data.changes[1].tests.output, /# tests [1-9]\d*/);
    assert.equal(publicHistory.data.changes[1].demo.path, accepted.change.demo.path);
    assert.deepEqual(
      publicHistory.data.project.skills.map(skill => skill.id),
      ['course-planning', 'course-reviews']
    );

    const conflictingContract = await request(base, '/api/v1/delegations', {
      token,
      method: 'POST',
      body: {
        project_id: 'courseplanner',
        objective: '接入第三方天气 API 并实时请求天气',
        acceptance_criteria: ['浏览器直接调用外部 API']
      }
    });
    assert.equal(conflictingContract.status, 422);
    assert.equal(conflictingContract.data.error, 'delegation_contract_conflict');
    assert.equal(conflictingContract.data.conflicts[0].rule, 'no-network-egress');
    assert.match(conflictingContract.data.coordinator_message, /未创建任务/);

    const delegated = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '为课程推荐流程增加一条协议实现标记',
      '--acceptance', JSON.stringify(['保持现有测试通过', '只修改 public/app.js'])
    ]);
    assert.equal(delegated.task.status, 'dispatched');
    assert.equal(delegated.task.protocol, 'atoa-delegation/v1');
    assert.ok(delegated.task.data_boundary.never_collected.some(item => /其他 Codex 对话 session/.test(item)));
    assert.ok(delegated.task.context.files.length > 0);
    assert.equal(delegated.task.context.files[0].content, undefined);
    assert.match(delegated.task.context.files[0].hash, /^[a-f0-9]{64}$/);
    assert.equal(delegated.task.context.skills.length, 1);
    assert.equal(delegated.task.context.skills[0].skill_id, 'course-planning');
    assert.equal(delegated.task.context.skills[0].kind, 'skill');
    assert.equal(delegated.task.context.skills[0].editable, false);
    assert.equal(delegated.task.context.skills[0].content, undefined);
    assert.match(delegated.task.context.skills[0].hash, /^[a-f0-9]{64}$/);
    const taskId = delegated.task.id;

    const claimed = await runCli(atoaHome, ['delegate', 'claim', '--task', taskId]);
    assert.equal(claimed.task.status, 'in_progress');
    assert.equal(claimed.task.assignee.role, 'client-sub-agent');
    assert.ok(claimed.task.context.files.some(file => file.path === 'public/app.js' && file.content));
    assert.match(claimed.task.context.skills[0].content, /# Course planning/);
    assert.ok(claimed.task.usage.context_bytes_sent > 0);
    assert.equal(claimed.local_cache.hits, 0);
    assert.equal(
      claimed.local_cache.misses,
      claimed.task.context.files.length + claimed.task.context.skills.length
    );
    assert.ok(claimed.local_cache.downloaded_bytes > 0);
    assert.ok(fs.existsSync(path.join(atoaHome, 'cache', 'context-v1')));

    const concurrentStyles = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '在 public/styles.css 添加同步开发协议测试标记',
      '--acceptance', JSON.stringify(['保持现有测试通过', '只修改 public/styles.css'])
    ]);
    assert.equal(concurrentStyles.task.status, 'dispatched');
    assert.deepEqual(concurrentStyles.task.permissions.write, ['public/styles.css']);
    assert.deepEqual(concurrentStyles.task.context.files.map(file => file.path), ['public/styles.css']);
    const claimedStyles = await runCli(atoaHome, ['delegate', 'claim', '--task', concurrentStyles.task.id]);
    const overlappingContext = await request(base, `/api/v1/delegations/${taskId}/context-requests`, {
      token,
      method: 'POST',
      body: {
        reason: '验证同步任务不能扩张到其他任务正在占用的源码 Context',
        paths: ['public/styles.css']
      }
    });
    assert.equal(overlappingContext.status, 409);
    assert.equal(overlappingContext.data.error, 'delegation_context_overlap');
    assert.deepEqual(overlappingContext.data.conflicting_paths, ['public/styles.css']);
    const stylesResult = await request(base, `/api/v1/delegations/${concurrentStyles.task.id}/results`, {
      token,
      method: 'POST',
      body: {
        base_revision: claimedStyles.task.base_revision,
        message: '验证不重叠 Context 可以同步开发',
        summary: '在独立样式文件中加入协议测试标记。',
        operations: [{
          type: 'append',
          path: 'public/styles.css',
          expected_hash: claimedStyles.task.context.files[0].hash,
          content: '\n/* ATOA concurrent Context dispatch */\n'
        }],
        evidence: { client_checks: ['scoped Context inspected'] }
      }
    });
    assert.equal(stylesResult.status, 201);
    assert.equal(stylesResult.data.task.status, 'accepted');
    assert.notEqual(stylesResult.data.change.revision, claimed.task.base_revision);

    const cachedDelegation = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '为课程推荐流程增加一条协议实现标记',
      '--acceptance', JSON.stringify(['保持现有测试通过', '只修改 public/app.js'])
    ]);
    const cachedTaskId = cachedDelegation.task.id;
    assert.equal(cachedDelegation.task.status, 'queued');
    assert.equal(cachedDelegation.task.queue_position, 1);
    assert.equal(cachedDelegation.task.waiting_reason, 'context_overlap');
    assert.equal(cachedDelegation.task.waiting_context_conflict_count, 1);
    assert.equal(cachedDelegation.task.base_revision, null);
    assert.equal(cachedDelegation.task.context.version, 0);
    assert.equal(cachedDelegation.task.context.files.length, 0);
    assert.equal(cachedDelegation.next_action, 'local_worker_waiting');
    assert.equal(cachedDelegation.worker_handoff.registered, true);
    assert.equal(cachedDelegation.worker_handoff.started, false);
    const queuedClaim = await request(base, `/api/v1/delegations/${cachedTaskId}/claim`, {
      token,
      method: 'POST',
      body: {}
    });
    assert.equal(queuedClaim.status, 409);
    assert.equal(queuedClaim.data.error, 'delegation_queued');
    assert.equal(queuedClaim.data.next_action, 'wait_for_dispatch');
    await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', cachedTaskId,
      '--reason', '排队拒绝领取测试完成',
      '--confirm'
    ]);

    const moreContext = await runCli(atoaHome, [
      'delegate', 'request-context',
      '--task', taskId,
      '--reason', '需要补充课程评教约定',
      '--query', '评价、评分和持久化',
      '--paths', JSON.stringify(['README.md'])
    ]);
    assert.equal(moreContext.context.version, 2);
    assert.ok(moreContext.added_skills.includes('skills/course-reviews/SKILL.md'));
    assert.equal(moreContext.context.skills[0].skill_id, 'course-reviews');
    assert.match(moreContext.context.skills[0].content, /# Course reviews/);

    const progress = await request(base, `/api/v1/delegations/${taskId}/progress`, {
      token,
      method: 'POST',
      body: { message: '客户端 Sub-agent 已完成实现，准备返回候选结果' }
    });
    assert.equal(progress.status, 200);

    const delegatedApp = claimed.task.context.files.find(file => file.path === 'public/app.js').content;
    const rejectedDelegatedResult = await request(base, `/api/v1/delegations/${taskId}/results`, {
      token,
      method: 'POST',
      body: {
        base_revision: claimed.task.base_revision,
        message: '这个候选应被服务端控制平面拒绝',
        summary: '客户端错误地加入了网络外发调用。',
        files: [{ path: 'public/app.js', content: `${delegatedApp}\nfetch('https://example.com/private');\n` }],
        evidence: { claimed_passed: true }
      }
    });
    assert.equal(rejectedDelegatedResult.status, 422);
    assert.equal(rejectedDelegatedResult.data.task.status, 'revision_requested');
    assert.equal(rejectedDelegatedResult.data.validation.review.passed, false);
    assert.match(rejectedDelegatedResult.data.candidate_id, /^cand_[a-f0-9]{16}$/);
    assert.equal(rejectedDelegatedResult.data.next_action, 'revise_or_reuse_candidate');

    const reusedRejectedCandidate = await request(base, `/api/v1/delegations/${taskId}/results`, {
      token,
      method: 'POST',
      body: {
        base_revision: claimed.task.base_revision,
        reuse_candidate: true
      }
    });
    assert.equal(reusedRejectedCandidate.status, 422);
    assert.equal(reusedRejectedCandidate.data.candidate_id, rejectedDelegatedResult.data.candidate_id);
    assert.equal(reusedRejectedCandidate.data.task.result.reused_candidate, true);

    const delegatedResult = await request(base, `/api/v1/delegations/${taskId}/results`, {
      token,
      method: 'POST',
      body: {
        base_revision: claimed.task.base_revision,
        message: '实现服务端控制平面到客户端 Agent 的委派闭环',
        summary: '客户端 Agent 接收 Context 后返回候选文件，由服务端重新验证并合并。',
        operations: [{
          type: 'insert_before',
          path: 'public/app.js',
          expected_hash: claimed.task.context.files.find(file => file.path === 'public/app.js').hash,
          anchor: "if (typeof document !== 'undefined') mountCourseAssistant();",
          content: '// ATOA delegated sub-agent protocol\n'
        }],
        evidence: { client_checks: ['reviewed diff'], claimed_passed: true }
      }
    });
    assert.equal(delegatedResult.status, 201);
    assert.equal(delegatedResult.data.task.status, 'accepted');
    assert.equal(delegatedResult.data.task.attempts, 3);
    assert.equal(delegatedResult.data.change.delegation_id, taskId);
    assert.equal(delegatedResult.data.change.tests.passed, true);
    assert.equal(delegatedResult.data.change.demo.immutable, true);
    assert.equal(delegatedResult.data.preview_url, `${base}${delegatedResult.data.change.demo.path}`);
    const delegatedDemo = await fetch(`${base}${delegatedResult.data.change.demo.path}`, {
      headers: { Cookie: browserCookie }
    }).then(response => response.text());
    assert.match(delegatedDemo, /Student Course Planner/);

    const cachePrime = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '为课程推荐流程增加一条协议实现标记',
      '--acceptance', JSON.stringify(['保持现有测试通过', '只修改 public/app.js'])
    ]);
    assert.equal(cachePrime.task.status, 'dispatched');
    const cachePrimeClaim = await runCli(atoaHome, ['delegate', 'claim', '--task', cachePrime.task.id]);
    const queuedCache = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '为课程推荐流程增加一条协议实现标记',
      '--acceptance', JSON.stringify(['保持现有测试通过', '只修改 public/app.js'])
    ]);
    assert.equal(queuedCache.task.status, 'queued');
    assert.equal(queuedCache.task.queue_position, 1);
    const queuedTail = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '验证项目任务先进先出调度',
      '--acceptance', JSON.stringify(['保持现有测试通过'])
    ]);
    assert.equal(queuedTail.task.status, 'queued');
    assert.equal(queuedTail.task.queue_position, 2);
    const cancelledPrime = await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', cachePrime.task.id,
      '--reason', '释放项目队列并验证自动派发',
      '--confirm'
    ]);
    assert.equal(cancelledPrime.dispatched_task_id, queuedCache.task.id);
    const dispatchedCache = await runCli(atoaHome, ['delegate', 'show', '--task', queuedCache.task.id]);
    assert.equal(dispatchedCache.task.status, 'dispatched');
    assert.equal(dispatchedCache.task.base_revision, delegatedResult.data.change.revision);
    assert.ok(dispatchedCache.task.context.files.length > 0);
    assert.ok(dispatchedCache.task.events.some(event => event.type === 'queue'));
    assert.ok(dispatchedCache.task.events.some(event => event.type === 'dispatch'));
    const reservation = await request(base, `/api/v1/delegations/${queuedCache.task.id}/worker-reservations`, {
      token,
      method: 'POST',
      body: { worker_id: 'worker_test_reservation' }
    });
    assert.equal(reservation.status, 201);
    assert.match(reservation.data.lease_id, /^lease_[a-f0-9]{16}$/);
    const reservedTask = await request(base, `/api/v1/delegations/${queuedCache.task.id}`, { token });
    assert.equal(Object.hasOwn(reservedTask.data.task, 'worker_reservation'), false);
    assert.doesNotMatch(JSON.stringify(reservedTask.data), new RegExp(reservation.data.lease_id));
    const claimWithoutLease = await request(base, `/api/v1/delegations/${queuedCache.task.id}/claim`, {
      token,
      method: 'POST',
      body: {}
    });
    assert.equal(claimWithoutLease.status, 409);
    assert.equal(claimWithoutLease.data.error, 'delegation_worker_reservation_required');
    const claimedReservation = await request(base, `/api/v1/delegations/${queuedCache.task.id}/claim`, {
      token,
      method: 'POST',
      body: {
        worker_id: 'worker_test_reservation',
        lease_id: reservation.data.lease_id
      }
    });
    assert.equal(claimedReservation.status, 200);
    const cachedClaim = await runCli(atoaHome, ['delegate', 'show', '--task', queuedCache.task.id]);
    assert.equal(
      cachedClaim.local_cache.hits,
      cachedClaim.task.context.files.length + cachedClaim.task.context.skills.length
    );
    assert.equal(cachedClaim.local_cache.misses, 0);
    assert.equal(cachedClaim.local_cache.downloaded_bytes, 0);
    assert.ok(cachedClaim.local_cache.avoided_bytes > 0);
    assert.ok(cachedClaim.task.context.files.every(file => typeof file.content === 'string'));
    assert.ok(cachedClaim.task.context.skills.every(skill => typeof skill.content === 'string'));
    const cachedUsage = await runCli(atoaHome, ['delegate', 'usage', '--task', queuedCache.task.id]);
    assert.equal(
      cachedUsage.usage.context_cache_hits,
      cachedClaim.task.context.files.length + cachedClaim.task.context.skills.length
    );
    assert.equal(cachedUsage.usage.context_cache_misses, 0);
    assert.equal(cachedUsage.usage.context_content_bytes_sent, 0);
    assert.ok(cachedUsage.usage.context_bytes_avoided > 0);
    const cancelledCached = await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', queuedCache.task.id,
      '--reason', '缓存命中测试完成',
      '--confirm'
    ]);
    assert.equal(cancelledCached.dispatched_task_id, queuedTail.task.id);
    const dispatchedTail = await runCli(atoaHome, ['delegate', 'show', '--task', queuedTail.task.id]);
    assert.equal(dispatchedTail.task.status, 'dispatched');
    assert.equal(dispatchedTail.task.base_revision, delegatedResult.data.change.revision);
    await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', queuedTail.task.id,
      '--reason', 'Context 冲突队列测试完成',
      '--confirm'
    ]);

    const workerBlocker = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '占用项目 Context 以验证按需 Worker 唤醒',
      '--acceptance', JSON.stringify(['保持现有测试通过'])
    ]);
    await runCli(atoaHome, ['delegate', 'claim', '--task', workerBlocker.task.id]);
    const fakeAgent = path.join(tempRoot, 'fake-worker-agent.mjs');
    const workerMarker = path.join(tempRoot, 'worker-agent-finished');
    fs.writeFileSync(fakeAgent, `
      import fs from 'node:fs';
      import process from 'node:process';
      import { execFileSync } from 'node:child_process';
      const [cli, marker] = process.argv.slice(2);
      const env = { ...process.env, ATOA_WORKER_DISABLE: '1' };
      execFileSync(process.execPath, [cli, 'delegate', 'claim', '--task', env.ATOA_TASK_ID], { env, stdio: 'ignore' });
      execFileSync(process.execPath, [cli, 'delegate', 'cancel', '--task', env.ATOA_TASK_ID, '--reason', '按需 Worker 测试完成', '--confirm'], { env, stdio: 'ignore' });
      fs.writeFileSync(marker, 'done');
    `);
    const workerEnv = {
      ATOA_WORKER_DISABLE: '0',
      ATOA_WORKER_POLL_MS: '100',
      ATOA_WORKER_IDLE_EXIT_MS: '150',
      ATOA_WORKER_AGENT_COMMAND: process.execPath,
      ATOA_WORKER_AGENT_ARGS_JSON: JSON.stringify([fakeAgent, path.join(root, 'agent-kit', 'cli', 'atoa.mjs'), workerMarker])
    };
    const workerDelegation = await runCli(atoaHome, [
      'delegate', 'create',
      '--project', 'courseplanner',
      '--objective', '由按需 Worker 唤醒新的客户端 Agent',
      '--acceptance', JSON.stringify(['Worker 只在排队期间运行', '客户端 Agent 领取任务'])
    ], workerEnv);
    assert.equal(workerDelegation.task.status, 'queued');
    assert.equal(workerDelegation.next_action, 'local_worker_waiting');
    assert.equal(workerDelegation.worker_handoff.mode, 'on-demand');
    assert.equal(workerDelegation.worker_handoff.registered, true);
    assert.equal(workerDelegation.worker_handoff.started, true);
    t.after(() => {
      try {
        const workerState = JSON.parse(fs.readFileSync(path.join(atoaHome, 'worker', 'worker.pid'), 'utf8'));
        process.kill(workerState.pid, 'SIGTERM');
      } catch {}
    });
    await runCli(atoaHome, [
      'delegate', 'cancel',
      '--task', workerBlocker.task.id,
      '--reason', '释放项目 Context 占用',
      '--confirm'
    ]);
    await waitFor(() => fs.existsSync(workerMarker), '按需 Worker 未启动客户端 Agent');
    const workerTask = await request(base, `/api/v1/delegations/${workerDelegation.task.id}`, { token });
    assert.equal(workerTask.data.task.status, 'cancelled');
    assert.ok(workerTask.data.task.events.some(event => event.type === 'worker_reserve'));
    assert.equal(workerTask.data.task.usage.worker_reservations, 1);
    assert.ok(workerTask.data.task.usage.worker_request_bytes > 0);
    assert.ok(workerTask.data.task.usage.worker_response_bytes_sent > 0);
    await waitFor(async () => {
      const status = await runCli(atoaHome, ['worker', 'status']);
      return status.running === false && status.tasks.length === 0;
    }, '按需 Worker 在任务结束后没有自动退出');

    const finalTask = await request(base, `/api/v1/delegations/${taskId}`, { token });
    assert.equal(finalTask.data.task.status, 'accepted');
    assert.ok(finalTask.data.task.events.some(event => event.type === 'accept'));
    const taskUsage = await request(base, `/api/v1/delegations/${taskId}/usage`, { token });
    assert.equal(taskUsage.status, 200);
    assert.ok(taskUsage.data.usage.client_to_server_bytes > 0);
    assert.ok(taskUsage.data.usage.server_to_client_bytes > 0);
    assert.equal(taskUsage.data.usage.result_submissions, 3);
    assert.equal(taskUsage.data.usage.candidate_reuses, 1);
    assert.ok(taskUsage.data.usage.candidate_bytes_avoided > 0);
    assert.ok(taskUsage.data.usage.context_cache_misses > 0);
    assert.ok(taskUsage.data.usage.context_content_bytes_sent > 0);
    assert.ok(taskUsage.data.usage.api_calls >= 7);
    const publicDelegations = await request(base, '/api/cloud-projects/courseplanner', { token });
    assert.equal(publicDelegations.data.project.delegations.total, 8);
    assert.deepEqual(
      new Set(publicDelegations.data.delegations.map(task => task.status)),
      new Set(['accepted', 'cancelled'])
    );
    assert.ok(publicDelegations.data.delegations.every(task => !Object.hasOwn(task, 'objective')));
    assert.ok(publicDelegations.data.delegations.every(task => task.prompt_visibility === 'participants-only'));
    assert.doesNotMatch(JSON.stringify(publicDelegations.data), /为课程推荐流程增加一条协议实现标记/);
    assert.doesNotMatch(JSON.stringify(publicDelegations.data), /dev@example\.com|\/private\/example/);

    const cleanupWorktree = path.join(tempRoot, 'cleanup-worktree');
    await runCli(atoaHome, ['cloud', 'checkout', '--project', 'courseplanner', '--dir', cleanupWorktree]);
    const cleaned = await runCli(atoaHome, ['cloud', 'cleanup', '--worktree', cleanupWorktree, '--confirm']);
    assert.equal(cleaned.cleaned, true);
    assert.equal(fs.existsSync(cleanupWorktree), false);

    const stored = readSqliteState(sqliteFile);
    assert.equal(stored.schema_version, 1);
    assert.equal(stored.legacy_imports.length, 1);
    assert.equal(stored.legacy_imports[0].source_path, legacyDbFile);
    assert.match(stored.legacy_imports[0].source_sha256, /^[a-f0-9]{64}$/);
    assert.ok(stored.agents.every(agent => /^[a-f0-9]{128}$/.test(agent.password_hash)));
    assert.ok(stored.agents.every(agent => /^[a-f0-9]{32}$/.test(agent.password_salt)));
    assert.doesNotMatch(JSON.stringify(stored), /ProtocolPassword123|SecondPassword123/);
  } catch (error) {
    throw new Error(`${error.message}\n服务日志：\n${logs}`);
  }
});
