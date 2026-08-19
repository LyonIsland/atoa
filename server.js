const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } = require('crypto');
const { createSqliteStore, emptyState } = require('./storage/sqlite-store');

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 7000;
const configuredLegacyDb = String(process.env.ATOA_LEGACY_JSON_FILE || process.env.ATOA_DB_FILE || '').trim();
const LEGACY_JSON_FILE = configuredLegacyDb && /\.json$/i.test(configuredLegacyDb)
  ? configuredLegacyDb
  : path.join(__dirname, 'atoa-data.json');
const SQLITE_FILE = process.env.ATOA_SQLITE_FILE
  || (configuredLegacyDb && !/\.json$/i.test(configuredLegacyDb) ? configuredLegacyDb : '')
  || (configuredLegacyDb && /\.json$/i.test(configuredLegacyDb)
    ? path.join(path.dirname(configuredLegacyDb), 'atoa.sqlite')
    : '')
  || path.join(__dirname, 'data', 'atoa.sqlite');
const KIT_DIR = path.join(__dirname, 'agent-kit');
const CLOUD_ROOT = process.env.ATOA_CLOUD_ROOT || path.join(__dirname, 'cloud-projects');
const MANAGED_PROJECTS_ROOT = process.env.ATOA_MANAGED_PROJECTS_ROOT
  || path.join(path.dirname(SQLITE_FILE), 'projects');
const DEMO_HISTORY_ROOT = process.env.ATOA_DEMO_HISTORY_ROOT
  || path.join(path.dirname(SQLITE_FILE), '.atoa-demo-history');
// External Program Projects are opt-in. Open-source distributions must never
// assume that a private sibling checkout exists on the host.
const PROGRAM_PROJECTS = String(process.env.ATOA_PROGRAM_PROJECTS || '').trim();
const CONFIGURED_PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
const INVITE_CODE = String(process.env.ATOA_INVITE_CODE || '');
const SESSION_COOKIE = 'atoa_session';
const execFileAsync = promisify(execFile);
let cloudChangeQueue = Promise.resolve();
const loginAttempts = new Map();

if (process.env.NODE_ENV === 'production') {
  const validProductionSecret = value => value.length >= 32 && !/^replace-with/i.test(value);
  if (!validProductionSecret(INVITE_CODE)) throw new Error('secure_atoa_invite_code_required');
}

const persistence = createSqliteStore({
  sqliteFile: SQLITE_FILE,
  legacyJsonFile: LEGACY_JSON_FILE,
  log: message => console.log(message)
});

function emptyDB() {
  return emptyState();
}

function readDB() {
  return persistence.read();
}

function writeDB(db) {
  persistence.write(db);
}

function cleanText(value, max = 10000) {
  return String(value || '').trim().slice(0, max);
}

function genId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function programProjectDefinitions() {
  const seen = new Set();
  return String(PROGRAM_PROJECTS || '').split(path.delimiter).map(value => value.trim()).filter(Boolean)
    .map(value => {
      const separator = value.indexOf('=');
      const id = separator > 0 ? value.slice(0, separator).trim() : '';
      const configuredPath = separator > 0 ? value.slice(separator + 1).trim() : '';
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !path.isAbsolute(configuredPath) || seen.has(id)) return null;
      try {
        const dir = fs.realpathSync(configuredPath);
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        seen.add(id);
        return { id, dir };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function externalProjectFiles(dir) {
  const files = [];
  let totalBytes = 0;
  const excludedRoots = new Set(['.agents', '.claude', '.git', '.venv', '.venv-vision', 'build', 'certs', 'coverage', 'data', 'dist', 'node_modules']);
  const editablePattern = /\.(?:c|cc|cpp|css|go|h|hpp|html|ino|java|js|json|jsx|md|mjs|php|py|rb|rs|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|ya?ml)$/i;
  function visit(current, prefix = '') {
    if (files.length >= 120 || totalBytes >= 600_000) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (files.length >= 120 || totalBytes >= 600_000) break;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!contextFileAllowed(relative)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if ((!prefix && excludedRoots.has(entry.name)) || entry.name === '__pycache__') continue;
        visit(target, relative);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !editablePattern.test(entry.name)) continue;
      const bytes = fs.statSync(target).size;
      if (bytes > 256_000 || totalBytes + bytes > 600_000) continue;
      const content = fs.readFileSync(target, 'utf8');
      if (content.includes('\0')) continue;
      files.push(relative);
      totalBytes += bytes;
    }
  }
  visit(dir);
  return files;
}

function externalProjectSkills(dir) {
  const roots = ['.claude/skills', '.agents/skills', 'skills'];
  const skills = [];
  let totalBytes = 0;
  for (const relativeRoot of roots) {
    const root = path.join(dir, relativeRoot);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || skills.length >= 20) continue;
      const id = entry.name.toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || skills.some(skill => skill.id === id)) continue;
      const file = `${relativeRoot}/${entry.name}/SKILL.md`;
      const target = path.join(dir, file);
      try {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000 || totalBytes + stat.size > 256_000) continue;
        const content = fs.readFileSync(target, 'utf8');
        if (content.includes('\0')) continue;
        const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '';
        const name = cleanText(frontmatter.match(/^name:\s*(.+)$/m)?.[1], 120) || id;
        const description = cleanText(frontmatter.match(/^description:\s*(.+)$/m)?.[1], 500);
        skills.push({
          id,
          name,
          description,
          file,
          triggers: taskTokens(`${id} ${name} ${description}`).slice(0, 30),
          always: id === 'robot-platform'
        });
        totalBytes += stat.size;
      } catch {}
    }
  }
  return skills;
}

function inferredProjectCopy(dir, id) {
  const copyCandidates = ['claude.md', 'CLAUDE.md', 'README.md', 'readme.md', 'product_define.md'];
  let source = '';
  for (const file of copyCandidates) {
    try {
      source = fs.readFileSync(path.join(dir, file), 'utf8');
      if (source.trim()) break;
    } catch {}
  }
  const heading = source.match(/^#\s+(.+)$/m)?.[1]?.trim() || id;
  const paragraph = source.split(/\r?\n\r?\n/)
    .map(value => value.replace(/^#+\s+.*$/gm, '').trim())
    .find(value => value && !value.startsWith('>') && !value.startsWith('-'));
  const description = cleanText(paragraph, 300)
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1');
  return {
    name: heading.slice(0, 80),
    description: description || `直接管理 Program Projects 中的 ${heading} 项目。`
  };
}

function inferProjectEntry(files) {
  const candidates = [
    'index.html',
    'public/index.html',
    'static/index.html',
    ...files.filter(file => file.endsWith('/index.html')).sort()
  ];
  return candidates.find(file => files.includes(file)) || null;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function secretMatches(candidate, expected) {
  const left = createHash('sha256').update(String(candidate || '')).digest();
  const right = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(left, right);
}

function passwordDigest(password, salt) {
  return scryptSync(String(password), salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  }).toString('hex');
}

function validPassword(password) {
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 200
    && /[a-zA-Z]/.test(password)
    && /\d/.test(password);
}

function passwordMatches(password, agent) {
  if (!agent?.password_salt || !agent?.password_hash || typeof password !== 'string') return false;
  const candidate = Buffer.from(passwordDigest(password, agent.password_salt), 'hex');
  const expected = Buffer.from(agent.password_hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const DUMMY_PASSWORD_CREDENTIAL = {
  password_salt: '00000000000000000000000000000000',
  password_hash: passwordDigest('atoa-invalid-account-password', '00000000000000000000000000000000')
};

function loginRateKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function loginRateLimited(key) {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter(value => now - value < 15 * 60_000);
  loginAttempts.set(key, recent);
  return recent.length >= 20;
}

function recordLoginFailure(key) {
  const recent = loginAttempts.get(key) || [];
  recent.push(Date.now());
  loginAttempts.set(key, recent.slice(-20));
}

function createSession(db, agent) {
  const now = new Date().toISOString();
  const token = `atoa_${randomBytes(32).toString('base64url')}`;
  db.sessions = db.sessions.filter(item => item.expires_at > now);
  db.sessions.push({
    id: genId('ses'),
    agent_id: agent.id,
    token_hash: hashToken(token),
    created_at: now,
    expires_at: new Date(Date.now() + 30 * 86400000).toISOString()
  });
  return token;
}

function requestOrigin(req) {
  return CONFIGURED_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

function projectSkillDefinitions(dir, manifest) {
  const configured = Array.isArray(manifest.skills) ? manifest.skills.slice(0, 20) : [];
  const ids = new Set();
  const paths = new Set();
  let totalBytes = 0;
  return configured.map(entry => {
    const id = cleanText(entry?.id, 64);
    const file = cleanText(entry?.file, 300);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
      || !/^[a-zA-Z0-9._/-]+$/.test(file)
      || file.includes('..')
      || ids.has(id)
      || paths.has(file)) {
      throw new Error(`invalid_project_skill:${id || file || 'unknown'}`);
    }
    const target = path.resolve(dir, file);
    if (!target.startsWith(`${path.resolve(dir)}${path.sep}`)) throw new Error(`invalid_project_skill_path:${file}`);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000 || totalBytes + stat.size > 256_000) {
      throw new Error(`invalid_project_skill_file:${file}`);
    }
    const content = fs.readFileSync(target, 'utf8');
    if (content.includes('\0')) throw new Error(`invalid_project_skill_content:${file}`);
    ids.add(id);
    paths.add(file);
    totalBytes += stat.size;
    return {
      id,
      name: cleanText(entry?.name, 120) || id,
      description: cleanText(entry?.description, 500),
      file,
      triggers: Array.isArray(entry?.triggers)
        ? entry.triggers.map(value => cleanText(value, 80)).filter(Boolean).slice(0, 30)
        : [],
      always: entry?.always === true
    };
  });
}

function atoaProjectFromRoot(projectId, root, sourceType, sourceLabel) {
  const rootPath = path.resolve(root);
  const dir = path.resolve(rootPath, projectId);
  if (dir !== rootPath && !dir.startsWith(`${rootPath}${path.sep}`)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    if (manifest.id !== projectId || !Array.isArray(manifest.editable_files)) return null;
    const editableFiles = manifest.editable_files
      .filter(file => typeof file === 'string' && /^[a-zA-Z0-9._/-]+$/.test(file) && !file.includes('..'))
      .filter(file => fs.existsSync(path.join(dir, file)));
    const skills = projectSkillDefinitions(dir, manifest);
    return {
      ...manifest,
      dir,
      editableFiles,
      skills,
      sourceType,
      sourceLabel,
      previewDir: manifest.entry ? path.dirname(path.join(dir, manifest.entry)) : null
    };
  } catch {
    return null;
  }
}

function cloudProject(projectId) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId || '')) return null;
  const managed = atoaProjectFromRoot(projectId, MANAGED_PROJECTS_ROOT, 'managed_project', 'ATOA Managed Projects');
  if (managed) return managed;
  const bundled = atoaProjectFromRoot(projectId, CLOUD_ROOT, 'atoa_project', 'ATOA Projects');
  if (bundled) return bundled;
  const external = programProjectDefinitions().find(project => project.id === projectId);
  if (!external) return null;
  try {
    const editableFiles = externalProjectFiles(external.dir);
    if (!editableFiles.length) return null;
    const entry = inferProjectEntry(editableFiles);
    const copy = inferredProjectCopy(external.dir, projectId);
    return {
      id: projectId,
      ...copy,
      entry,
      test_file: null,
      validationCommands: [],
      dir: external.dir,
      editableFiles,
      skills: externalProjectSkills(external.dir),
      sourceType: 'program_path',
      sourceLabel: `Program Projects / ${path.basename(external.dir)}`,
      previewDir: entry ? path.dirname(path.join(external.dir, entry)) : null
    };
  } catch {
    return null;
  }
}

function listCloudProjects() {
  const ids = [];
  for (const root of [CLOUD_ROOT, MANAGED_PROJECTS_ROOT]) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !ids.includes(entry.name)) ids.push(entry.name);
    }
  }
  for (const project of programProjectDefinitions()) {
    if (!ids.includes(project.id)) ids.push(project.id);
  }
  return ids.map(cloudProject).filter(Boolean);
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scaffoldManagedProject(projectId, name, description, ownerId) {
  const root = path.resolve(MANAGED_PROJECTS_ROOT);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.resolve(root, projectId);
  if (!target.startsWith(`${root}${path.sep}`) || fs.existsSync(target)) {
    throw new Error('managed_project_already_exists');
  }
  const staging = path.join(root, `.staging-${projectId}-${randomUUID()}`);
  const manifest = {
    id: projectId,
    name,
    description,
    owner_agent_id: ownerId,
    member_agent_ids: [],
    visibility: 'private',
    created_at: new Date().toISOString(),
    entry: 'public/index.html',
    editable_files: ['public/index.html', 'public/styles.css', 'public/app.js', 'tests/app.test.js'],
    skills: [],
    test_file: 'tests/app.test.js'
  };
  const appSource = `export const PROJECT = Object.freeze(${JSON.stringify({ id: projectId, name, description }, null, 2)});\n\nexport function projectSummary() {\n  return \`${'${PROJECT.name}'} — ${'${PROJECT.description}'}\`;\n}\n\nif (typeof document !== 'undefined') {\n  const root = document.querySelector('[data-project-root]');\n  if (root) root.querySelector('[data-project-description]').textContent = PROJECT.description;\n}\n`;
  const testSource = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { PROJECT, projectSummary } from '../public/app.js';\n\ntest('project scaffold exposes its initial product definition', () => {\n  assert.equal(PROJECT.id, ${JSON.stringify(projectId)});\n  assert.ok(PROJECT.name.length > 0);\n  assert.ok(PROJECT.description.length > 0);\n  assert.match(projectSummary(), new RegExp(PROJECT.name));\n});\n`;
  try {
    fs.mkdirSync(path.join(staging, 'public'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'project.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(staging, 'package.json'), `${JSON.stringify({ name: `${projectId}-atoa-project`, private: true, type: 'module' }, null, 2)}\n`);
    fs.writeFileSync(path.join(staging, 'README.md'), `# ${name}\n\n${description}\n`);
    fs.writeFileSync(path.join(staging, 'public', 'index.html'), `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>${htmlEscape(name)}</title>\n  <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n  <main data-project-root>\n    <p class="eyebrow">ATOA PROJECT</p>\n    <h1>${htmlEscape(name)}</h1>\n    <p data-project-description>${htmlEscape(description)}</p>\n  </main>\n  <script type="module" src="./app.js"></script>\n</body>\n</html>\n`);
    fs.writeFileSync(path.join(staging, 'public', 'styles.css'), `:root { color-scheme: light; font-family: system-ui, sans-serif; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f1e8; color: #18352d; }\nmain { width: min(720px, calc(100% - 48px)); padding: 48px; border: 1px solid #c9d5cd; border-radius: 24px; background: white; box-sizing: border-box; }\n.eyebrow { font-size: 12px; letter-spacing: .18em; color: #527166; }\nh1 { font-size: clamp(36px, 7vw, 72px); margin: 12px 0 20px; }\n`);
    fs.writeFileSync(path.join(staging, 'public', 'app.js'), appSource);
    fs.writeFileSync(path.join(staging, 'tests', 'app.test.js'), testSource);
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const created = cloudProject(projectId);
  if (!created) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error('managed_project_reload_failed');
  }
  return created;
}

function cloudRevision(project, dir = project.dir) {
  const hash = createHash('sha256');
  for (const file of [...project.editableFiles].sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(dir, file))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function projectVisibility(project) {
  if (project.visibility === 'registered' || project.visibility === 'private') return project.visibility;
  return project.sourceType === 'managed_project' ? 'private' : 'registered';
}

function projectAccessRole(project, agentId) {
  if (!agentId) return null;
  if (project.owner_agent_id === agentId) return 'owner';
  if (Array.isArray(project.member_agent_ids) && project.member_agent_ids.includes(agentId)) return 'member';
  if (projectVisibility(project) === 'registered') return 'participant';
  return null;
}

function canAccessProject(project, agentId) {
  return Boolean(project && projectAccessRole(project, agentId));
}

function accessibleProjects(agentId) {
  return listCloudProjects().filter(project => canAccessProject(project, agentId));
}

function projectForAgent(projectId, agentId) {
  const project = cloudProject(projectId);
  return canAccessProject(project, agentId) ? project : null;
}

function publicCloudProject(project, origin, agentId = '') {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    entry: project.entry,
    editable_files: project.editableFiles,
    skills: project.skills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description
    })),
    source: {
      type: project.sourceType,
      label: project.sourceLabel
    },
    access: {
      visibility: projectVisibility(project),
      role: projectAccessRole(project, agentId)
    },
    validation_ready: Boolean(project.test_file || project.validationCommands?.length),
    revision: cloudRevision(project),
    preview_url: project.previewDir ? `${origin}/cloud-apps/${project.id}/` : null,
    preview_path: project.previewDir ? `/cloud-apps/${project.id}/` : null
  };
}

function createRunnableDemo(project, revision, contributionId) {
  if (!project.previewDir) return null;
  const projectRoot = path.join(DEMO_HISTORY_ROOT, project.id);
  const target = path.join(projectRoot, revision);
  const relativeEntry = path.relative(project.previewDir, path.join(project.dir, project.entry || ''));
  if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) return null;
  if (!fs.existsSync(target)) {
    fs.mkdirSync(projectRoot, { recursive: true });
    const staging = path.join(projectRoot, `.staging-${revision}-${process.pid}`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.cpSync(project.previewDir, staging, {
        recursive: true,
        dereference: false,
        filter: source => !fs.lstatSync(source).isSymbolicLink()
      });
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    contribution_id: contributionId,
    revision,
    path: `/demo-history/${project.id}/${revision}/`,
    entry: relativeEntry || 'index.html',
    immutable: true
  };
}

function cloudFile(project, file, dir = project.dir) {
  if (!project.editableFiles.includes(file)) return null;
  const root = path.resolve(dir);
  const target = path.resolve(root, file);
  if (!target.startsWith(`${root}${path.sep}`)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return fs.readFileSync(target, 'utf8');
}

function contextFileAllowed(file) {
  const parts = file.split('/');
  const name = parts.at(-1).toLowerCase();
  if (parts.some(part => ['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(part))) return false;
  if (name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/i.test(name)) return false;
  if (/(?:credential|secret|private[-_.]?key)/i.test(name)) return false;
  return true;
}

function projectContextSnapshot(project) {
  const files = project.skills.map(skill => {
    const content = fs.readFileSync(path.join(project.dir, skill.file), 'utf8');
    return {
      path: skill.file,
      content,
      hash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
      editable: false,
      kind: 'skill',
      skill_id: skill.id,
      name: skill.name,
      description: skill.description
    };
  });
  let sourceCount = 0;
  let totalBytes = 0;
  const skillsByPath = new Map(project.skills.map(skill => [skill.file, skill]));
  function visit(dir, prefix = '') {
    if (sourceCount >= 80 || totalBytes >= 500_000) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (sourceCount >= 80 || totalBytes >= 500_000) break;
      if (project.sourceType === 'program_path'
        && !prefix
        && ['.git', '.venv', '.venv-vision', 'build', 'certs', 'data', 'node_modules'].includes(entry.name)) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!contextFileAllowed(relative)) continue;
      if (skillsByPath.has(relative)) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(target, relative);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const bytes = fs.statSync(target).size;
      if (bytes > 256_000 || totalBytes + bytes > 500_000) continue;
      const content = fs.readFileSync(target, 'utf8');
      if (content.includes('\0')) continue;
      files.push({
        path: relative,
        content,
        hash: createHash('sha256').update(content).digest('hex'),
        bytes,
        editable: project.editableFiles.includes(relative),
        kind: 'source'
      });
      sourceCount += 1;
      totalBytes += bytes;
    }
  }
  visit(project.dir);
  return files;
}

function taskTokens(value) {
  const text = cleanText(value, 4000).toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []);
  for (const token of [...tokens]) {
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index++) tokens.add(token.slice(index, index + 2));
    }
  }
  return [...tokens].slice(0, 80);
}

function selectContextPaths(project, snapshot, objective, requested = []) {
  const sources = snapshot.filter(file => file.kind !== 'skill');
  const requestedPaths = new Set(requested.filter(file => sources.some(item => item.path === file)));
  const contractText = cleanText(objective, 8000).toLowerCase();
  const explicitPaths = sources
    .filter(file => contractText.includes(file.path.toLowerCase()))
    .map(file => file.path);
  if (requestedPaths.size || explicitPaths.length) {
    return [...new Set([...requestedPaths, ...explicitPaths])].slice(0, 14);
  }
  const tokens = taskTokens(objective);
  const scored = sources.map(file => {
    const haystack = `${file.path}\n${file.content}`.toLowerCase();
    let score = requestedPaths.has(file.path) ? 10_000 : 0;
    if (file.path === project.entry) score += 500;
    if (file.path === project.test_file) score += 450;
    if (/^(?:readme|project\.json|package\.json)/i.test(file.path)) score += 120;
    if (file.editable) score += 80;
    for (const token of tokens) {
      if (file.path.toLowerCase().includes(token)) score += 35;
      if (haystack.includes(token)) score += 4;
    }
    return { path: file.path, score, bytes: file.bytes };
  }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const selected = [];
  let bytes = 0;
  for (const item of scored) {
    if (selected.length >= 14 || bytes + item.bytes > 220_000) continue;
    if (item.score <= 0 && selected.length >= 6) continue;
    selected.push(item.path);
    bytes += item.bytes;
  }
  return selected;
}

function selectSkillPaths(project, snapshot, objective, requested = []) {
  const tokens = taskTokens(objective);
  const skillsByPath = new Map(project.skills.map(skill => [skill.file, skill]));
  const requestedPaths = new Set(requested.filter(file => skillsByPath.has(file)));
  return snapshot
    .filter(file => file.kind === 'skill')
    .map(file => {
      const skill = skillsByPath.get(file.path);
      const triggerText = [
        skill?.id,
        skill?.name,
        skill?.description,
        ...(skill?.triggers || [])
      ].join('\n').toLowerCase();
      let score = skill?.always || requestedPaths.has(file.path) ? 10_000 : 0;
      for (const token of tokens) {
        if ((skill?.triggers || []).some(trigger => trigger.toLowerCase() === token)) score += 200;
        if (triggerText.includes(token)) score += 25;
        if (file.content.toLowerCase().includes(token)) score += 2;
      }
      return { path: file.path, score };
    })
    .filter(item => item.score >= 50)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 6)
    .map(item => item.path);
}

function delegationEvent(type, actor, message, data = {}) {
  return {
    id: genId('evt'),
    type,
    actor,
    message: cleanText(message, 1000),
    data,
    created_at: new Date().toISOString()
  };
}

function delegationUsage(task) {
  const stored = task.usage || {};
  const usage = {
    task_request_bytes: stored.task_request_bytes || 0,
    worker_request_bytes: stored.worker_request_bytes || 0,
    context_request_bytes: stored.context_request_bytes || 0,
    progress_bytes: stored.progress_bytes || 0,
    candidate_bytes_received: stored.candidate_bytes_received || 0,
    context_bytes_sent: stored.context_bytes_sent || 0,
    context_manifest_bytes_sent: stored.context_manifest_bytes_sent || 0,
    context_content_bytes_sent: stored.context_content_bytes_sent || 0,
    context_cache_report_bytes: stored.context_cache_report_bytes || 0,
    validation_bytes_sent: stored.validation_bytes_sent || 0,
    worker_response_bytes_sent: stored.worker_response_bytes_sent || 0,
    api_calls: stored.api_calls || 0,
    context_deliveries: stored.context_deliveries || 0,
    context_resolutions: stored.context_resolutions || 0,
    context_cache_hits: stored.context_cache_hits || 0,
    context_cache_misses: stored.context_cache_misses || 0,
    context_bytes_avoided: stored.context_bytes_avoided || 0,
    result_submissions: stored.result_submissions || 0,
    candidate_reuses: stored.candidate_reuses || 0,
    candidate_bytes_avoided: stored.candidate_bytes_avoided || 0,
    worker_reservations: stored.worker_reservations || 0
  };
  return {
    ...usage,
    client_to_server_bytes:
      usage.task_request_bytes +
      usage.worker_request_bytes +
      usage.context_request_bytes +
      usage.progress_bytes +
      usage.candidate_bytes_received +
      usage.context_cache_report_bytes,
    server_to_client_bytes: usage.context_bytes_sent + usage.validation_bytes_sent + usage.worker_response_bytes_sent,
    measured_payload_bytes:
      usage.task_request_bytes +
      usage.worker_request_bytes +
      usage.context_request_bytes +
      usage.progress_bytes +
      usage.candidate_bytes_received +
      usage.context_bytes_sent +
      usage.validation_bytes_sent +
      usage.worker_response_bytes_sent,
    measurement: 'application-json-payload',
    excludes: ['HTTP headers', 'TLS overhead', 'model tokens', 'static page assets']
  };
}

function addDelegationUsage(task, field, bytes = 0, countCall = true) {
  task.usage = delegationUsage(task);
  task.usage[field] = (task.usage[field] || 0) + Math.max(0, Number(bytes) || 0);
  if (countCall) task.usage.api_calls += 1;
  delete task.usage.client_to_server_bytes;
  delete task.usage.server_to_client_bytes;
  delete task.usage.measured_payload_bytes;
  delete task.usage.measurement;
  delete task.usage.excludes;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? {}));
}

function delegationManifestEntries(task, paths) {
  const snapshot = task.source_snapshot || [];
  return paths.map(file => {
    const source = snapshot.find(item => item.path === file);
    if (!source) return { path: file, missing: true };
    return {
      path: source.path,
      hash: source.hash,
      bytes: source.bytes,
      editable: source.editable,
      kind: source.kind || 'source',
      ...(source.kind === 'skill' ? {
        skill_id: source.skill_id,
        name: source.name,
        description: source.description
      } : {})
    };
  });
}

function delegationContextManifest(
  task,
  paths = task.context_paths || [],
  skillPaths = task.skill_paths || []
) {
  return {
    version: task.context_version,
    files: delegationManifestEntries(task, paths),
    skills: delegationManifestEntries(task, skillPaths)
  };
}

function publicDelegation(task, { includeEvents = true } = {}) {
  const {
    source_snapshot: snapshot,
    context_paths: contextPaths,
    skill_paths: skillPaths,
    candidate_cache: candidateCache,
    worker_reservation: workerReservation,
    events,
    ...safe
  } = task;
  return {
    ...safe,
    usage: delegationUsage(task),
    context: delegationContextManifest(task),
    ...(includeEvents ? { events: events || [] } : {})
  };
}

function activeWorkerReservation(task) {
  const reservation = task.worker_reservation;
  return reservation && Date.parse(reservation.expires_at) > Date.now() ? reservation : null;
}

function findDelegation(db, taskId) {
  return db.delegations.find(task => task.id === taskId);
}

const ACTIVE_DELEGATION_STATUSES = new Set(['dispatched', 'in_progress', 'revision_requested']);

function delegationContextOverlap(firstPaths = [], secondPaths = []) {
  const second = new Set(secondPaths);
  return firstPaths.filter(file => second.has(file));
}

function updateDelegationQueuePositions(db, projectId) {
  const queued = db.delegations
    .filter(task => task.project_id === projectId && task.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  queued.forEach((task, index) => {
    task.queue_position = index + 1;
    task.waiting_reason = 'context_overlap';
  });
}

function dispatchCompatibleQueuedDelegations(db, projectId) {
  const project = cloudProject(projectId);
  if (!project) return [];
  const dispatched = [];
  const active = db.delegations.filter(task =>
    task.project_id === projectId && ACTIVE_DELEGATION_STATUSES.has(task.status)
  );
  const reservations = [...active];
  const queued = db.delegations
    .filter(item => item.project_id === projectId && item.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const task of queued) {
    const snapshot = projectContextSnapshot(project);
    const contractText = [task.objective, ...(task.acceptance_criteria || [])].join('\n');
    const contextPaths = selectContextPaths(project, snapshot, contractText);
    const conflicts = reservations.flatMap(item => delegationContextOverlap(contextPaths, item.context_paths));
    if (conflicts.length) {
      task.waiting_context_conflict_count = new Set(conflicts).size;
      reservations.push({ context_paths: contextPaths });
      continue;
    }
    task.status = 'dispatched';
    task.base_revision = cloudRevision(project);
    task.context_version = 1;
    task.context_paths = contextPaths;
    task.skill_paths = selectSkillPaths(project, snapshot, contractText);
    task.source_snapshot = snapshot;
    task.permissions.read = snapshot.map(file => file.path);
    task.permissions.write = contextPaths.filter(file => project.editableFiles.includes(file));
    delete task.queue_position;
    delete task.waiting_reason;
    delete task.waiting_context_conflict_count;
    task.updated_at = new Date().toISOString();
    task.events.push(delegationEvent(
      'dispatch',
      'atoa-server-control-plane',
      `ATOA 服务端已派发任务，并为 ${task.context_paths.length} 个源码 Context 路径建立并发占用`,
      {
        context_version: task.context_version,
        context_files: task.context_paths.length,
        context_skills: task.skill_paths.length,
        write_files: task.permissions.write.length,
        concurrent_tasks: active.length,
        base_revision: task.base_revision
      }
    ));
    active.push(task);
    reservations.push(task);
    dispatched.push(task);
  }
  updateDelegationQueuePositions(db, projectId);
  return dispatched;
}

function canAccessDelegation(task, agentId) {
  const participant = task.requested_by?.id === agentId || task.target_agent_id === agentId || task.assignee?.id === agentId;
  return participant && canAccessProject(cloudProject(task.project_id), agentId);
}

const DELEGATION_POLICY = Object.freeze({
  allowed: [
    '使用项目命名空间的 localStorage 保存非敏感应用状态',
    '修改任务 permissions.write 中的文件'
  ],
  denied: [
    '读取 document.cookie 或 sessionStorage',
    '主动访问外部 API、WebSocket、SSE 或其他网络服务',
    '动态执行 eval 或 new Function',
    '加载外部脚本或嵌入访问凭证'
  ]
});

const DELEGATION_DATA_BOUNDARY = Object.freeze({
  sent_by_client: [
    '当前共创任务的用户修改请求与验收标准',
    '当前任务的进度、增量 Context 请求、候选变更与执行证据'
  ],
  never_collected: [
    '其他 Codex 对话 session 或无关对话内容',
    '任务范围外的本地文件、环境变量、浏览器数据或凭证',
    '完整本地仓库或可编辑项目副本'
  ],
  server_protection: [
    '服务端只下发任务所需的只读 Context，并按身份、服务端和项目隔离缓存',
    '候选在合并前扫描 API Key、Token、Cookie、会话数据、网络外发和动态代码风险',
    '只有通过固定测试与安全审查的候选才能生成可运行 Demo 版本'
  ],
  public_sharing: [
    '原始 Prompt、验收标准和任务对话只对任务参与者可见，不进入项目成员看板',
    '接受后的开发意图、实现摘要、变更文件、验证结果和可运行 Demo 仅向有项目访问权的用户展示'
  ]
});

function delegationContractConflicts(objective, acceptanceCriteria) {
  const requirements = [objective, ...acceptanceCriteria].filter(Boolean);
  const checks = [
    {
      rule: 'no-network-egress',
      pattern: /(?:第三方|外部).{0,12}(?:API|接口|服务)|(?:联网|跨设备|云端|服务器).{0,8}(?:同步|请求)|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|SSE)\b/i,
      message: '当前项目安全策略禁止主动访问外部网络；请改为本地数据方案，或先由平台管理员调整项目能力。'
    },
    {
      rule: 'no-browser-secrets',
      pattern: /\bdocument\.cookie\b|\bsessionStorage\b|读取.{0,8}(?:Cookie|会话存储)/i,
      message: '当前项目安全策略禁止读取 Cookie 或 sessionStorage。'
    },
    {
      rule: 'no-dynamic-code',
      pattern: /\beval\b|\bnew\s+Function\b|动态执行.{0,6}代码/i,
      message: '当前项目安全策略禁止动态执行代码。'
    }
  ];
  const conflicts = [];
  for (const requirement of requirements) {
    for (const check of checks) {
      const match = requirement.match(check.pattern);
      if (match && !conflicts.some(item => item.rule === check.rule)) {
        conflicts.push({
          rule: check.rule,
          requirement,
          matched: cleanText(match[0], 120),
          message: check.message
        });
      }
    }
  }
  return conflicts;
}

function reviewCloudFiles(project, dir) {
  const findings = [];
  const forbidden = [
    { rule: 'no-dynamic-code', pattern: /\beval\s*\(|\bnew\s+Function\s*\(/, message: '禁止动态执行代码' },
    { rule: 'no-browser-secrets', pattern: /\bdocument\.cookie\b|\bsessionStorage\b/, message: '项目不允许读取 Cookie 或会话级浏览器数据；允许使用项目命名空间的 localStorage 保存应用状态' },
    { rule: 'no-network-egress', pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/, message: '项目不允许主动向外部网络发送数据' },
    { rule: 'no-inline-external-script', pattern: /<script[^>]+src\s*=\s*["']https?:\/\//i, message: '禁止加载外部脚本' },
    { rule: 'no-obvious-secret', pattern: /\b(?:sk[-_]|atoa_|gh[pousr]_|xox[baprs]-|AKIA)[A-Za-z0-9_/-]{16,}\b/, message: '疑似包含 API Key、访问 Token 或云凭证' },
    { rule: 'no-assigned-secret', pattern: /\b(?:api[_-]?key|access[_-]?token|secret(?:[_-]?key)?|password)\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/i, message: '疑似把私有 API Key、Token、密码或密钥写入项目源码' }
  ];
  const matchCount = (pattern, content) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    return [...content.matchAll(new RegExp(pattern.source, flags))].length;
  };
  let bytes = 0;
  for (const file of project.editableFiles) {
    const content = cloudFile(project, file, dir) || '';
    const baseline = dir === project.dir ? content : (cloudFile(project, file, project.dir) || '');
    bytes += Buffer.byteLength(content);
    for (const check of forbidden) {
      if (matchCount(check.pattern, content) > matchCount(check.pattern, baseline)) {
        findings.push({ file, rule: check.rule, message: check.message });
      }
    }
  }
  if (bytes > 600_000) findings.push({ file: '*', rule: 'size-limit', message: '可编辑源码总量超过 600KB' });
  return {
    passed: findings.length === 0,
    checks: [
      { name: '文件白名单', passed: true },
      { name: '源码大小限制', passed: bytes <= 600_000 },
      { name: '危险能力扫描', passed: findings.length === 0 }
    ],
    findings
  };
}

async function testCloudProject(project, dir = project.dir) {
  const review = reviewCloudFiles(project, dir);
  if (!review.passed) {
    return { passed: false, review, tests: { passed: false, output: '安全规则扫描未通过，未执行测试。' } };
  }
  if (project.validationCommands?.length) {
    let output = '';
    try {
      for (const validation of project.validationCommands) {
        const result = await execFileAsync(validation.command, validation.args, {
          cwd: dir,
          timeout: 20_000,
          maxBuffer: 512_000,
          env: { PATH: process.env.PATH || '' }
        });
        output += `${validation.name}\n${result.stdout || ''}${result.stderr || ''}\n`;
      }
      return {
        passed: true,
        review,
        tests: { passed: true, output: cleanText(output, 12000) }
      };
    } catch (error) {
      return {
        passed: false,
        review,
        tests: {
          passed: false,
          output: cleanText(`${output}${error.stdout || ''}${error.stderr || ''}${error.message || ''}`, 12000)
        }
      };
    }
  }
  if (!project.test_file && !project.validationCommands?.length) {
    return {
      passed: false,
      review,
      tests: {
        passed: false,
        output: '该 Program Project 尚未声明固定测试。ATOA 可以直接解析和读取项目源码，但在配置权威验证前不会创建可合并的候选。'
      }
    };
  }
  try {
    const result = await execFileAsync(process.execPath, ['--test', project.test_file], {
      cwd: dir,
      timeout: 12_000,
      maxBuffer: 512_000,
      env: { PATH: process.env.PATH || '' }
    });
    return {
      passed: true,
      review,
      tests: { passed: true, output: cleanText(`${result.stdout || ''}${result.stderr || ''}`, 12000) }
    };
  } catch (error) {
    return {
      passed: false,
      review,
      tests: { passed: false, output: cleanText(`${error.stdout || ''}${error.stderr || ''}${error.message || ''}`, 12000) }
    };
  }
}

function prepareCloudChanges(project, submittedFiles) {
  if (!Array.isArray(submittedFiles) || !submittedFiles.length) {
    return { error: { status: 400, body: { error: 'cloud_files_required' } } };
  }
  if (submittedFiles.length > 10) {
    return { error: { status: 400, body: { error: 'too_many_files' } } };
  }
  const seen = new Set();
  const changes = [];
  for (const input of submittedFiles) {
    const file = cleanText(input?.path, 300);
    if (!project.editableFiles.includes(file) || seen.has(file) || typeof input?.content !== 'string') {
      return { error: { status: 400, body: { error: 'invalid_or_duplicate_cloud_file', path: file } } };
    }
    if (Buffer.byteLength(input.content) > 256_000) {
      return { error: { status: 413, body: { error: 'cloud_file_too_large', path: file } } };
    }
    seen.add(file);
    const before = cloudFile(project, file);
    if (before !== input.content) changes.push({ path: file, before, after: input.content });
  }
  if (!changes.length) return { error: { status: 400, body: { error: 'cloud_change_has_no_effect' } } };
  return { changes };
}

function materializeDelegationOperations(task, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 40) {
    return { error: { status: 400, body: { error: 'delegation_operations_required_or_too_many' } } };
  }
  const contents = new Map();
  const baseHashes = new Map();
  for (const operation of operations) {
    const file = cleanText(operation?.path, 300);
    if (!task.permissions.write.includes(file)) {
      return { error: { status: 400, body: { error: 'delegation_write_scope_violation', paths: [file] } } };
    }
    const source = task.source_snapshot.find(item => item.path === file);
    if (!source) return { error: { status: 400, body: { error: 'delegation_source_file_missing', path: file } } };
    if (!contents.has(file)) {
      if (operation.expected_hash && operation.expected_hash !== source.hash) {
        return {
          error: {
            status: 409,
            body: { error: 'delegation_file_hash_conflict', path: file, expected_hash: source.hash }
          }
        };
      }
      contents.set(file, source.content);
      baseHashes.set(file, source.hash);
    }
    const type = cleanText(operation.type, 30);
    if (type === 'replace') {
      const find = String(operation.find ?? '');
      const replacement = String(operation.replacement ?? '');
      if (!find || Buffer.byteLength(replacement) > 120_000) {
        return { error: { status: 400, body: { error: 'invalid_replace_operation', path: file } } };
      }
      const content = contents.get(file);
      const first = content.indexOf(find);
      if (first < 0 || content.indexOf(find, first + find.length) >= 0) {
        return {
          error: {
            status: 409,
            body: { error: 'replace_anchor_missing_or_ambiguous', path: file, anchor_preview: find.slice(0, 120) }
          }
        };
      }
      contents.set(file, `${content.slice(0, first)}${replacement}${content.slice(first + find.length)}`);
    } else if (type === 'insert_before' || type === 'insert_after') {
      const anchor = String(operation.anchor ?? '');
      const inserted = String(operation.content ?? '');
      if (!anchor || !inserted || Buffer.byteLength(inserted) > 120_000) {
        return { error: { status: 400, body: { error: 'invalid_insert_operation', path: file, type } } };
      }
      const content = contents.get(file);
      const first = content.indexOf(anchor);
      if (first < 0 || content.indexOf(anchor, first + anchor.length) >= 0) {
        return {
          error: {
            status: 409,
            body: {
              error: 'insert_anchor_missing_or_ambiguous',
              path: file,
              type,
              anchor_preview: anchor.slice(0, 120)
            }
          }
        };
      }
      const insertionPoint = type === 'insert_before' ? first : first + anchor.length;
      contents.set(file, `${content.slice(0, insertionPoint)}${inserted}${content.slice(insertionPoint)}`);
    } else if (type === 'append') {
      const content = String(operation.content ?? '');
      if (!content || Buffer.byteLength(content) > 120_000) {
        return { error: { status: 400, body: { error: 'invalid_append_operation', path: file } } };
      }
      contents.set(file, `${contents.get(file)}${content}`);
    } else {
      return { error: { status: 400, body: { error: 'unsupported_delegation_operation', type } } };
    }
  }
  return {
    files: [...contents].map(([file, content]) => ({ path: file, content })),
    operation_summary: {
      count: operations.length,
      files: [...contents.keys()],
      base_hashes: Object.fromEntries(baseHashes)
    }
  };
}

function cloudChangeFiles(changes) {
  return changes.map(change => ({
    path: change.path,
    before_hash: createHash('sha256').update(change.before).digest('hex').slice(0, 12),
    after_hash: createHash('sha256').update(change.after).digest('hex').slice(0, 12)
  }));
}

function cloudChangeRequestHash(agentId, projectId, baseRevision, message, submittedFiles) {
  return createHash('sha256')
    .update(agentId).update('\0')
    .update(projectId).update('\0')
    .update(baseRevision).update('\0')
    .update(message).update('\0')
    .update(JSON.stringify(submittedFiles.map(file => ({ path: file?.path, content: file?.content }))))
    .digest('hex');
}

async function validateCloudChanges(project, changes) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atoa-cloud-'));
  const stageDir = path.join(tempRoot, project.id);
  try {
    if (project.sourceType === 'program_path') {
      fs.mkdirSync(stageDir, { recursive: true });
      for (const file of project.editableFiles) {
        const source = path.join(project.dir, file);
        const target = path.join(stageDir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    } else {
      fs.cpSync(project.dir, stageDir, { recursive: true });
    }
    for (const change of changes) fs.writeFileSync(path.join(stageDir, change.path), change.after);
    return await testCloudProject(project, stageDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function withCloudChangeLock(work) {
  const next = cloudChangeQueue.then(work, work);
  cloudChangeQueue = next.catch(() => {});
  return next;
}

function publicChange(change) {
  const { request_hash: _requestHash, ...safe } = change;
  return {
    ...safe,
    message: sanitizePublicNarrative(safe.message),
    ...(safe.summary ? { summary: sanitizePublicNarrative(safe.summary) } : {})
  };
}

function publicChangeSummary(change) {
  return {
    id: change.id,
    message: sanitizePublicNarrative(change.message),
    status: change.status,
    author: change.author,
    revision: change.revision,
    demo: change.demo || null,
    files: change.files,
    created_at: change.created_at
  };
}

function sanitizePublicNarrative(value) {
  return cleanText(value, 2000)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email hidden]')
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}\b/g, '[phone number hidden]')
    .replace(/\bhttps?:\/\/[^\s"'`)]+/gi, '[link hidden]')
    .replace(/\/(?:home|Users|private|var|etc|opt|tmp)\/[^\s"'`)]+/g, '[local path hidden]')
    .replace(/[A-Za-z]:\\[^\s"'`)]+/g, '[local path hidden]')
    .replace(/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi, '[credential hidden]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[credential hidden]');
}

function recordCloudChange(change) {
  const db = readDB();
  db.cloud_changes.unshift(change);
  db.cloud_changes = db.cloud_changes.slice(0, 1000);
  writeDB(db);
}

function backfillCurrentRunnableDemos() {
  const db = readDB();
  let changed = false;
  for (const project of listCloudProjects()) {
    if (!project.previewDir) continue;
    const revision = cloudRevision(project);
    const contribution = db.cloud_changes.find(change =>
      change.project_id === project.id
      && change.status === 'accepted'
      && change.revision === revision
    );
    if (!contribution || contribution.demo) continue;
    contribution.demo = createRunnableDemo(project, revision, contribution.id);
    changed = true;
  }
  if (changed) writeDB(db);
}

function publicAgent(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    email: agent.email,
    name: agent.name || '',
    created_at: agent.created_at,
    updated_at: agent.updated_at
  };
}

function requestCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return cookies;
}

function requestAuthentication(req) {
  const value = req.headers.authorization || '';
  const bearer = value.startsWith('Bearer ') ? value.slice(7).trim() : '';
  const cookie = requestCookies(req)[SESSION_COOKIE] || '';
  const token = bearer || cookie;
  if (!token) return null;
  const db = readDB();
  const now = new Date().toISOString();
  const session = db.sessions.find(item => item.token_hash === hashToken(token) && item.expires_at > now);
  if (!session) return null;
  const agent = db.agents.find(item => item.id === session.agent_id);
  if (!agent) return null;
  return { db, agent, session, source: bearer ? 'bearer' : 'cookie' };
}

function cookieMutationAllowed(req) {
  if (!req.atoa || req.atoa.source !== 'cookie' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  return String(req.headers.origin || '') === requestOrigin(req);
}

function authRequired(req, res, next) {
  req.atoa = requestAuthentication(req);
  if (!req.atoa) return res.status(401).json({ error: 'authentication_required' });
  if (!cookieMutationAllowed(req)) return res.status(403).json({ error: 'same_origin_required' });
  next();
}

function authPageRequired(req, res, next) {
  req.atoa = requestAuthentication(req);
  if (req.atoa) return next();
  const nextPath = req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//') ? req.originalUrl : '/';
  return res.redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
}

function projectPageRequired(req, res, next) {
  const projectId = cleanText(req.params.projectId || req.query.project || req.query.id, 64);
  const project = cloudProject(projectId);
  if (!canAccessProject(project, req.atoa.agent.id)) return res.status(404).send('Project not found');
  req.atoa.project = project;
  next();
}

function setSessionCookie(req, res, token) {
  const secure = requestOrigin(req).startsWith('https://');
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 86400000
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: requestOrigin(req).startsWith('https://'),
    sameSite: 'lax',
    path: '/'
  });
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/agent-kit/README.md', (req, res) => {
  const origin = requestOrigin(req);
  const template = fs.readFileSync(path.join(KIT_DIR, 'README.md'), 'utf8');
  const rendered = template
    .replaceAll('https://atoa.example.com', origin)
    .replaceAll('http://localhost:7000', origin)
    .replace(
      '把 `atoa.example.com` 替换为平台管理员提供的域名。',
      `本安装说明由 ${origin} 动态生成，命令已经绑定到当前 ATOA 服务端。`
    );
  res.type('text/markdown; charset=utf-8').send(rendered);
});
app.use('/agent-kit', express.static(KIT_DIR, { dotfiles: 'allow' }));
app.get(['/login', '/login.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get(['/philosophy', '/philosophy.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'philosophy.html'));
});
app.get('/platform-theme.css', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'platform-theme.css')));
app.get(['/', '/index.html'], authPageRequired, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/projects/:projectId', authPageRequired, projectPageRequired, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});
app.get('/project.html', authPageRequired, projectPageRequired, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'project.html'));
});
app.use('/cloud-apps/:projectId', authPageRequired, projectPageRequired, (req, res, next) => {
  if (!req.atoa.project.previewDir) return res.status(404).send('Project preview not found');
  return express.static(req.atoa.project.previewDir, { dotfiles: 'deny' })(req, res, next);
});
app.use('/demo-history/:projectId', authPageRequired, projectPageRequired, (req, res, next) => {
  const root = path.join(DEMO_HISTORY_ROOT, req.atoa.project.id);
  return express.static(root, { dotfiles: 'deny', immutable: true, maxAge: '1y' })(req, res, next);
});

app.get('/api/v1', (req, res) => {
  res.json({
    name: 'ATOA Collaborative Coding',
    version: '2.3.0',
    protocol: 'atoa-cocreation/v1',
    cloud_protocol: 'atoa-cloud/v1',
    delegation_protocol: 'atoa-delegation/v1',
    persistence: {
      engine: persistence.engine,
      schema_version: persistence.schemaVersion,
      deployment_mode: 'single-instance'
    },
    data_boundary: DELEGATION_DATA_BOUNDARY,
    agent_kit: `${requestOrigin(req)}/agent-kit/README.md`,
    registration: {
      invite_required: Boolean(INVITE_CODE),
      login_requires_registered_account: true,
      password: { minimum_length: 12, letter_and_number: true }
    },
    capabilities: [
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
    ]
  });
});

app.post('/api/v1/auth/register', (req, res, next) => {
  const email = cleanText(req.body?.email, 254).toLowerCase();
  const name = cleanText(req.body?.name, 80);
  const password = req.body?.password;
  if (INVITE_CODE && !secretMatches(req.body?.invite_code, INVITE_CODE)) {
    return res.status(403).json({ error: 'valid_invite_code_required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid_email_required' });
  }
  if (!validPassword(password)) {
    return res.status(400).json({
      error: 'strong_password_required',
      requirements: { minimum_length: 12, maximum_length: 200, letter_and_number: true }
    });
  }
  const passwordSalt = randomBytes(16).toString('hex');
  const passwordHash = passwordDigest(password, passwordSalt);
  withCloudChangeLock(() => {
    const db = readDB();
    if (db.agents.some(item => item.email === email)) {
      return { status: 409, body: { error: 'account_already_registered' } };
    }
    const now = new Date().toISOString();
    const agent = {
      id: genId('agt'),
      email,
      name: name || email.split('@')[0],
      password_salt: passwordSalt,
      password_hash: passwordHash,
      created_at: now,
      updated_at: now
    };
    db.agents.push(agent);
    writeDB(db);
    return {
      status: 201,
      body: { registered: true, agent: publicAgent(agent), next_action: 'login' }
    };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.post('/api/v1/auth/login', (req, res, next) => {
  const email = cleanText(req.body?.email, 254).toLowerCase();
  const password = req.body?.password;
  const rateKey = loginRateKey(req);
  if (loginRateLimited(rateKey)) {
    return res.status(429).json({ error: 'login_rate_limited', retry_after_seconds: 900 });
  }
  withCloudChangeLock(() => {
    const db = readDB();
    const agent = db.agents.find(item => item.email === email);
    const credential = agent || DUMMY_PASSWORD_CREDENTIAL;
    if (!agent || !passwordMatches(password, credential)) {
      recordLoginFailure(rateKey);
      return { status: 401, body: { error: 'invalid_email_or_password' } };
    }
    loginAttempts.delete(rateKey);
    const token = createSession(db, agent);
    writeDB(db);
    return { status: 200, token, body: { access_token: token, agent: publicAgent(agent) } };
  }).then(result => {
    if (result.token) setSessionCookie(req, res, result.token);
    const body = req.body?.browser_session === true
      ? { logged_in: true, agent: result.body.agent }
      : result.body;
    res.status(result.status).json(body);
  }, next);
});

app.post('/api/v1/auth/logout', authRequired, (req, res, next) => {
  withCloudChangeLock(() => {
    const db = readDB();
    db.sessions = db.sessions.filter(item => item.id !== req.atoa.session.id);
    writeDB(db);
    return { status: 200, body: { logged_out: true } };
  }).then(result => {
    clearSessionCookie(req, res);
    res.status(result.status).json(result.body);
  }, next);
});

app.get('/api/v1/agents/me', authRequired, (req, res) => {
  const contributions = req.atoa.db.cloud_changes.filter(change => change.author?.id === req.atoa.agent.id);
  const tasks = req.atoa.db.delegations.filter(task => canAccessDelegation(task, req.atoa.agent.id));
  res.json({
    agent: publicAgent(req.atoa.agent),
    stats: {
      accepted_contributions: contributions.filter(change => change.status === 'accepted').length,
      rejected_contributions: contributions.filter(change => change.status === 'rejected').length,
      delegated_tasks: tasks.length,
      active_tasks: tasks.filter(task => ACTIVE_DELEGATION_STATUSES.has(task.status)).length,
      queued_tasks: tasks.filter(task => task.status === 'queued').length
    }
  });
});

app.post('/api/v1/delegations', authRequired, (req, res, next) => {
  const project = cloudProject(cleanText(req.body?.project_id, 64));
  const objective = cleanText(req.body?.objective, 2000);
  const suppliedCriteria = Array.isArray(req.body?.acceptance_criteria)
    ? req.body.acceptance_criteria.map(item => cleanText(item, 300)).filter(Boolean).slice(0, 12)
    : [];
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  if (!canAccessProject(project, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'cloud_project_not_found' });
  }
  if (!objective) return res.status(400).json({ error: 'objective_required' });
  if (!project.test_file && !project.validationCommands?.length) {
    return res.status(409).json({
      error: 'project_validation_not_ready',
      project_id: project.id,
      source: { type: project.sourceType, label: project.sourceLabel },
      coordinator_message: 'ATOA 已直接管理该 Program Project，但项目尚无权威固定测试，因此不会创建一个无法安全验收和合并的任务。'
    });
  }
  const acceptanceCriteria = suppliedCriteria.length ? suppliedCriteria : [
    `实现任务目标：${objective}`,
    '保持现有项目固定测试通过',
    '不引入越界文件修改或危险能力'
  ];
  const contractConflicts = delegationContractConflicts(objective, acceptanceCriteria);
  if (contractConflicts.length) {
    return res.status(422).json({
      error: 'delegation_contract_conflict',
      conflicts: contractConflicts,
      policy: DELEGATION_POLICY,
      data_boundary: DELEGATION_DATA_BOUNDARY,
      coordinator_message: 'ATOA 服务端控制平面在创建任务前检测到验收条件与项目策略冲突，未创建任务。'
    });
  }
  withCloudChangeLock(() => {
    const now = new Date().toISOString();
    const task = {
      id: genId('task'),
      protocol: 'atoa-delegation/v1',
      project_id: project.id,
      project_name: project.name,
      objective,
      acceptance_criteria: acceptanceCriteria,
      policy: DELEGATION_POLICY,
      data_boundary: DELEGATION_DATA_BOUNDARY,
      status: 'queued',
      base_revision: null,
      coordinator: { id: 'atoa-server-control-plane', name: 'ATOA Server Control Plane', role: 'orchestrator' },
      requested_by: { id: req.atoa.agent.id, name: req.atoa.agent.name || 'ATOA Agent' },
      target_agent_id: req.atoa.agent.id,
      assignee: null,
      permissions: {
        read: [],
        write: []
      },
      context_version: 0,
      context_paths: [],
      skill_paths: [],
      source_snapshot: [],
      usage: {
        task_request_bytes: jsonBytes(req.body),
        api_calls: 1
      },
      attempts: 0,
      latest_feedback: null,
      result: null,
      final_revision: null,
      events: [
        delegationEvent(
          'queue',
          'atoa-server-control-plane',
          'ATOA 服务端已完成任务合约预检并将任务加入项目队列'
        )
      ],
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString()
    };
    const db = readDB();
    db.delegations.unshift(task);
    db.delegations = db.delegations.slice(0, 500);
    dispatchCompatibleQueuedDelegations(db, project.id);
    writeDB(db);
    const dispatched = task.status === 'dispatched';
    return {
      status: 201,
      body: {
        task: publicDelegation(task),
        next_action: dispatched ? 'claim' : 'wait_for_dispatch',
        coordinator_message: dispatched
          ? '任务的源码 Context 与当前执行任务不重叠，已同步派发；客户端 Agent 领取后完成实现。'
          : `任务所需源码 Context 与执行中任务重叠；本任务暂列第 ${task.queue_position} 位，相关占用释放后会自动派发。`
      }
    };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.get('/api/v1/delegations', authRequired, (req, res) => {
  const requestedStatus = cleanText(req.query.status, 40);
  const tasks = readDB().delegations
    .filter(task => canAccessDelegation(task, req.atoa.agent.id))
    .filter(task => !requestedStatus || task.status === requestedStatus)
    .slice(0, 50)
    .map(task => publicDelegation(task, { includeEvents: false }));
  res.json({ tasks, total: tasks.length, protocol: 'atoa-delegation/v1' });
});

app.get('/api/v1/delegations/:taskId', authRequired, (req, res) => {
  const task = findDelegation(readDB(), req.params.taskId);
  if (!task || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found' });
  }
  res.json({ task: publicDelegation(task) });
});

app.get('/api/v1/delegations/:taskId/usage', authRequired, (req, res) => {
  const task = findDelegation(readDB(), req.params.taskId);
  if (!task || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found' });
  }
  res.json({ task_id: task.id, status: task.status, usage: delegationUsage(task) });
});

app.post('/api/v1/delegations/:taskId/worker-reservations', authRequired, (req, res, next) => {
  const workerId = cleanText(req.body?.worker_id, 100);
  if (!/^worker_[a-zA-Z0-9_-]{8,90}$/.test(workerId)) {
    return res.status(400).json({ error: 'valid_worker_id_required' });
  }
  withCloudChangeLock(() => {
    const db = readDB();
    const task = findDelegation(db, req.params.taskId);
    if (!task || task.target_agent_id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
      return { status: 404, body: { error: 'delegation_not_found_or_not_targeted' } };
    }
    if (task.status !== 'dispatched' || task.assignee) {
      return {
        status: 409,
        body: { error: 'delegation_not_reservable', status: task.status }
      };
    }
    const existing = activeWorkerReservation(task);
    if (existing && existing.worker_id !== workerId) {
      return {
        status: 409,
        body: { error: 'delegation_reserved_by_another_worker', retry_after_ms: 5000 }
      };
    }
    const now = new Date();
    const reservation = existing || {
      id: genId('lease'),
      worker_id: workerId,
      created_at: now.toISOString()
    };
    reservation.expires_at = new Date(now.getTime() + 90_000).toISOString();
    task.worker_reservation = reservation;
    task.updated_at = now.toISOString();
    addDelegationUsage(task, 'worker_request_bytes', jsonBytes(req.body));
    task.usage.worker_reservations = (task.usage.worker_reservations || 0) + (existing ? 0 : 1);
    if (!existing) {
      task.events.push(delegationEvent(
        'worker_reserve',
        req.atoa.agent.id,
        '客户端按需 Worker 已为派发任务取得短期启动租约',
        { worker_id: workerId, expires_at: reservation.expires_at }
      ));
    }
    const body = {
      task_id: task.id,
      worker_id: workerId,
      lease_id: reservation.id,
      lease_expires_at: reservation.expires_at,
      replayed: Boolean(existing)
    };
    addDelegationUsage(task, 'worker_response_bytes_sent', jsonBytes(body), false);
    writeDB(db);
    return {
      status: existing ? 200 : 201,
      body
    };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.post('/api/v1/delegations/:taskId/claim', authRequired, (req, res) => {
  const db = readDB();
  const task = findDelegation(db, req.params.taskId);
  if (!task || task.target_agent_id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found_or_not_targeted' });
  }
  if (task.assignee && task.assignee.id !== req.atoa.agent.id) {
    return res.status(409).json({ error: 'delegation_already_claimed' });
  }
  if (task.status === 'queued') {
    return res.status(409).json({
      error: 'delegation_queued',
      status: task.status,
      queue_position: task.queue_position,
      next_action: 'wait_for_dispatch',
      coordinator_message: '项目当前已有执行中的任务；请等待服务端基于最新 revision 派发此任务。'
    });
  }
  const reservation = activeWorkerReservation(task);
  if (task.worker_reservation && !reservation) delete task.worker_reservation;
  if (reservation) {
    const workerId = cleanText(req.body?.worker_id, 100);
    const leaseId = cleanText(req.body?.lease_id, 100);
    if (workerId !== reservation.worker_id || leaseId !== reservation.id) {
      return res.status(409).json({
        error: 'delegation_worker_reservation_required',
        status: task.status,
        lease_expires_at: reservation.expires_at
      });
    }
  }
  if (!['dispatched', 'in_progress', 'revision_requested'].includes(task.status)) {
    return res.status(409).json({ error: 'delegation_not_claimable', status: task.status });
  }
  task.assignee = { id: req.atoa.agent.id, name: req.atoa.agent.name || 'ATOA Agent', role: 'client-sub-agent' };
  if (task.status === 'dispatched') task.status = 'in_progress';
  delete task.worker_reservation;
  task.updated_at = new Date().toISOString();
  task.events.push(delegationEvent('claim', req.atoa.agent.id, '客户端 Agent 已领取服务端委派任务'));
  const context = delegationContextManifest(task);
  const manifestBytes = jsonBytes(context);
  addDelegationUsage(task, 'context_bytes_sent', manifestBytes);
  task.usage.context_manifest_bytes_sent = (task.usage.context_manifest_bytes_sent || 0) + manifestBytes;
  task.usage.context_deliveries += 1;
  writeDB(db);
  res.json({
    task: publicDelegation(task),
    coordinator_message: '你现在是该任务的客户端 Agent。请先用本地只读缓存解析源码与项目 Skill；缺失内容按哈希下载，Context 不足时再请求补充。'
  });
});

app.post('/api/v1/delegations/:taskId/context-content', authRequired, (req, res) => {
  const db = readDB();
  const task = findDelegation(db, req.params.taskId);
  if (!task || task.assignee?.id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found_or_not_assigned' });
  }
  if (!['in_progress', 'revision_requested', 'accepted'].includes(task.status)) {
    return res.status(409).json({ error: 'delegation_context_unavailable', status: task.status });
  }
  const reports = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!reports.length || reports.length > 20) {
    return res.status(400).json({ error: 'context_cache_report_required_or_too_large' });
  }
  const seen = new Set();
  const resolved = [];
  for (const report of reports) {
    const file = cleanText(report?.path, 300);
    const hash = cleanText(report?.hash, 128);
    const source = task.source_snapshot.find(item => item.path === file);
    const allowedPaths = new Set([...(task.context_paths || []), ...(task.skill_paths || [])]);
    if (seen.has(file)
      || !allowedPaths.has(file)
      || !source
      || source.hash !== hash
      || typeof report?.cached !== 'boolean') {
      return res.status(400).json({ error: 'invalid_context_cache_report', path: file });
    }
    seen.add(file);
    resolved.push({ source, cached: report.cached });
  }
  const downloaded = resolved.filter(item => !item.cached).map(item => item.source);
  const downloadedFiles = downloaded.filter(item => item.kind !== 'skill');
  const downloadedSkills = downloaded.filter(item => item.kind === 'skill');
  const hits = resolved.length - downloaded.length;
  const misses = downloaded.length;
  const avoidedBytes = resolved
    .filter(item => item.cached)
    .reduce((sum, item) => sum + item.source.bytes, 0);
  const contentBytes = downloaded.reduce((sum, item) => sum + item.bytes, 0);
  const payload = {
    version: task.context_version,
    files: downloadedFiles,
    skills: downloadedSkills,
    cache: {
      hits,
      misses,
      avoided_bytes: avoidedBytes,
      downloaded_bytes: contentBytes
    }
  };
  addDelegationUsage(task, 'context_cache_report_bytes', jsonBytes(req.body));
  addDelegationUsage(task, 'context_bytes_sent', jsonBytes(payload), false);
  task.usage.context_content_bytes_sent = (task.usage.context_content_bytes_sent || 0) + contentBytes;
  task.usage.context_resolutions = (task.usage.context_resolutions || 0) + 1;
  task.usage.context_cache_hits = (task.usage.context_cache_hits || 0) + hits;
  task.usage.context_cache_misses = (task.usage.context_cache_misses || 0) + misses;
  task.usage.context_bytes_avoided = (task.usage.context_bytes_avoided || 0) + avoidedBytes;
  task.updated_at = new Date().toISOString();
  writeDB(db);
  res.json({
    task_id: task.id,
    context: payload,
    usage: delegationUsage(task)
  });
});

app.post('/api/v1/delegations/:taskId/context-requests', authRequired, (req, res) => {
  const db = readDB();
  const task = findDelegation(db, req.params.taskId);
  if (!task || task.assignee?.id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found_or_not_assigned' });
  }
  if (!['in_progress', 'revision_requested'].includes(task.status)) {
    return res.status(409).json({ error: 'delegation_not_active', status: task.status });
  }
  const reason = cleanText(req.body?.reason, 1000);
  const paths = Array.isArray(req.body?.paths)
    ? req.body.paths.map(item => cleanText(item, 300)).filter(Boolean).slice(0, 20)
    : [];
  const query = cleanText(req.body?.query, 1000);
  const project = cloudProject(task.project_id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  const requested = paths.filter(file => task.permissions.read.includes(file));
  const candidates = selectContextPaths(project, task.source_snapshot, query || reason || task.objective, requested);
  const additions = candidates.filter(file => !task.context_paths.includes(file)).slice(0, 10);
  const activePeers = db.delegations.filter(item =>
    item.id !== task.id
      && item.project_id === task.project_id
      && ACTIVE_DELEGATION_STATUSES.has(item.status)
  );
  const conflicts = activePeers.flatMap(item => delegationContextOverlap(additions, item.context_paths));
  if (conflicts.length) {
    return res.status(409).json({
      error: 'delegation_context_overlap',
      conflicting_paths: [...new Set(conflicts)],
      coordinator_message: '请求的增量 Context 正被同步任务占用；本次请求未添加任何文件。'
    });
  }
  const skillCandidates = selectSkillPaths(
    project,
    task.source_snapshot,
    [task.objective, reason, query].filter(Boolean).join('\n'),
    requested
  );
  const skillAdditions = skillCandidates.filter(file => !(task.skill_paths || []).includes(file)).slice(0, 6);
  task.context_paths.push(...additions);
  task.permissions.write.push(...additions.filter(file =>
    project.editableFiles.includes(file) && !task.permissions.write.includes(file)
  ));
  task.skill_paths ||= [];
  task.skill_paths.push(...skillAdditions);
  task.context_version += 1;
  task.updated_at = new Date().toISOString();
  addDelegationUsage(task, 'context_request_bytes', jsonBytes(req.body));
  const addedContext = {
    version: task.context_version,
    files: delegationManifestEntries(task, additions),
    skills: delegationManifestEntries(task, skillAdditions),
    total_files: task.context_paths.length,
    total_skills: task.skill_paths.length
  };
  const manifestBytes = jsonBytes(addedContext);
  addDelegationUsage(task, 'context_bytes_sent', manifestBytes, false);
  task.usage.context_manifest_bytes_sent = (task.usage.context_manifest_bytes_sent || 0) + manifestBytes;
  task.usage.context_deliveries += 1;
  task.events.push(delegationEvent(
    'context_response',
    'atoa-server-control-plane',
    additions.length || skillAdditions.length
      ? `ATOA 服务端按固定规则补充了 ${additions.length} 个源码文件和 ${skillAdditions.length} 个项目 Skill`
      : 'ATOA 服务端按固定规则未发现新的相关文件或 Skill',
    {
      reason,
      query,
      requested_paths: paths,
      added_paths: additions,
      added_skills: skillAdditions,
      context_version: task.context_version
    }
  ));
  writeDB(db);
  res.json({
    task_id: task.id,
    project_id: task.project_id,
    context: addedContext,
    added_paths: additions,
    added_skills: skillAdditions,
    usage: delegationUsage(task),
    coordinator_message: additions.length || skillAdditions.length
      ? '已追加相关源码或项目 Skill。请继续执行任务。'
      : '没有发现新的相关文件或 Skill；如仍受阻，请提供更具体的符号、路径或失败信息。'
  });
});

app.post('/api/v1/delegations/:taskId/progress', authRequired, (req, res) => {
  const db = readDB();
  const task = findDelegation(db, req.params.taskId);
  if (!task || task.assignee?.id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'delegation_not_found_or_not_assigned' });
  }
  if (!['in_progress', 'revision_requested'].includes(task.status)) {
    return res.status(409).json({ error: 'delegation_not_active', status: task.status });
  }
  const message = cleanText(req.body?.message, 1000);
  if (!message) return res.status(400).json({ error: 'progress_message_required' });
  task.updated_at = new Date().toISOString();
  addDelegationUsage(task, 'progress_bytes', jsonBytes(req.body));
  task.events.push(delegationEvent('progress', req.atoa.agent.id, message));
  writeDB(db);
  res.json({ recorded: true, task_id: task.id, status: task.status });
});

app.post('/api/v1/delegations/:taskId/cancel', authRequired, (req, res, next) => {
  const reason = cleanText(req.body?.reason, 1000);
  if (!reason) return res.status(400).json({ error: 'cancellation_reason_required' });
  withCloudChangeLock(() => {
    const db = readDB();
    const task = findDelegation(db, req.params.taskId);
    if (!task || !canAccessDelegation(task, req.atoa.agent.id)) {
      return { status: 404, body: { error: 'delegation_not_found' } };
    }
    if (!['queued', 'dispatched', 'in_progress', 'revision_requested'].includes(task.status)) {
      return { status: 409, body: { error: 'delegation_not_cancellable', status: task.status } };
    }
    task.status = 'cancelled';
    delete task.queue_position;
    delete task.waiting_reason;
    delete task.candidate_cache;
    delete task.worker_reservation;
    task.latest_feedback = { reason: 'cancelled', message: reason };
    task.updated_at = new Date().toISOString();
    addDelegationUsage(task, 'progress_bytes', jsonBytes(req.body));
    task.events.push(delegationEvent('cancel', req.atoa.agent.id, reason));
    const dispatched = dispatchCompatibleQueuedDelegations(db, task.project_id);
    writeDB(db);
    return {
      status: 200,
      body: {
        task: publicDelegation(task),
        cancelled: true,
        ...(() => {
          const visible = dispatched.filter(item => canAccessDelegation(item, req.atoa.agent.id));
          return visible.length ? {
            dispatched_task_id: visible[0].id,
            dispatched_task_ids: visible.map(item => item.id)
          } : {};
        })()
      }
    };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.post('/api/v1/delegations/:taskId/results', authRequired, async (req, res) => {
  const baseRevision = cleanText(req.body?.base_revision, 80);
  const message = cleanText(req.body?.message, 500);
  const summary = cleanText(req.body?.summary, 2000);
  const reuseCandidate = req.body?.reuse_candidate === true;
  const suppliedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
  const suppliedOperations = Array.isArray(req.body?.operations) ? req.body.operations : [];
  const evidence = req.body?.evidence && typeof req.body.evidence === 'object'
    ? JSON.parse(JSON.stringify(req.body.evidence))
    : {};
  if (!baseRevision
    || (!reuseCandidate && (!message || !summary || (!suppliedFiles.length && !suppliedOperations.length)))) {
    return res.status(400).json({ error: 'base_revision_message_summary_and_candidate_required' });
  }
  try {
    const result = await withCloudChangeLock(async () => {
      const db = readDB();
      const task = findDelegation(db, req.params.taskId);
      if (!task || task.assignee?.id !== req.atoa.agent.id || !canAccessDelegation(task, req.atoa.agent.id)) {
        return { status: 404, body: { error: 'delegation_not_found_or_not_assigned' } };
      }
      if (task.status === 'accepted') {
        return {
          status: 200,
          body: {
            task: publicDelegation(task),
            replayed: true,
            coordinator_message: '该客户端结果已经通过 ATOA 服务端固定验证并合并。'
          }
        };
      }
      if (!['in_progress', 'revision_requested'].includes(task.status)) {
        return { status: 409, body: { error: 'delegation_not_active', current_status: task.status } };
      }
      addDelegationUsage(task, 'candidate_bytes_received', jsonBytes(req.body));
      task.usage.result_submissions += 1;
      const project = cloudProject(task.project_id);
      if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
      const currentRevision = cloudRevision(project);
      if (baseRevision !== task.base_revision) {
        task.status = 'revision_requested';
        task.latest_feedback = {
          reason: 'base_revision_conflict',
          message: '主项目在任务执行期间已经更新，请基于最新 revision 重新派发任务。',
          current_revision: currentRevision
        };
        task.updated_at = new Date().toISOString();
        task.events.push(delegationEvent(
          'revision_request',
          'atoa-server-control-plane',
          task.latest_feedback.message,
          task.latest_feedback
        ));
        writeDB(db);
        return {
          status: 409,
          body: {
            error: 'delegation_revision_conflict',
            task: publicDelegation(task),
            coordinator_message: task.latest_feedback.message
          }
        };
      }
      let resultMessage = message;
      let resultSummary = summary;
      let resultEvidence = evidence;
      let materialized;
      if (reuseCandidate) {
        if (task.status !== 'revision_requested' || !task.candidate_cache) {
          writeDB(db);
          return {
            status: 409,
            body: {
              error: 'delegation_candidate_not_reusable',
              coordinator_message: '只有处于 revision_requested 状态且已缓存候选的任务可以复用。'
            }
          };
        }
        resultMessage ||= task.candidate_cache.message;
        resultSummary ||= task.candidate_cache.summary;
        resultEvidence = Object.keys(evidence).length ? evidence : task.candidate_cache.evidence;
        materialized = {
          files: task.candidate_cache.files,
          operation_summary: task.candidate_cache.operation_summary
        };
        task.usage.candidate_reuses = (task.usage.candidate_reuses || 0) + 1;
        task.usage.candidate_bytes_avoided = (task.usage.candidate_bytes_avoided || 0)
          + (task.candidate_cache.upload_bytes || 0);
      } else {
        materialized = suppliedOperations.length
          ? materializeDelegationOperations(task, suppliedOperations)
          : { files: suppliedFiles, operation_summary: null };
      }
      if (materialized.error) {
        writeDB(db);
        return materialized.error;
      }
      const submittedFiles = materialized.files;
      const disallowed = submittedFiles
        .map(file => cleanText(file?.path, 300))
        .filter(file => !task.permissions.write.includes(file));
      if (disallowed.length) {
        return { status: 400, body: { error: 'delegation_write_scope_violation', paths: disallowed } };
      }
      if (currentRevision !== task.base_revision) {
        const changedTargets = submittedFiles
          .map(file => cleanText(file?.path, 300))
          .filter(file => {
            const source = task.source_snapshot.find(item => item.path === file);
            const current = cloudFile(project, file);
            return !source || current === null
              || createHash('sha256').update(current).digest('hex') !== source.hash;
          });
        if (changedTargets.length) {
          task.status = 'revision_requested';
          task.latest_feedback = {
            reason: 'target_file_revision_conflict',
            message: '并行贡献已经修改了本候选的目标文件，请基于最新 Context 重新派发任务。',
            current_revision: currentRevision,
            conflicting_paths: changedTargets
          };
          task.updated_at = new Date().toISOString();
          task.events.push(delegationEvent(
            'revision_request',
            'atoa-server-control-plane',
            task.latest_feedback.message,
            task.latest_feedback
          ));
          writeDB(db);
          return {
            status: 409,
            body: {
              error: 'delegation_revision_conflict',
              task: publicDelegation(task),
              coordinator_message: task.latest_feedback.message
            }
          };
        }
      }
      const prepared = prepareCloudChanges(project, submittedFiles);
      if (prepared.error) return prepared.error;
      if (!reuseCandidate) {
        task.candidate_cache = {
          id: genId('cand'),
          base_revision: baseRevision,
          files: submittedFiles,
          message: resultMessage,
          summary: resultSummary,
          evidence: resultEvidence,
          operation_summary: materialized.operation_summary,
          upload_bytes: jsonBytes(req.body),
          created_at: new Date().toISOString()
        };
      }
      const validation = await validateCloudChanges(project, prepared.changes);
      task.attempts += 1;
      task.result = {
        message: resultMessage,
        summary: resultSummary,
        files: cloudChangeFiles(prepared.changes),
        evidence: resultEvidence,
        operation_summary: materialized.operation_summary,
        candidate_id: task.candidate_cache.id,
        reused_candidate: reuseCandidate,
        validation,
        submitted_at: new Date().toISOString()
      };
      task.updated_at = new Date().toISOString();
      if (!validation.passed) {
        const failedChecks = validation.review.checks.filter(check => !check.passed).map(check => check.name);
        task.status = 'revision_requested';
        task.latest_feedback = {
          reason: 'validation_failed',
          message: validation.review.passed
            ? '候选实现未通过项目固定测试，请根据测试输出修订后重新提交。'
            : `候选实现未通过服务端安全规则扫描：${failedChecks.join('、') || '发现风险项'}。`,
          review: validation.review,
          tests: validation.tests
        };
        task.events.push(delegationEvent(
          'revision_request',
          'atoa-server-control-plane',
          task.latest_feedback.message,
          { attempt: task.attempts, review_passed: validation.review.passed, tests_passed: validation.tests.passed }
        ));
        addDelegationUsage(task, 'validation_bytes_sent', jsonBytes(validation), false);
        writeDB(db);
        return {
          status: 422,
          body: {
            task: publicDelegation(task),
            validation,
            candidate_id: task.candidate_cache.id,
            coordinator_message: task.latest_feedback.message,
            next_action: 'revise_or_reuse_candidate'
          }
        };
      }
      const audit = {
        id: genId('chg'),
        project_id: project.id,
        delegation_id: task.id,
        message: resultMessage,
        summary: resultSummary,
        status: 'accepted',
        author: { id: req.atoa.agent.id, name: req.atoa.agent.name || 'ATOA Agent' },
        base_revision: task.base_revision,
        revision: task.base_revision,
        files: cloudChangeFiles(prepared.changes),
        review: validation.review,
        tests: validation.tests,
        request_hash: createHash('sha256').update(`${task.id}\0${task.attempts}\0${resultMessage}`).digest('hex'),
        created_at: new Date().toISOString()
      };
      const backups = new Map(prepared.changes.map(change => [change.path, change.before]));
      try {
        for (const change of prepared.changes) fs.writeFileSync(path.join(project.dir, change.path), change.after);
        audit.revision = cloudRevision(project);
        audit.demo = createRunnableDemo(project, audit.revision, audit.id);
      } catch (error) {
        for (const [file, content] of backups) fs.writeFileSync(path.join(project.dir, file), content);
        throw error;
      }
      task.status = 'accepted';
      task.final_revision = audit.revision;
      task.latest_feedback = {
        reason: 'accepted',
        message: '客户端 Agent 的候选结果已通过服务端规则扫描、固定测试和原子合并。',
        contribution_id: audit.id
      };
      task.events.push(delegationEvent(
        'accept',
        'atoa-server-control-plane',
        task.latest_feedback.message,
        { attempt: task.attempts, contribution_id: audit.id, revision: audit.revision }
      ));
      delete task.candidate_cache;
      delete task.worker_reservation;
      addDelegationUsage(task, 'validation_bytes_sent', jsonBytes(validation), false);
      db.cloud_changes.unshift(audit);
      db.cloud_changes = db.cloud_changes.slice(0, 1000);
      const dispatched = dispatchCompatibleQueuedDelegations(db, task.project_id);
      writeDB(db);
      return {
        status: 201,
        body: {
          task: publicDelegation(task),
          change: publicChange(audit),
          validation,
          coordinator_message: task.latest_feedback.message,
          ...(() => {
            const visible = dispatched.filter(item => canAccessDelegation(item, req.atoa.agent.id));
            return visible.length ? {
              dispatched_task_id: visible[0].id,
              dispatched_task_ids: visible.map(item => item.id)
            } : {};
          })(),
          preview_url: `${requestOrigin(req)}${audit.demo?.path || `/cloud-apps/${project.id}/`}`
        }
      };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[atoa-delegation-result]', error);
    res.status(500).json({ error: 'delegation_result_failed', message: error.message });
  }
});

app.get('/api/v1/cloud/projects', authRequired, (req, res) => {
  res.json({
    projects: accessibleProjects(req.atoa.agent.id)
      .map(project => publicCloudProject(project, requestOrigin(req), req.atoa.agent.id)),
    protocol: 'atoa-cloud/v1'
  });
});

app.post('/api/v1/cloud/projects', authRequired, (req, res, next) => {
  const projectId = cleanText(req.body?.id, 64).toLowerCase();
  const name = cleanText(req.body?.name, 120);
  const description = cleanText(req.body?.description, 2000);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(projectId)) {
    return res.status(400).json({ error: 'valid_project_id_required' });
  }
  if (name.length < 3 || description.length < 20) {
    return res.status(400).json({ error: 'project_name_and_description_required' });
  }
  withCloudChangeLock(async () => {
    if (cloudProject(projectId)) {
      return { status: 409, body: { error: 'cloud_project_already_exists' } };
    }
    const ownedCount = listCloudProjects().filter(project =>
      project.sourceType === 'managed_project' && project.owner_agent_id === req.atoa.agent.id
    ).length;
    if (ownedCount >= 20) {
      return { status: 409, body: { error: 'managed_project_limit_reached', limit: 20 } };
    }
    let project;
    try {
      project = scaffoldManagedProject(projectId, name, description, req.atoa.agent.id);
      if (!project) throw new Error('managed_project_scaffold_failed');
      const validation = await testCloudProject(project);
      if (!validation.passed) {
        fs.rmSync(project.dir, { recursive: true, force: true });
        return { status: 500, body: { error: 'managed_project_initial_validation_failed', validation } };
      }
      return {
        status: 201,
        body: {
          project: publicCloudProject(project, requestOrigin(req), req.atoa.agent.id),
          validation,
          owner: true,
          next_action: 'add_skill_or_create_delegation'
        }
      };
    } catch (error) {
      if (project?.dir) fs.rmSync(project.dir, { recursive: true, force: true });
      throw error;
    }
  }).then(result => res.status(result.status).json(result.body), next);
});

app.post('/api/v1/cloud/projects/:projectId/skills', authRequired, (req, res, next) => {
  const skillId = cleanText(req.body?.id, 64).toLowerCase();
  const name = cleanText(req.body?.name, 120);
  const description = cleanText(req.body?.description, 500);
  const instructions = cleanText(req.body?.instructions, 32_000);
  const triggers = Array.isArray(req.body?.triggers)
    ? req.body.triggers.map(value => cleanText(value, 80)).filter(Boolean).slice(0, 30)
    : [];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(skillId)) {
    return res.status(400).json({ error: 'valid_skill_id_required' });
  }
  if (name.length < 2 || description.length < 10 || instructions.length < 20) {
    return res.status(400).json({ error: 'skill_name_description_and_instructions_required' });
  }
  withCloudChangeLock(() => {
    const project = cloudProject(req.params.projectId);
    if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
    if (!canAccessProject(project, req.atoa.agent.id)) {
      return { status: 404, body: { error: 'cloud_project_not_found' } };
    }
    if (project.sourceType !== 'managed_project' || project.owner_agent_id !== req.atoa.agent.id) {
      return { status: 403, body: { error: 'project_owner_required' } };
    }
    if (project.skills.length >= 20) {
      return { status: 409, body: { error: 'project_skill_limit_reached', limit: 20 } };
    }
    if (project.skills.some(skill => skill.id === skillId)) {
      return { status: 409, body: { error: 'project_skill_already_exists' } };
    }
    const skillFile = `skills/${skillId}/SKILL.md`;
    const skillDir = path.join(project.dir, 'skills', skillId);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const manifestPath = path.join(project.dir, 'project.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestBefore);
    const entry = { id: skillId, name, description, file: skillFile, triggers };
    const skillContent = `---\nname: ${skillId}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${instructions}\n`;
    const manifestTemp = `${manifestPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillPath, skillContent, { flag: 'wx' });
      manifest.skills = [...(manifest.skills || []), entry];
      fs.writeFileSync(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.renameSync(manifestTemp, manifestPath);
      const updated = cloudProject(project.id);
      if (!updated?.skills.some(skill => skill.id === skillId)) throw new Error('project_skill_reload_failed');
      return {
        status: 201,
        body: {
          project_id: project.id,
          skill: updated.skills.find(skill => skill.id === skillId),
          skills: updated.skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description })),
          next_action: 'create_delegation'
        }
      };
    } catch (error) {
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(manifestTemp, { force: true }); } catch {}
      try { fs.writeFileSync(manifestPath, manifestBefore); } catch {}
      throw error;
    }
  }).then(result => res.status(result.status).json(result.body), next);
});

function managedProjectOwner(project, agentId) {
  return project?.sourceType === 'managed_project' && project.owner_agent_id === agentId;
}

function writeProjectMembership(project, memberIds) {
  const manifestPath = path.join(project.dir, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.member_agent_ids = [...new Set(memberIds)].filter(id => id && id !== manifest.owner_agent_id).slice(0, 50);
  const temp = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temp, manifestPath);
}

app.get('/api/v1/cloud/projects/:projectId/members', authRequired, (req, res) => {
  const project = cloudProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  if (!canAccessProject(project, req.atoa.agent.id)) {
    return res.status(404).json({ error: 'cloud_project_not_found' });
  }
  if (!managedProjectOwner(project, req.atoa.agent.id)) {
    return res.status(403).json({ error: 'project_owner_required' });
  }
  const db = readDB();
  const owner = db.agents.find(agent => agent.id === project.owner_agent_id);
  const members = (project.member_agent_ids || [])
    .map(id => db.agents.find(agent => agent.id === id))
    .filter(Boolean)
    .map(publicAgent);
  res.json({ project_id: project.id, owner: publicAgent(owner), members, limit: 50 });
});

app.post('/api/v1/cloud/projects/:projectId/members', authRequired, (req, res, next) => {
  const email = cleanText(req.body?.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid_member_email_required' });
  }
  withCloudChangeLock(() => {
    const project = cloudProject(req.params.projectId);
    if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
    if (!canAccessProject(project, req.atoa.agent.id)) {
      return { status: 404, body: { error: 'cloud_project_not_found' } };
    }
    if (!managedProjectOwner(project, req.atoa.agent.id)) {
      return { status: 403, body: { error: 'project_owner_required' } };
    }
    const db = readDB();
    const member = db.agents.find(agent => agent.email === email);
    if (!member) return { status: 404, body: { error: 'registered_member_not_found' } };
    if (member.id === project.owner_agent_id) {
      return { status: 409, body: { error: 'project_owner_is_already_member' } };
    }
    const memberIds = project.member_agent_ids || [];
    if (memberIds.includes(member.id)) {
      return { status: 200, body: { project_id: project.id, member: publicAgent(member), replayed: true } };
    }
    if (memberIds.length >= 50) return { status: 409, body: { error: 'project_member_limit_reached', limit: 50 } };
    writeProjectMembership(project, [...memberIds, member.id]);
    return { status: 201, body: { project_id: project.id, member: publicAgent(member), role: 'member' } };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.delete('/api/v1/cloud/projects/:projectId/members/:memberId', authRequired, (req, res, next) => {
  withCloudChangeLock(() => {
    const project = cloudProject(req.params.projectId);
    if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
    if (!canAccessProject(project, req.atoa.agent.id)) {
      return { status: 404, body: { error: 'cloud_project_not_found' } };
    }
    if (!managedProjectOwner(project, req.atoa.agent.id)) {
      return { status: 403, body: { error: 'project_owner_required' } };
    }
    const memberId = cleanText(req.params.memberId, 100);
    const memberIds = project.member_agent_ids || [];
    if (!memberIds.includes(memberId)) return { status: 404, body: { error: 'project_member_not_found' } };
    writeProjectMembership(project, memberIds.filter(id => id !== memberId));
    const db = readDB();
    for (const task of db.delegations) {
      if (task.project_id !== project.id || !ACTIVE_DELEGATION_STATUSES.has(task.status)) continue;
      if (![task.requested_by?.id, task.target_agent_id, task.assignee?.id].includes(memberId)) continue;
      task.status = 'cancelled';
      delete task.queue_position;
      delete task.worker_reservation;
      task.latest_feedback = { reason: 'project_access_revoked', message: '项目成员权限已被所有者撤销，任务已取消。' };
      task.updated_at = new Date().toISOString();
      task.events.push(delegationEvent('cancel', req.atoa.agent.id, task.latest_feedback.message));
    }
    dispatchCompatibleQueuedDelegations(db, project.id);
    writeDB(db);
    return { status: 200, body: { project_id: project.id, member_id: memberId, removed: true } };
  }).then(result => res.status(result.status).json(result.body), next);
});

app.get('/api/v1/cloud/projects/:projectId', authRequired, (req, res) => {
  const project = projectForAgent(req.params.projectId, req.atoa.agent.id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  res.json({ project: publicCloudProject(project, requestOrigin(req), req.atoa.agent.id) });
});

app.get('/api/v1/cloud/projects/:projectId/files', authRequired, (req, res) => {
  const project = projectForAgent(req.params.projectId, req.atoa.agent.id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  const file = cleanText(req.query.path, 300);
  const content = cloudFile(project, file);
  if (content === null) return res.status(404).json({ error: 'cloud_file_not_editable_or_not_found' });
  res.json({ project_id: project.id, path: file, revision: cloudRevision(project), content });
});

app.get('/api/v1/cloud/projects/:projectId/changes', authRequired, (req, res) => {
  const project = projectForAgent(req.params.projectId, req.atoa.agent.id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const changes = readDB().cloud_changes
    .filter(change => change.project_id === project.id)
    .slice(0, limit)
    .map(publicChange);
  res.json({ project_id: project.id, revision: cloudRevision(project), changes });
});

app.post('/api/v1/cloud/projects/:projectId/test', authRequired, async (req, res) => {
  const project = projectForAgent(req.params.projectId, req.atoa.agent.id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  const result = await testCloudProject(project);
  res.status(result.passed ? 200 : 422).json({
    project_id: project.id,
    revision: cloudRevision(project),
    ...result
  });
});

app.post('/api/v1/cloud/projects/:projectId/validate', authRequired, async (req, res) => {
  const projectId = req.params.projectId;
  const baseRevision = cleanText(req.body?.base_revision, 80);
  const submittedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!baseRevision) return res.status(400).json({ error: 'base_revision_required' });
  try {
    const result = await withCloudChangeLock(async () => {
      const project = projectForAgent(projectId, req.atoa.agent.id);
      if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
      const currentRevision = cloudRevision(project);
      if (currentRevision !== baseRevision) {
        return { status: 409, body: { error: 'cloud_revision_conflict', current_revision: currentRevision } };
      }
      const prepared = prepareCloudChanges(project, submittedFiles);
      if (prepared.error) return prepared.error;
      const validation = await validateCloudChanges(project, prepared.changes);
      const files = cloudChangeFiles(prepared.changes);
      const validationId = createHash('sha256')
        .update(project.id).update('\0')
        .update(baseRevision).update('\0')
        .update(JSON.stringify(files))
        .digest('hex').slice(0, 16);
      return {
        status: validation.passed ? 200 : 422,
        body: {
          validation_id: `val_${validationId}`,
          project_id: project.id,
          base_revision: baseRevision,
          files,
          ...validation
        }
      };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[atoa-cloud-validate]', error);
    res.status(500).json({ error: 'cloud_validation_failed', message: error.message });
  }
});

app.post('/api/v1/cloud/projects/:projectId/changes', authRequired, async (req, res) => {
  const projectId = req.params.projectId;
  const baseRevision = cleanText(req.body?.base_revision, 80);
  const message = cleanText(req.body?.message, 300);
  const submittedFiles = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!baseRevision || !message || !submittedFiles.length) {
    return res.status(400).json({ error: 'base_revision_message_and_files_required' });
  }
  if (submittedFiles.length > 10) return res.status(400).json({ error: 'too_many_files' });
  try {
    const result = await withCloudChangeLock(async () => {
      const project = projectForAgent(projectId, req.atoa.agent.id);
      if (!project) return { status: 404, body: { error: 'cloud_project_not_found' } };
      const requestHash = cloudChangeRequestHash(req.atoa.agent.id, project.id, baseRevision, message, submittedFiles);
      const previous = readDB().cloud_changes.find(change => change.request_hash === requestHash);
      if (previous) {
        return {
          status: previous.status === 'accepted' ? 200 : 422,
          body: {
            change: publicChange(previous),
            replayed: true,
            preview_url: `${requestOrigin(req)}${previous.demo?.path || `/cloud-apps/${project.id}/`}`
          }
        };
      }
      const currentRevision = cloudRevision(project);
      if (currentRevision !== baseRevision) {
        return { status: 409, body: { error: 'cloud_revision_conflict', current_revision: currentRevision } };
      }
      const prepared = prepareCloudChanges(project, submittedFiles);
      if (prepared.error) return prepared.error;
      const changes = prepared.changes;
      const validation = await validateCloudChanges(project, changes);
      const audit = {
        id: genId('chg'),
        project_id: project.id,
        message,
        status: validation.passed ? 'accepted' : 'rejected',
        author: { id: req.atoa.agent.id, name: req.atoa.agent.name || 'ATOA Agent' },
        base_revision: baseRevision,
        revision: baseRevision,
        files: cloudChangeFiles(changes),
        review: validation.review,
        tests: validation.tests,
        request_hash: requestHash,
        created_at: new Date().toISOString()
      };
      if (!validation.passed) {
        recordCloudChange(audit);
        return {
          status: 422,
          body: { change: publicChange(audit), preview_url: `${requestOrigin(req)}/cloud-apps/${project.id}/` }
        };
      }
      const backups = new Map(changes.map(change => [change.path, change.before]));
      try {
        for (const change of changes) fs.writeFileSync(path.join(project.dir, change.path), change.after);
        audit.revision = cloudRevision(project);
        audit.demo = createRunnableDemo(project, audit.revision, audit.id);
      } catch (error) {
        for (const [file, content] of backups) fs.writeFileSync(path.join(project.dir, file), content);
        throw error;
      }
      recordCloudChange(audit);
      return {
        status: 201,
        body: { change: publicChange(audit), preview_url: `${requestOrigin(req)}${audit.demo?.path || `/cloud-apps/${project.id}/`}` }
      };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[atoa-cloud-change]', error);
    res.status(500).json({ error: 'cloud_change_failed', message: error.message });
  }
});

app.get('/api/cloud-projects', authRequired, (req, res) => {
  const query = cleanText(req.query.q, 100).toLowerCase();
  const db = readDB();
  const projects = accessibleProjects(req.atoa.agent.id)
    .filter(project => !query || `${project.id} ${project.name} ${project.description}`.toLowerCase().includes(query))
    .map(project => {
      const changes = db.cloud_changes.filter(change => change.project_id === project.id);
      const accepted = changes.filter(change => change.status === 'accepted');
      return {
        ...publicCloudProject(project, requestOrigin(req), req.atoa.agent.id),
        accepted_changes: accepted.length,
        runnable_demos: accepted.filter(change => change.demo?.path).length,
        last_change: accepted[0] ? publicChangeSummary(accepted[0]) : null,
        recent_changes: changes.slice(0, 2).map(publicChangeSummary)
      };
    });
  res.json({ projects, total: projects.length, category: 'cocreation' });
});

app.get('/api/cloud-projects/:projectId', authRequired, (req, res) => {
  const project = projectForAgent(req.params.projectId, req.atoa.agent.id);
  if (!project) return res.status(404).json({ error: 'cloud_project_not_found' });
  const db = readDB();
  const changes = db.cloud_changes.filter(change => change.project_id === project.id);
  const accepted = changes.filter(change => change.status === 'accepted');
  const rejected = changes.filter(change => change.status === 'rejected');
  const delegations = db.delegations
    .filter(task => task.project_id === project.id)
    .slice(0, 20)
    .map(task => ({
      id: task.id,
      display_intent: 'Private co-creation task (raw prompt not public)',
      prompt_visibility: 'participants-only',
      status: task.status,
      queue_position: task.queue_position || null,
      coordinator: task.coordinator,
      assignee: task.assignee,
      context_version: task.context_version,
      context_files: task.context_paths.length,
      attempts: task.attempts,
      usage: delegationUsage(task),
      latest_feedback: task.latest_feedback?.message || null,
      final_revision: task.final_revision,
      created_at: task.created_at,
      updated_at: task.updated_at
    }));
  res.json({
    project: {
      ...publicCloudProject(project, requestOrigin(req), req.atoa.agent.id),
      contributions: {
        total: changes.length,
        accepted: accepted.length,
        runnable: accepted.filter(change => change.demo?.path).length,
        rejected: rejected.length,
        contributors: new Set(changes.map(change => change.author?.id).filter(Boolean)).size
      },
      delegations: {
        total: delegations.length,
        active: delegations.filter(task => ACTIVE_DELEGATION_STATUSES.has(task.status)).length,
        queued: delegations.filter(task => task.status === 'queued').length
      }
    },
    changes: changes.slice(0, 50).map(publicChange),
    delegations
  });
});

app.get('/api/stats', authRequired, (req, res) => {
  const db = readDB();
  const projectIds = new Set(accessibleProjects(req.atoa.agent.id).map(project => project.id));
  const changes = db.cloud_changes.filter(change => projectIds.has(change.project_id));
  const delegations = db.delegations.filter(task => projectIds.has(task.project_id));
  res.json({
    projects: projectIds.size,
    contributors: new Set(changes.map(change => change.author?.id).filter(Boolean)).size,
    accepted_contributions: changes.filter(change => change.status === 'accepted').length,
    runnable_demo_versions: changes.filter(change => change.status === 'accepted' && change.demo?.path).length,
    delegated_tasks: delegations.length,
    active_delegations: delegations.filter(task => ACTIVE_DELEGATION_STATUSES.has(task.status)).length,
    queued_delegations: delegations.filter(task => task.status === 'queued').length
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

backfillCurrentRunnableDemos();

const server = app.listen(PORT, () => {
  console.log(`ATOA Collaborative Coding running on :${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(error => {
    try { persistence.close(); } catch {}
    clearTimeout(timeout);
    if (error) {
      console.error(`ATOA shutdown failed after ${signal}:`, error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
