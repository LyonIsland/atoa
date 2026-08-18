#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const VERSION = '2.3.0';
const DEFAULT_ENDPOINT = process.env.ATOA_ENDPOINT || 'http://localhost:7000';
const home = path.resolve(process.env.ATOA_HOME || path.join(os.homedir(), '.atoa'));
const configFile = path.join(home, 'config.json');
const WORKTREE_META = '.atoa-project.json';
const CONTEXT_CACHE_VERSION = 'context-v1';
const DEFAULT_CONTEXT_CACHE_BYTES = 64 * 1024 * 1024;
const WORKER_ROOT = path.join(home, 'worker');
const WORKER_TASKS_DIR = path.join(WORKER_ROOT, 'tasks');
const WORKER_LEASES_DIR = path.join(WORKER_ROOT, 'leases');
const WORKER_PID_FILE = path.join(WORKER_ROOT, 'worker.pid');
const WORKER_START_LOCK = path.join(WORKER_ROOT, 'worker.start.lock');
const WORKER_LOG_FILE = path.join(WORKER_ROOT, 'worker.log');

function ensureHome() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

function loadConfig() {
  ensureHome();
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { return { current_server: 'atoa', servers: { atoa: { endpoint: DEFAULT_ENDPOINT } } }; }
}

function saveConfig(config) {
  ensureHome();
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function active(config, override = '') {
  const name = override || config.current_server || 'atoa';
  const server = config.servers?.[name];
  if (!server) throw new Error(`服务器不存在：${name}`);
  return { name, ...server, endpoint: String(server.endpoint).replace(/\/$/, '') };
}

function option(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function flag(args, name) {
  return args.includes(`--${name}`);
}

function output(value, format = '') {
  if (format === 'agent') {
    process.stdout.write(`[ATOA_AGENT_DATA]\n${JSON.stringify(value, null, 2)}\n[/ATOA_AGENT_DATA]\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

async function api(server, method, route, body, { allowFailure = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (server.token) headers.Authorization = `Bearer ${server.token}`;
  let response;
  try {
    response = await fetch(`${server.endpoint}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`无法连接 ATOA：${error.message}`);
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { message: text }; }
  if (!response.ok && !allowFailure) {
    const error = new Error(data.error || data.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  if (!response.ok) data.http_status = response.status;
  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function workerSafeUnlink(file) {
  try { fs.unlinkSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function workerReadJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function workerWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function workerProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function workerTaskKey(serverName, taskId) {
  return createHash('sha256').update(`${serverName}\0${taskId}`).digest('hex');
}

function workerTaskFile(serverName, taskId) {
  return path.join(WORKER_TASKS_DIR, `${workerTaskKey(serverName, taskId)}.json`);
}

function workerLeaseFile(serverName, taskId) {
  return path.join(WORKER_LEASES_DIR, `${workerTaskKey(serverName, taskId)}.json`);
}

function localWorkerId() {
  const file = path.join(WORKER_ROOT, 'worker.id');
  const stored = workerReadJson(file);
  if (/^worker_[a-zA-Z0-9_-]{8,90}$/.test(stored?.id || '')) return stored.id;
  const id = `worker_${randomUUID().replace(/-/g, '')}`;
  workerWriteJson(file, { id, created_at: new Date().toISOString() });
  return id;
}

function currentWorkerPid() {
  const state = workerReadJson(WORKER_PID_FILE);
  return workerProcessAlive(state?.pid) ? state.pid : null;
}

function workerRecords() {
  try {
    return fs.readdirSync(WORKER_TASKS_DIR)
      .filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => ({ file: path.join(WORKER_TASKS_DIR, name), record: workerReadJson(path.join(WORKER_TASKS_DIR, name)) }))
      .filter(item => item.record?.task_id && item.record?.server_name);
  } catch {
    return [];
  }
}

function registerWorkerTask(server, taskId) {
  if (!/^task_[a-f0-9]{16}$/.test(taskId)) throw new Error(`任务 ID 无效：${taskId}`);
  const file = workerTaskFile(server.name, taskId);
  const existing = workerReadJson(file);
  workerWriteJson(file, {
    protocol: 'atoa-worker-task/v1',
    task_id: taskId,
    server_name: server.name,
    project_id: existing?.project_id || null,
    launch_attempts: existing?.launch_attempts || 0,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    cwd: process.cwd()
  });
  return file;
}

function ensureWorkerStartLock() {
  fs.mkdirSync(WORKER_ROOT, { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(WORKER_START_LOCK, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n`);
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const ownerPid = Number(fs.readFileSync(WORKER_START_LOCK, 'utf8').trim());
      if (!workerProcessAlive(ownerPid) || Date.now() - fs.statSync(WORKER_START_LOCK).mtimeMs > 30_000) {
        workerSafeUnlink(WORKER_START_LOCK);
        return ensureWorkerStartLock();
      }
    } catch {}
    return false;
  }
}

function ensureOnDemandWorker(server, taskId) {
  registerWorkerTask(server, taskId);
  if (process.env.ATOA_WORKER_DISABLE === '1') {
    return { mode: 'on-demand', registered: true, started: false, reason: 'disabled_by_environment' };
  }
  const runningPid = currentWorkerPid();
  if (runningPid) return { mode: 'on-demand', registered: true, started: false, pid: runningPid };
  if (!ensureWorkerStartLock()) {
    return { mode: 'on-demand', registered: true, started: false, reason: 'worker_starting' };
  }
  fs.mkdirSync(WORKER_ROOT, { recursive: true, mode: 0o700 });
  const logDescriptor = fs.openSync(WORKER_LOG_FILE, 'a', 0o600);
  const child = spawn(process.execPath, [path.resolve(process.argv[1]), 'worker', 'run', '--internal'], {
    cwd: os.homedir(),
    env: { ...process.env, ATOA_HOME: home },
    detached: true,
    shell: false,
    stdio: ['ignore', logDescriptor, logDescriptor]
  });
  fs.closeSync(logDescriptor);
  child.once('error', () => workerSafeUnlink(WORKER_START_LOCK));
  child.unref();
  return { mode: 'on-demand', registered: true, started: true, pid: child.pid };
}

function readWorkerLease(server, taskId) {
  const file = workerLeaseFile(server.name, taskId);
  const lease = workerReadJson(file);
  if (!lease || Date.parse(lease.lease_expires_at) <= Date.now()) {
    workerSafeUnlink(file);
    return null;
  }
  return lease;
}

function workerLog(message, data = {}) {
  fs.mkdirSync(WORKER_ROOT, { recursive: true, mode: 0o700 });
  const safe = { time: new Date().toISOString(), message, ...data };
  fs.appendFileSync(WORKER_LOG_FILE, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
}

function workerAgentArgs() {
  if (process.env.ATOA_WORKER_AGENT_ARGS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ATOA_WORKER_AGENT_ARGS_JSON);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
    } catch {}
  }
  return ['exec', '--json', '--skip-git-repo-check'];
}

async function launchWorkerAgent(record, server) {
  const command = process.env.ATOA_WORKER_AGENT_COMMAND || 'codex';
  const promptText = `Use $atoa-cocreation now. Execute the existing ATOA delegated task "${record.task_id}" from server alias "${record.server_name}". Do not create another task. Claim this task, use only its scoped Context, submit the candidate, and continue through validation revisions until accepted or genuinely blocked.`;
  const configuredCwd = record.cwd && path.resolve(record.cwd);
  let cwd = os.homedir();
  try {
    const stat = configuredCwd ? fs.lstatSync(configuredCwd) : null;
    if (stat?.isDirectory() && !stat.isSymbolicLink()) cwd = configuredCwd;
  } catch {}
  workerLog('agent_launch', { task_id: record.task_id, server_name: record.server_name });
  return await new Promise(resolve => {
    let settled = false;
    const child = spawn(command, [...workerAgentArgs(), promptText], {
      cwd,
      env: {
        ...process.env,
        ATOA_HOME: home,
        ATOA_SERVER_NAME: server.name,
        ATOA_TASK_ID: record.task_id
      },
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      workerLog('agent_launch_failed', { task_id: record.task_id, error: error.message });
      resolve({ code: null, error: error.message });
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      workerLog('agent_exit', { task_id: record.task_id, code });
      resolve({ code });
    });
  });
}

async function runOnDemandWorker(config) {
  fs.mkdirSync(WORKER_TASKS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(WORKER_LEASES_DIR, { recursive: true, mode: 0o700 });
  const existingPid = currentWorkerPid();
  if (existingPid && existingPid !== process.pid) {
    workerSafeUnlink(WORKER_START_LOCK);
    return { running: true, pid: existingPid, reused: true };
  }
  workerWriteJson(WORKER_PID_FILE, { pid: process.pid, mode: 'on-demand', started_at: new Date().toISOString() });
  workerSafeUnlink(WORKER_START_LOCK);
  const workerId = localWorkerId();
  const pollMs = Math.max(100, Number(process.env.ATOA_WORKER_POLL_MS) || 1500);
  const idleExitMs = Math.max(100, Number(process.env.ATOA_WORKER_IDLE_EXIT_MS) || 60_000);
  let stopping = false;
  let idleSince = null;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  workerLog('worker_start', { worker_id: workerId, pid: process.pid });
  try {
    while (!stopping) {
      const entries = workerRecords();
      if (!entries.length) {
        idleSince ||= Date.now();
        if (Date.now() - idleSince >= idleExitMs) break;
        await sleep(Math.min(pollMs, idleExitMs));
        continue;
      }
      idleSince = null;
      let launched = false;
      for (const entry of entries) {
        const record = entry.record;
        let taskServer;
        try {
          taskServer = active(config, record.server_name);
          requireAuth(taskServer);
          const shown = await api(
            taskServer,
            'GET',
            `/api/v1/delegations/${encodeURIComponent(record.task_id)}`,
            undefined,
            { allowFailure: true }
          );
          const task = shown.task;
          if (!task || shown.http_status === 404) {
            workerLog('task_unavailable', { task_id: record.task_id, server_name: record.server_name });
            workerSafeUnlink(entry.file);
            workerSafeUnlink(workerLeaseFile(record.server_name, record.task_id));
            continue;
          }
          record.project_id = task.project_id;
          record.updated_at = new Date().toISOString();
          if (['accepted', 'cancelled'].includes(task.status)) {
            workerLog('task_terminal', { task_id: record.task_id, status: task.status });
            workerSafeUnlink(entry.file);
            workerSafeUnlink(workerLeaseFile(record.server_name, record.task_id));
            continue;
          }
          if (task.status === 'queued') {
            workerWriteJson(entry.file, record);
            continue;
          }
          if (!['dispatched', 'in_progress', 'revision_requested'].includes(task.status)) continue;
          if (task.status === 'in_progress' && record.last_exit_code === 0) {
            workerLog('task_attention_required', {
              task_id: record.task_id,
              status: task.status,
              reason: 'agent_exited_without_terminal_task_state'
            });
            workerSafeUnlink(entry.file);
            continue;
          }
          if (record.launch_attempts >= 3) {
            workerLog('task_attention_required', { task_id: record.task_id, status: task.status });
            workerSafeUnlink(entry.file);
            continue;
          }
          if (task.status === 'dispatched') {
            const reservation = await api(
              taskServer,
              'POST',
              `/api/v1/delegations/${encodeURIComponent(record.task_id)}/worker-reservations`,
              { worker_id: workerId },
              { allowFailure: true }
            );
            if (reservation.http_status) {
              workerWriteJson(entry.file, record);
              continue;
            }
            workerWriteJson(workerLeaseFile(record.server_name, record.task_id), {
              worker_id: workerId,
              lease_id: reservation.lease_id,
              lease_expires_at: reservation.lease_expires_at
            });
          } else if (task.assignee?.id !== taskServer.agent_id) {
            workerLog('task_assigned_elsewhere', { task_id: record.task_id });
            workerSafeUnlink(entry.file);
            continue;
          }
          record.launch_attempts += 1;
          record.last_launch_at = new Date().toISOString();
          workerWriteJson(entry.file, record);
          const launch = await launchWorkerAgent(record, taskServer);
          record.last_exit_code = launch.code;
          record.last_exit_error = launch.error || null;
          record.updated_at = new Date().toISOString();
          workerWriteJson(entry.file, record);
          launched = true;
          break;
        } catch (error) {
          workerLog('worker_task_error', { task_id: record.task_id, error: error.message });
        }
      }
      await sleep(launched ? Math.min(pollMs, 1000) : pollMs);
    }
  } finally {
    const state = workerReadJson(WORKER_PID_FILE);
    if (state?.pid === process.pid) workerSafeUnlink(WORKER_PID_FILE);
    workerSafeUnlink(WORKER_START_LOCK);
    workerLog('worker_stop', { worker_id: workerId, pid: process.pid });
  }
  return { running: false, stopped: true, pid: process.pid };
}

async function prompt(label) {
  if (!process.stdin.isTTY) throw new Error(`${label}：请通过命令参数提供`);
  const input = readline.createInterface({ input: process.stdin, output: process.stderr });
  const value = await input.question(`${label}：`);
  input.close();
  return value.trim();
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error(`${label}：请通过 ATOA_PASSWORD 环境变量提供`);
  }
  process.stderr.write(`${label}：`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          reject(new Error('已取消'));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

function requireAuth(server) {
  if (!server.token) throw new Error('尚未登录。请运行 atoa auth login --email <邮箱>');
}

function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function contextCacheRoot(server, projectId) {
  const serverKey = contentHash(server.endpoint).slice(0, 16);
  const agentKey = contentHash(server.agent_id || server.token || 'authenticated-agent').slice(0, 16);
  const projectKey = `${String(projectId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}-${contentHash(projectId).slice(0, 12)}`;
  return path.join(home, 'cache', CONTEXT_CACHE_VERSION, serverKey, agentKey, projectKey, 'blobs');
}

function contextBlobPath(server, projectId, hash) {
  if (!/^[a-f0-9]{16,64}$/i.test(hash)) throw new Error(`Context hash 无效：${hash}`);
  return path.join(contextCacheRoot(server, projectId), hash.toLowerCase());
}

function contextHashMatches(content, expectedHash) {
  return contentHash(content).startsWith(String(expectedHash).toLowerCase());
}

function readContextBlob(server, projectId, hash) {
  const target = contextBlobPath(server, projectId, hash);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const content = fs.readFileSync(target, 'utf8');
    if (!contextHashMatches(content, hash)) {
      fs.unlinkSync(target);
      return null;
    }
    const now = new Date();
    fs.utimesSync(target, now, now);
    return content;
  } catch {
    return null;
  }
}

function pruneContextCache(server, projectId) {
  const root = contextCacheRoot(server, projectId);
  const configured = Number(process.env.ATOA_CONTEXT_CACHE_MAX_BYTES);
  const maxBytes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CONTEXT_CACHE_BYTES;
  let entries;
  try {
    entries = fs.readdirSync(root).map(name => {
      const target = path.join(root, name);
      const stat = fs.lstatSync(target);
      return { target, stat };
    }).filter(entry => entry.stat.isFile() && !entry.stat.isSymbolicLink());
  } catch {
    return;
  }
  let total = entries.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const entry of entries.sort((first, second) => first.stat.mtimeMs - second.stat.mtimeMs)) {
    if (total <= maxBytes) break;
    fs.unlinkSync(entry.target);
    total -= entry.stat.size;
  }
}

function writeContextBlob(server, projectId, file) {
  if (typeof file?.content !== 'string' || !contextHashMatches(file.content, file.hash)) {
    throw new Error(`服务端返回的 Context 内容哈希不匹配：${file?.path || 'unknown'}`);
  }
  const target = contextBlobPath(server, projectId, file.hash);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tempTarget = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempTarget, file.content, { mode: 0o600 });
  fs.renameSync(tempTarget, target);
  pruneContextCache(server, projectId);
}

async function hydrateDelegationContext(server, taskId, projectId, manifest) {
  const sourceFiles = Array.isArray(manifest) ? manifest : (manifest?.files || []);
  const skillFiles = Array.isArray(manifest) ? [] : (manifest?.skills || []);
  const manifestFiles = [...sourceFiles, ...skillFiles];
  if (!Array.isArray(manifestFiles) || !manifestFiles.length) {
    return {
      files: [],
      skills: [],
      cache: { hits: 0, misses: 0, avoided_bytes: 0, downloaded_bytes: 0 },
      usage: null
    };
  }
  const cachedContents = new Map();
  const reports = manifestFiles.map(file => {
    const content = readContextBlob(server, projectId, file.hash);
    if (content !== null) cachedContents.set(file.path, content);
    return { path: file.path, hash: file.hash, cached: content !== null };
  });
  const resolution = await api(
    server,
    'POST',
    `/api/v1/delegations/${encodeURIComponent(taskId)}/context-content`,
    { files: reports }
  );
  const downloadedContents = new Map();
  for (const file of [
    ...(resolution.context?.files || []),
    ...(resolution.context?.skills || [])
  ]) {
    writeContextBlob(server, projectId, file);
    downloadedContents.set(file.path, file.content);
  }
  const hydrateFiles = files => files.map(file => {
    const content = cachedContents.get(file.path)
      ?? downloadedContents.get(file.path)
      ?? readContextBlob(server, projectId, file.hash);
    if (typeof content !== 'string') throw new Error(`Context 缓存解析失败：${file.path}`);
    return { ...file, content };
  });
  return {
    files: hydrateFiles(sourceFiles),
    skills: hydrateFiles(skillFiles),
    cache: resolution.context.cache,
    usage: resolution.usage
  };
}

function worktreeTarget(root, file) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(file) || file.includes('..')) {
    throw new Error(`工作区包含非法文件路径：${file}`);
  }
  const target = path.resolve(root, file);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`工作区文件路径越界：${file}`);
  return target;
}

function loadWorktree(input, server) {
  if (!input) throw new Error('需要 --worktree <目录>');
  const root = path.resolve(input);
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch { throw new Error(`工作区不存在：${root}`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`工作区必须是普通目录：${root}`);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(root, WORKTREE_META), 'utf8')); }
  catch { throw new Error(`不是有效的 ATOA 工作区：${root}`); }
  if (meta.protocol !== 'atoa-worktree/v1' || !meta.project_id || !meta.base_revision || !Array.isArray(meta.editable_files)) {
    throw new Error(`ATOA 工作区元数据无效：${root}`);
  }
  if (String(meta.server_endpoint).replace(/\/$/, '') !== server.endpoint) {
    throw new Error(`工作区属于 ${meta.server_endpoint}，当前服务器是 ${server.endpoint}`);
  }
  return { root, meta };
}

function collectWorktreeChanges(worktree) {
  const files = [];
  for (const file of worktree.meta.editable_files) {
    const target = worktreeTarget(worktree.root, file);
    let stat;
    try { stat = fs.lstatSync(target); }
    catch { throw new Error(`工作区文件缺失：${file}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`工作区文件必须是普通文件：${file}`);
    const content = fs.readFileSync(target, 'utf8');
    if (contentHash(content) !== worktree.meta.base_hashes?.[file]) files.push({ path: file, content });
  }
  if (!files.length) throw new Error('工作区没有待验证或提交的变更');
  return files;
}

function removeWorktree(worktree) {
  const forbidden = new Set([path.parse(worktree.root).root, path.resolve(os.homedir()), path.resolve(process.cwd())]);
  if (forbidden.has(worktree.root)) throw new Error(`拒绝清理高风险目录：${worktree.root}`);
  fs.rmSync(worktree.root, { recursive: true, force: true });
}

async function syncSkills(server, targetRoot = process.env.ATOA_SKILLS_DIR || path.join(os.homedir(), '.agents', 'skills')) {
  const manifest = await api(server, 'GET', '/agent-kit/skills-manifest.json');
  const obsolete = ['atoa-profile', 'atoa-broadcast', 'atoa-communication', 'atoa-collaboration'];
  let removed = 0;
  for (const name of obsolete) {
    const target = path.join(targetRoot, name);
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed++;
  }
  let installed = 0;
  for (const entry of manifest.files || []) {
    if (!/^atoa-cocreation\/(?:SKILL\.md|agents\/openai\.yaml)$/.test(entry)) continue;
    const response = await fetch(`${server.endpoint}/agent-kit/skills/${entry}`);
    if (!response.ok) throw new Error(`Skill 下载失败：${entry}`);
    const target = path.join(targetRoot, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await response.text());
    installed++;
  }
  return { installed, removed, target: targetRoot, version: manifest.version };
}

async function main() {
  const args = process.argv.slice(2);
  const format = option(args, 'format');
  const config = loadConfig();
  const server = active(config, option(args, 'server') || process.env.ATOA_SERVER_NAME || '');
  const positional = args.filter(value => !value.startsWith('--') && !['json', 'agent'].includes(value));
  const [group = 'help', action = ''] = positional;

  if (group === 'version' || flag(args, 'version')) {
    return output({ version: VERSION, home, endpoint: server.endpoint }, format);
  }
  if (group === 'help' || flag(args, 'help')) {
    process.stdout.write(`ATOA Collaborative Coding CLI ${VERSION}\n\n命令：\n  auth register|login|logout|status\n  delegate create|list|show|claim|context|request-context|progress|submit|usage|cancel\n  worker ensure|run|status\n  cloud create|skill-add|member-list|member-add|member-remove|list|show|read|test|history\n  cloud checkout|validate|submit|cleanup|change\n  server list|add|use\n  skills sync\n  doctor\n`);
    return;
  }

  if (group === 'worker' && action === 'ensure') {
    requireAuth(server);
    const taskId = option(args, 'task');
    if (!taskId) throw new Error('需要 --task');
    return output({ worker_handoff: ensureOnDemandWorker(server, taskId) }, format);
  }
  if (group === 'worker' && action === 'run') {
    return output(await runOnDemandWorker(config), format);
  }
  if (group === 'worker' && action === 'status') {
    const records = workerRecords().map(item => ({
      task_id: item.record.task_id,
      server_name: item.record.server_name,
      project_id: item.record.project_id,
      launch_attempts: item.record.launch_attempts,
      updated_at: item.record.updated_at
    }));
    const pid = currentWorkerPid();
    return output({ mode: 'on-demand', running: Boolean(pid), pid, tasks: records }, format);
  }

  if (group === 'auth' && action === 'register') {
    const email = option(args, 'email') || await prompt('邮箱');
    const name = option(args, 'name') || await prompt('显示名称');
    const password = process.env.ATOA_PASSWORD || await promptSecret('密码（至少 12 位，包含字母和数字）');
    const inviteCode = option(args, 'invite-code') || process.env.ATOA_INVITE_CODE || '';
    return output(await api(server, 'POST', '/api/v1/auth/register', {
      email,
      name,
      password,
      invite_code: inviteCode
    }), format);
  }
  if (group === 'auth' && action === 'login') {
    const email = option(args, 'email') || await prompt('邮箱');
    const password = process.env.ATOA_PASSWORD || await promptSecret('密码');
    const data = await api(server, 'POST', '/api/v1/auth/login', { email, password });
    config.servers[server.name] = {
      ...config.servers[server.name],
      endpoint: server.endpoint,
      token: data.access_token,
      agent_id: data.agent.id
    };
    saveConfig(config);
    return output({ logged_in: true, agent: data.agent, server: server.name }, format);
  }
  if (group === 'auth' && action === 'logout') {
    requireAuth(server);
    await api(server, 'POST', '/api/v1/auth/logout', {});
    delete config.servers[server.name].token;
    saveConfig(config);
    return output({ logged_out: true }, format);
  }
  if (group === 'auth' && action === 'status') {
    if (!server.token) return output({ logged_in: false, server: server.name }, format);
    const data = await api(server, 'GET', '/api/v1/agents/me');
    return output({ logged_in: true, ...data }, format);
  }

  if (group === 'delegate' && action === 'create') {
    requireAuth(server);
    const projectId = option(args, 'project');
    const objective = option(args, 'objective') || await prompt('任务目标');
    const acceptance = option(args, 'acceptance', '[]');
    if (!projectId) throw new Error('需要 --project');
    const data = await api(server, 'POST', '/api/v1/delegations', {
      project_id: projectId,
      objective,
      acceptance_criteria: JSON.parse(acceptance)
    });
    if (data.task?.status === 'queued') {
      data.worker_handoff = ensureOnDemandWorker(server, data.task.id);
      if (data.worker_handoff.registered) data.next_action = 'local_worker_waiting';
    }
    return output(data, format);
  }
  if (group === 'delegate' && action === 'list') {
    requireAuth(server);
    const status = option(args, 'status');
    return output(await api(server, 'GET', `/api/v1/delegations${status ? `?status=${encodeURIComponent(status)}` : ''}`), format);
  }
  if (group === 'delegate' && (action === 'show' || action === 'context')) {
    requireAuth(server);
    const taskId = option(args, 'task');
    if (!taskId) throw new Error('需要 --task');
    const data = await api(server, 'GET', `/api/v1/delegations/${encodeURIComponent(taskId)}`);
    if (data.task?.assignee?.id === server.agent_id
      && ['in_progress', 'revision_requested', 'accepted'].includes(data.task.status)) {
      const hydrated = await hydrateDelegationContext(
        server,
        taskId,
        data.task.project_id,
        data.task.context
      );
      data.task.context.files = hydrated.files;
      data.task.context.skills = hydrated.skills;
      if (hydrated.usage) data.task.usage = hydrated.usage;
      data.local_cache = hydrated.cache;
    }
    return output(data, format);
  }
  if (group === 'delegate' && action === 'usage') {
    requireAuth(server);
    const taskId = option(args, 'task');
    if (!taskId) throw new Error('需要 --task');
    return output(await api(server, 'GET', `/api/v1/delegations/${encodeURIComponent(taskId)}/usage`), format);
  }
  if (group === 'delegate' && action === 'claim') {
    requireAuth(server);
    const taskId = option(args, 'task');
    if (!taskId) throw new Error('需要 --task');
    const lease = readWorkerLease(server, taskId);
    const data = await api(server, 'POST', `/api/v1/delegations/${encodeURIComponent(taskId)}/claim`, lease
      ? { worker_id: lease.worker_id, lease_id: lease.lease_id }
      : {});
    if (lease) workerSafeUnlink(workerLeaseFile(server.name, taskId));
    const hydrated = await hydrateDelegationContext(
      server,
      taskId,
      data.task.project_id,
      data.task.context
    );
    data.task.context.files = hydrated.files;
    data.task.context.skills = hydrated.skills;
    data.task.usage = hydrated.usage;
    data.local_cache = hydrated.cache;
    return output(data, format);
  }
  if (group === 'delegate' && action === 'request-context') {
    requireAuth(server);
    const taskId = option(args, 'task');
    if (!taskId) throw new Error('需要 --task');
    const data = await api(server, 'POST', `/api/v1/delegations/${encodeURIComponent(taskId)}/context-requests`, {
      reason: option(args, 'reason'),
      query: option(args, 'query'),
      paths: JSON.parse(option(args, 'paths', '[]'))
    });
    const hydrated = await hydrateDelegationContext(
      server,
      taskId,
      data.project_id,
      data.context
    );
    data.context.files = hydrated.files;
    data.context.skills = hydrated.skills;
    if (hydrated.usage) data.usage = hydrated.usage;
    data.local_cache = hydrated.cache;
    return output(data, format);
  }
  if (group === 'delegate' && action === 'progress') {
    requireAuth(server);
    const taskId = option(args, 'task');
    const message = option(args, 'message');
    if (!taskId || !message) throw new Error('需要 --task 和 --message');
    return output(await api(server, 'POST', `/api/v1/delegations/${encodeURIComponent(taskId)}/progress`, { message }), format);
  }
  if (group === 'delegate' && action === 'cancel') {
    requireAuth(server);
    if (!flag(args, 'confirm')) throw new Error('取消会终止当前委派任务。确认后添加 --confirm');
    const taskId = option(args, 'task');
    const reason = option(args, 'reason');
    if (!taskId || !reason) throw new Error('需要 --task 和 --reason');
    return output(await api(server, 'POST', `/api/v1/delegations/${encodeURIComponent(taskId)}/cancel`, { reason }), format);
  }
  if (group === 'delegate' && action === 'submit') {
    requireAuth(server);
    if (!flag(args, 'confirm')) throw new Error('候选结果会交给服务端控制平面验证并可能合并。确认后添加 --confirm');
    const taskId = option(args, 'task');
    const baseRevision = option(args, 'base-revision');
    const message = option(args, 'message');
    const summary = option(args, 'summary');
    const files = option(args, 'files');
    const operations = option(args, 'operations');
    const reuseCandidate = flag(args, 'reuse-candidate');
    const evidence = option(args, 'evidence', '{}');
    if (!taskId || !baseRevision
      || (!reuseCandidate && (!message || !summary || (!files && !operations)))) {
      throw new Error('新候选需要 --message、--summary 以及 --files/--operations；复用候选请使用 --reuse-candidate');
    }
    return output(await api(server, 'POST', `/api/v1/delegations/${encodeURIComponent(taskId)}/results`, {
      base_revision: baseRevision,
      ...(message ? { message } : {}),
      ...(summary ? { summary } : {}),
      ...(files ? { files: JSON.parse(files) } : {}),
      ...(operations ? { operations: JSON.parse(operations) } : {}),
      ...(reuseCandidate ? { reuse_candidate: true } : {}),
      evidence: JSON.parse(evidence)
    }, { allowFailure: true }), format);
  }

  if (group === 'cloud' && action === 'list') {
    requireAuth(server);
    return output(await api(server, 'GET', '/api/v1/cloud/projects'), format);
  }
  if (group === 'cloud' && action === 'create') {
    requireAuth(server);
    const id = option(args, 'id');
    const name = option(args, 'name');
    const description = option(args, 'description');
    if (!id || !name || !description) throw new Error('需要 --id、--name 和 --description');
    return output(await api(server, 'POST', '/api/v1/cloud/projects', { id, name, description }), format);
  }
  if (group === 'cloud' && action === 'skill-add') {
    requireAuth(server);
    const project = option(args, 'project');
    const id = option(args, 'id');
    const name = option(args, 'name');
    const description = option(args, 'description');
    const instructions = option(args, 'instructions');
    const triggers = JSON.parse(option(args, 'triggers', '[]'));
    if (!project || !id || !name || !description || !instructions) {
      throw new Error('需要 --project、--id、--name、--description 和 --instructions');
    }
    return output(await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(project)}/skills`, {
      id,
      name,
      description,
      instructions,
      triggers
    }), format);
  }
  if (group === 'cloud' && action === 'member-list') {
    requireAuth(server);
    const project = option(args, 'project');
    if (!project) throw new Error('需要 --project');
    return output(await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(project)}/members`), format);
  }
  if (group === 'cloud' && action === 'member-add') {
    requireAuth(server);
    const project = option(args, 'project');
    const email = option(args, 'email');
    if (!project || !email) throw new Error('需要 --project 和 --email');
    return output(await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(project)}/members`, { email }), format);
  }
  if (group === 'cloud' && action === 'member-remove') {
    requireAuth(server);
    const project = option(args, 'project');
    const member = option(args, 'member');
    if (!project || !member || !flag(args, 'confirm')) throw new Error('需要 --project、--member 和 --confirm');
    return output(await api(server, 'DELETE', `/api/v1/cloud/projects/${encodeURIComponent(project)}/members/${encodeURIComponent(member)}`), format);
  }
  if (group === 'cloud' && action === 'show') {
    requireAuth(server);
    const project = option(args, 'project');
    if (!project) throw new Error('需要 --project');
    return output(await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(project)}`), format);
  }
  if (group === 'cloud' && action === 'read') {
    requireAuth(server);
    const project = option(args, 'project');
    const file = option(args, 'path');
    if (!project || !file) throw new Error('需要 --project 和 --path');
    return output(await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(file)}`), format);
  }
  if (group === 'cloud' && action === 'test') {
    requireAuth(server);
    const project = option(args, 'project');
    if (!project) throw new Error('需要 --project');
    return output(await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(project)}/test`, {}), format);
  }
  if (group === 'cloud' && action === 'history') {
    requireAuth(server);
    const project = option(args, 'project');
    const limit = option(args, 'limit', '20');
    if (!project) throw new Error('需要 --project');
    return output(await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(project)}/changes?limit=${encodeURIComponent(limit)}`), format);
  }
  if (group === 'cloud' && action === 'checkout') {
    requireAuth(server);
    const projectId = option(args, 'project');
    if (!projectId) throw new Error('需要 --project');
    const data = await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(projectId)}`);
    const project = data.project;
    const root = path.resolve(option(args, 'dir') || path.join(os.tmpdir(), 'atoa-worktrees', `${project.id}-${project.revision.slice(0, 8)}`));
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error(`工作区目录不能是符号链接：${root}`);
    if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`工作区目录非空：${root}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const baseHashes = {};
    try {
      for (const file of project.editable_files) {
        const read = await api(server, 'GET', `/api/v1/cloud/projects/${encodeURIComponent(project.id)}/files?path=${encodeURIComponent(file)}`);
        if (read.revision !== project.revision) throw new Error('checkout 期间项目版本发生变化，请重试');
        const target = worktreeTarget(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, read.content, { mode: 0o600 });
        baseHashes[file] = contentHash(read.content);
      }
      const meta = {
        protocol: 'atoa-worktree/v1',
        project_id: project.id,
        project_name: project.name,
        base_revision: project.revision,
        editable_files: project.editable_files,
        base_hashes: baseHashes,
        server_name: server.name,
        server_endpoint: server.endpoint,
        created_at: new Date().toISOString()
      };
      fs.writeFileSync(path.join(root, WORKTREE_META), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      return output({ checked_out: true, worktree: root, project, metadata: WORKTREE_META }, format);
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  if (group === 'cloud' && action === 'validate') {
    requireAuth(server);
    const worktree = loadWorktree(option(args, 'worktree'), server);
    const data = await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(worktree.meta.project_id)}/validate`, {
      base_revision: worktree.meta.base_revision,
      files: collectWorktreeChanges(worktree)
    }, { allowFailure: true });
    return output({ ...data, worktree: worktree.root }, format);
  }
  if (group === 'cloud' && action === 'submit') {
    requireAuth(server);
    if (!flag(args, 'confirm')) throw new Error('云端提交会更新公开项目。确认变更在用户授权范围内后添加 --confirm');
    const message = option(args, 'message');
    if (!message) throw new Error('需要 --message');
    const worktree = loadWorktree(option(args, 'worktree'), server);
    const data = await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(worktree.meta.project_id)}/changes`, {
      base_revision: worktree.meta.base_revision,
      message,
      files: collectWorktreeChanges(worktree)
    });
    const cleaned = !flag(args, 'keep-worktree');
    if (cleaned) removeWorktree(worktree);
    return output({ ...data, worktree: { path: worktree.root, cleaned } }, format);
  }
  if (group === 'cloud' && action === 'cleanup') {
    if (!flag(args, 'confirm')) throw new Error('清理会删除本地 ATOA 工作区。确认准确目录后添加 --confirm');
    const worktree = loadWorktree(option(args, 'worktree'), server);
    removeWorktree(worktree);
    return output({ cleaned: true, worktree: worktree.root }, format);
  }
  if (group === 'cloud' && action === 'change') {
    requireAuth(server);
    if (!flag(args, 'confirm')) throw new Error('云端提交会更新公开项目。确认变更在用户授权范围内后添加 --confirm');
    const project = option(args, 'project');
    const baseRevision = option(args, 'base-revision');
    const message = option(args, 'message');
    const files = option(args, 'files');
    if (!project || !baseRevision || !message || !files) {
      throw new Error('需要 --project、--base-revision、--message 和 --files JSON');
    }
    return output(await api(server, 'POST', `/api/v1/cloud/projects/${encodeURIComponent(project)}/changes`, {
      base_revision: baseRevision,
      message,
      files: JSON.parse(files)
    }), format);
  }

  if (group === 'server' && action === 'list') {
    return output({ current_server: config.current_server, servers: config.servers }, format);
  }
  if (group === 'server' && action === 'add') {
    const name = option(args, 'name');
    const endpoint = option(args, 'endpoint');
    if (!name || !endpoint) throw new Error('需要 --name 和 --endpoint');
    config.servers[name] = { endpoint: endpoint.replace(/\/$/, '') };
    saveConfig(config);
    return output({ added: name, endpoint }, format);
  }
  if (group === 'server' && action === 'use') {
    const name = option(args, 'name');
    if (!config.servers[name]) throw new Error(`服务器不存在：${name}`);
    config.current_server = name;
    saveConfig(config);
    return output({ current_server: name }, format);
  }
  if (group === 'skills' && action === 'sync') {
    return output(await syncSkills(server, option(args, 'target') || undefined), format);
  }
  if (group === 'doctor') {
    const checks = {
      node: process.version,
      home,
      config_writable: true,
      endpoint: server.endpoint,
      authenticated: Boolean(server.token)
    };
    try { checks.server = await api(server, 'GET', '/api/v1'); }
    catch (error) { checks.server_error = error.message; }
    return output(checks, format);
  }

  throw new Error(`未知命令：${group} ${action}`.trim());
}

main().catch(error => {
  process.stderr.write(`ATOA 错误：${error.message}\n`);
  process.exit(error.status === 401 ? 4 : 2);
});
