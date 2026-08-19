#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];
const forbiddenEntries = [
  '.env',
  '.atoa-demo-history',
  'atoa-data.json',
  'atoa.sqlite'
];

for (const entry of forbiddenEntries) {
  if (fs.existsSync(path.join(root, entry))) failures.push(`forbidden release entry: ${entry}`);
}

const projectRoot = path.join(root, 'cloud-projects');
const projects = fs.readdirSync(projectRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
if (JSON.stringify(projects) !== JSON.stringify(['courseplanner'])) {
  failures.push(`cloud-projects must contain only courseplanner; found: ${projects.join(', ')}`);
}

const ignoredRoots = new Set(['.git', 'node_modules']);
if (fs.existsSync(path.join(root, '.git'))) {
  const trackedRuntimeData = execFileSync('git', ['ls-files', '--', 'data'], {
    cwd: root,
    encoding: 'utf8'
  }).trim();
  if (trackedRuntimeData) failures.push(`runtime data tracked by Git: ${trackedRuntimeData.split('\n').join(', ')}`);
  // A development checkout may contain a protected, Git-ignored runtime volume.
  // The release artifact is checked separately and must not contain this directory.
  ignoredRoots.add('data');
}
const textExtensions = new Set([
  '', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ps1', '.sh', '.txt', '.yaml', '.yml'
]);
const forbiddenText = [
  { label: 'internal host-control interface', pattern: /\bX-[A-Za-z0-9-]+-Internal\b|\/api\/project\/[^/\s]+\/(?:start|stop|restart|logs|status)\b/i },
  { label: 'private absolute home path', pattern: /\/home\/[A-Za-z0-9._-]+\//i },
  { label: 'private key material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: 'live-looking ATOA access token', pattern: /\batoa_[A-Za-z0-9_-]{32,}\b/ },
  { label: 'common live API token', pattern: /\b(?:sk-|gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_/-]{16,}\b/ }
];
const allowedPublicHosts = new Set([
  '127.0.0.1',
  'atoa.example.com',
  'example.com',
  'feross.org',
  'github.com',
  'learn.chatgpt.com',
  'localhost',
  'opencollective.com',
  'registry.npmjs.org',
  'www.patreon.com',
  'your_domain'
]);

function visit(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!prefix && ignoredRoots.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(dir, entry.name);
    const stat = fs.lstatSync(target);
    if (/\.(?:sqlite|sqlite-shm|sqlite-wal)$/i.test(entry.name)) {
      failures.push(`runtime SQLite file not allowed in release: ${relative}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      failures.push(`symbolic link not allowed in release: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) {
      visit(target, relative);
      continue;
    }
    if (!entry.isFile() || stat.size > 2_000_000 || !textExtensions.has(path.extname(entry.name))) continue;
    if (relative === 'scripts/check-public-release.mjs') continue;
    const content = fs.readFileSync(target, 'utf8');
    for (const rule of forbiddenText) {
      if (rule.pattern.test(content)) failures.push(`${rule.label}: ${relative}`);
    }
    for (const match of content.matchAll(/https?:\/\/[^\s<>)"'`]+/g)) {
      if (match[0].includes('${')) continue;
      try {
        const host = new URL(match[0].replace(/[.,;:]$/, '')).hostname.toLowerCase();
        if (!allowedPublicHosts.has(host)) failures.push(`unreviewed public URL host (${host}): ${relative}`);
      } catch {
        failures.push(`unparseable public URL: ${relative}`);
      }
    }
  }
}

visit(root);

if (failures.length) {
  process.stderr.write(`Public release check failed:\n- ${[...new Set(failures)].join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('Public release check passed: one bundled project, no runtime data, host integration, private domain, or obvious credential material.\n');
