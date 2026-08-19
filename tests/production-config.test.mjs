import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const checker = path.join(root, 'scripts', 'check-production-config.mjs');

function run(env) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

test('production config accepts external private data directories', t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atoa-production-config-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  fs.chmodSync(dataRoot, 0o700);
  for (const directory of ['cloud-projects', 'projects', 'demo-history']) {
    fs.mkdirSync(path.join(dataRoot, directory), { mode: 0o700 });
  }
  const result = run({
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://atoa.example.com',
    ATOA_INVITE_CODE: '0123456789abcdef0123456789abcdef',
    ATOA_SQLITE_FILE: path.join(dataRoot, 'atoa.sqlite'),
    ATOA_CLOUD_ROOT: path.join(dataRoot, 'cloud-projects'),
    ATOA_MANAGED_PROJECTS_ROOT: path.join(dataRoot, 'projects'),
    ATOA_DEMO_HISTORY_ROOT: path.join(dataRoot, 'demo-history')
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Production config check passed/);
});

test('production config rejects source-tree data, HTTP, and placeholder secrets', () => {
  const result = run({
    NODE_ENV: 'production',
    PUBLIC_URL: 'http://localhost:7000',
    ATOA_INVITE_CODE: 'replace-with-a-long-random-invite-code',
    ATOA_SQLITE_FILE: path.join(root, 'data', 'atoa.sqlite'),
    ATOA_CLOUD_ROOT: path.join(root, 'cloud-projects'),
    ATOA_MANAGED_PROJECTS_ROOT: path.join(root, 'data', 'projects'),
    ATOA_DEMO_HISTORY_ROOT: path.join(root, 'data', 'demo-history')
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS origin/);
  assert.match(result.stderr, /non-placeholder secret/);
  assert.match(result.stderr, /outside the application source tree/);
});
