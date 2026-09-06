import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function accountKey(method, identifier) {
  return createHash('sha256').update(`${method}:${identifier}`).digest('hex');
}

function prepareForStorage(accountState) {
  const stored = structuredClone(accountState);
  if (stored.users?.[0]) {
    delete stored.users[0].identifier;
  }
  return stored;
}

function hydrateStoredState(accountState, { method, identifier }) {
  const hydrated = structuredClone(accountState);
  if (hydrated.users?.[0]) {
    hydrated.users[0].method = method;
    hydrated.users[0].identifier = identifier;
  }
  return hydrated;
}

export function createAccountStateStore({ dbPath }) {
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(dbPath);
  chmodSync(dbPath, 0o600);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS account_states (
      account_key TEXT PRIMARY KEY,
      login_method TEXT NOT NULL,
      state_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);

  const selectAccount = database.prepare(`
    SELECT state_json, revision, created_at, updated_at
    FROM account_states
    WHERE account_key = ? AND login_method = ?
  `);
  const insertAccount = database.prepare(`
    INSERT INTO account_states (
      account_key, login_method, state_json, revision, created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?)
  `);
  const updateAccount = database.prepare(`
    UPDATE account_states
    SET state_json = ?, revision = revision + 1, updated_at = ?
    WHERE account_key = ? AND login_method = ?
  `);

  function load({ method, identifier }) {
    const row = selectAccount.get(accountKey(method, identifier), method);
    if (!row) return null;
    return {
      state: hydrateStoredState(JSON.parse(row.state_json), { method, identifier }),
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function create({ method, identifier, state, now = new Date() }) {
    const timestamp = now.toISOString();
    insertAccount.run(
      accountKey(method, identifier),
      method,
      JSON.stringify(prepareForStorage(state)),
      timestamp,
      timestamp
    );
    return load({ method, identifier });
  }

  function save({ method, identifier, state, now = new Date() }) {
    const timestamp = now.toISOString();
    const result = updateAccount.run(
      JSON.stringify(prepareForStorage(state)),
      timestamp,
      accountKey(method, identifier),
      method
    );
    if (Number(result.changes) === 0) {
      return create({ method, identifier, state, now });
    }
    return load({ method, identifier });
  }

  return {
    load,
    create,
    save,
    close() {
      database.close();
    }
  };
}
