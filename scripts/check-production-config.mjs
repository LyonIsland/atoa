#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '..');
const failures = [];
const warnings = [];

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) failures.push(`${name} is required`);
  return value;
}

function checkPrivatePath(name, value, kind = 'directory') {
  if (!value) return;
  if (!path.isAbsolute(value)) {
    failures.push(`${name} must be an absolute path`);
    return;
  }
  const resolved = path.resolve(value);
  if (resolved === appRoot || resolved.startsWith(`${appRoot}${path.sep}`)) {
    failures.push(`${name} must be outside the application source tree (${appRoot})`);
  }
  const target = kind === 'file' ? path.dirname(resolved) : resolved;
  if (!fs.existsSync(target)) {
    failures.push(`${name} parent directory does not exist: ${target}`);
    return;
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) failures.push(`${name} parent is not a directory: ${target}`);
  if ((stat.mode & 0o077) !== 0) failures.push(`${name} directory permissions must not grant group/other access: ${target}`);
  try {
    fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    failures.push(`${name} directory is not fully accessible to the service user: ${target}`);
  }
  if (kind === 'file' && fs.existsSync(resolved)) {
    const fileMode = fs.statSync(resolved).mode & 0o777;
    if ((fileMode & 0o077) !== 0) failures.push(`${name} must be mode 0600 or stricter: ${resolved}`);
  }
}

if (process.env.NODE_ENV !== 'production') failures.push('NODE_ENV must be production');
const publicUrl = required('PUBLIC_URL');
if (publicUrl && (!/^https:\/\/[^/]+(?:\:\d+)?$/.test(publicUrl) || publicUrl.endsWith('/'))) {
  failures.push('PUBLIC_URL must be an HTTPS origin without a path or trailing slash');
}
const inviteCode = required('ATOA_INVITE_CODE');
if (inviteCode && (inviteCode.length < 32 || /^replace-with/i.test(inviteCode))) {
  failures.push('ATOA_INVITE_CODE must be a non-placeholder secret of at least 32 characters');
}

checkPrivatePath('ATOA_SQLITE_FILE', required('ATOA_SQLITE_FILE'), 'file');
checkPrivatePath('ATOA_CLOUD_ROOT', required('ATOA_CLOUD_ROOT'));
checkPrivatePath('ATOA_MANAGED_PROJECTS_ROOT', required('ATOA_MANAGED_PROJECTS_ROOT'));
checkPrivatePath('ATOA_DEMO_HISTORY_ROOT', required('ATOA_DEMO_HISTORY_ROOT'));

if (process.getuid?.() === 0) warnings.push('the process is running as root; production must use the dedicated atoa service user');
if (!process.env.INVOCATION_ID) warnings.push('systemd hardening could not be detected; ensure UMask=0077 and a dedicated service user');

for (const warning of warnings) process.stderr.write(`Production config warning: ${warning}\n`);
if (failures.length) {
  process.stderr.write(`Production config check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write('Production config check passed: HTTPS, secret strength, external data paths, and private permissions are configured.\n');
