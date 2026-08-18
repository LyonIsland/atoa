import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqliteStore from '../storage/sqlite-store.js';

const { createSqliteStore } = sqliteStore;

function fixtureState() {
  return {
    agents: [{
      id: 'agt_legacy',
      email: 'legacy@example.invalid',
      name: 'Legacy user',
      password_salt: '0'.repeat(32),
      password_hash: '1'.repeat(128),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }],
    sessions: [{
      id: 'ses_legacy',
      agent_id: 'agt_legacy',
      token_hash: '2'.repeat(64),
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2027-01-01T00:00:00.000Z'
    }],
    cloud_changes: [{
      id: 'chg_legacy',
      project_id: 'courseplanner',
      status: 'accepted',
      created_at: '2026-01-01T00:00:00.000Z'
    }],
    delegations: [{
      id: 'tsk_legacy',
      project_id: 'courseplanner',
      status: 'accepted',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z'
    }]
  };
}

test('SQLite store imports legacy JSON once and persists all collections across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atoa-sqlite-store-'));
  try {
    const legacyFile = path.join(root, 'atoa-data.json');
    const sqliteFile = path.join(root, 'atoa.sqlite');
    const fixture = fixtureState();
    fs.writeFileSync(legacyFile, JSON.stringify(fixture));

    const first = createSqliteStore({ sqliteFile, legacyJsonFile: legacyFile });
    assert.deepEqual(first.read(), fixture);
    const updated = first.read();
    updated.agents[0].name = 'Updated after migration';
    first.write(updated);
    first.close();

    fs.writeFileSync(legacyFile, JSON.stringify(fixtureState()));
    const reopened = createSqliteStore({ sqliteFile, legacyJsonFile: legacyFile });
    assert.equal(reopened.read().agents[0].name, 'Updated after migration');
    reopened.close();

    assert.equal(fs.statSync(sqliteFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${sqliteFile}-wal`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite store refuses malformed legacy JSON instead of silently creating empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atoa-sqlite-invalid-'));
  try {
    const legacyFile = path.join(root, 'atoa-data.json');
    fs.writeFileSync(legacyFile, '{not valid JSON');
    assert.throws(
      () => createSqliteStore({ sqliteFile: path.join(root, 'atoa.sqlite'), legacyJsonFile: legacyFile }),
      /legacy_atoa_database_invalid/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
