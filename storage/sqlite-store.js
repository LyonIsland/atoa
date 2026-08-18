const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const Database = require('better-sqlite3');

const COLLECTIONS = Object.freeze([
  { key: 'agents', table: 'agents' },
  { key: 'sessions', table: 'sessions' },
  { key: 'cloud_changes', table: 'cloud_changes' },
  { key: 'delegations', table: 'delegations' }
]);

function emptyState() {
  return { agents: [], sessions: [], cloud_changes: [], delegations: [] };
}

function normalizedState(value, source = 'database') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_atoa_state:${source}`);
  }
  const state = emptyState();
  for (const { key } of COLLECTIONS) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) throw new Error(`invalid_atoa_collection:${source}:${key}`);
    state[key] = value[key];
  }
  return state;
}

function validatedRecord(record, collection, position) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.id !== 'string' || !record.id) {
    throw new Error(`invalid_atoa_record:${collection}:${position}`);
  }
  if (collection === 'agents' && (typeof record.email !== 'string' || !record.email)) {
    throw new Error(`invalid_atoa_agent_email:${record.id}`);
  }
  if (collection === 'sessions' && (typeof record.agent_id !== 'string' || !record.agent_id)) {
    throw new Error(`invalid_atoa_session_agent:${record.id}`);
  }
  return record;
}

function createSqliteStore({ sqliteFile, legacyJsonFile = '', log = () => {} }) {
  const resolvedSqliteFile = path.resolve(sqliteFile);
  fs.mkdirSync(path.dirname(resolvedSqliteFile), { recursive: true, mode: 0o700 });
  const database = new Database(resolvedSqliteFile);
  try { fs.chmodSync(resolvedSqliteFile, 0o600); } catch {}

  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const currentVersion = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
  if (currentVersion > 1) {
    database.close();
    throw new Error(`atoa_database_schema_too_new:${currentVersion}`);
  }
  if (currentVersion < 1) {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          position INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          position INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        );
        CREATE TABLE cloud_changes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          position INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        );
        CREATE TABLE delegations (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          position INTEGER NOT NULL,
          payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
        );
        CREATE TABLE legacy_imports (
          source_path TEXT PRIMARY KEY,
          source_sha256 TEXT NOT NULL,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX sessions_agent_id_idx ON sessions(agent_id);
        CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
        CREATE INDEX cloud_changes_project_status_idx ON cloud_changes(project_id, status, created_at DESC);
        CREATE INDEX delegations_project_status_idx ON delegations(project_id, status, created_at DESC);
        CREATE INDEX delegations_updated_at_idx ON delegations(updated_at DESC);
      `);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString());
    })();
  }

  const integrity = database.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') {
    database.close();
    throw new Error(`atoa_database_integrity_failed:${integrity}`);
  }

  const selectStatements = Object.fromEntries(COLLECTIONS.map(({ key, table }) => [
    key,
    database.prepare(`SELECT payload_json FROM ${table} ORDER BY position ASC`)
  ]));
  const insertStatements = {
    agents: database.prepare(`
      INSERT INTO agents (id, email, created_at, updated_at, position, payload_json)
      VALUES (@id, @email, @created_at, @updated_at, @position, @payload_json)
    `),
    sessions: database.prepare(`
      INSERT INTO sessions (id, agent_id, token_hash, expires_at, position, payload_json)
      VALUES (@id, @agent_id, @token_hash, @expires_at, @position, @payload_json)
    `),
    cloud_changes: database.prepare(`
      INSERT INTO cloud_changes (id, project_id, status, created_at, position, payload_json)
      VALUES (@id, @project_id, @status, @created_at, @position, @payload_json)
    `),
    delegations: database.prepare(`
      INSERT INTO delegations (id, project_id, status, created_at, updated_at, position, payload_json)
      VALUES (@id, @project_id, @status, @created_at, @updated_at, @position, @payload_json)
    `)
  };

  function read() {
    const state = emptyState();
    for (const { key } of COLLECTIONS) {
      state[key] = selectStatements[key].all().map((row, position) => {
        let record;
        try { record = JSON.parse(row.payload_json); }
        catch { throw new Error(`invalid_atoa_sqlite_payload:${key}:${position}`); }
        return validatedRecord(record, key, position);
      });
    }
    return state;
  }

  const replaceAll = database.transaction(value => {
    const state = normalizedState(value, 'write');
    database.exec('DELETE FROM sessions; DELETE FROM cloud_changes; DELETE FROM delegations; DELETE FROM agents;');
    for (const [position, item] of state.agents.entries()) {
      const record = validatedRecord(item, 'agents', position);
      insertStatements.agents.run({
        id: record.id,
        email: record.email,
        created_at: record.created_at || '',
        updated_at: record.updated_at || record.created_at || '',
        position,
        payload_json: JSON.stringify(record)
      });
    }
    for (const [position, item] of state.sessions.entries()) {
      const record = validatedRecord(item, 'sessions', position);
      insertStatements.sessions.run({
        id: record.id,
        agent_id: record.agent_id,
        token_hash: record.token_hash || '',
        expires_at: record.expires_at || '',
        position,
        payload_json: JSON.stringify(record)
      });
    }
    for (const [position, item] of state.cloud_changes.entries()) {
      const record = validatedRecord(item, 'cloud_changes', position);
      insertStatements.cloud_changes.run({
        id: record.id,
        project_id: record.project_id || '',
        status: record.status || '',
        created_at: record.created_at || '',
        position,
        payload_json: JSON.stringify(record)
      });
    }
    for (const [position, item] of state.delegations.entries()) {
      const record = validatedRecord(item, 'delegations', position);
      insertStatements.delegations.run({
        id: record.id,
        project_id: record.project_id || '',
        status: record.status || '',
        created_at: record.created_at || '',
        updated_at: record.updated_at || record.created_at || '',
        position,
        payload_json: JSON.stringify(record)
      });
    }
  });

  function write(value) {
    replaceAll(value);
  }

  const resolvedLegacyFile = legacyJsonFile ? path.resolve(legacyJsonFile) : '';
  if (resolvedLegacyFile && resolvedLegacyFile !== resolvedSqliteFile && fs.existsSync(resolvedLegacyFile)) {
    const imported = database.prepare('SELECT 1 FROM legacy_imports WHERE source_path = ?').get(resolvedLegacyFile);
    const rowCount = COLLECTIONS.reduce((total, { table }) =>
      total + database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    if (!imported && rowCount === 0) {
      const source = fs.readFileSync(resolvedLegacyFile, 'utf8');
      let legacy;
      try { legacy = normalizedState(JSON.parse(source), resolvedLegacyFile); }
      catch (error) {
        database.close();
        throw new Error(`legacy_atoa_database_invalid:${resolvedLegacyFile}:${error.message}`);
      }
      database.transaction(() => {
        replaceAll(legacy);
        database.prepare('INSERT INTO legacy_imports (source_path, source_sha256, imported_at) VALUES (?, ?, ?)')
          .run(resolvedLegacyFile, createHash('sha256').update(source).digest('hex'), new Date().toISOString());
      })();
      log(`Imported legacy ATOA JSON data from ${resolvedLegacyFile} into SQLite.`);
    }
  }

  return {
    file: resolvedSqliteFile,
    engine: 'sqlite',
    schemaVersion: 1,
    read,
    write,
    close: () => database.close()
  };
}

module.exports = { createSqliteStore, emptyState, normalizedState };
