import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccountStateStore } from '../server/account-state-store.mjs';
import { createEmptyState } from '../web/src/storage.js';

function accountState(childName = '孩子一') {
  return {
    ...createEmptyState(),
    users: [
      {
        id: 'u1',
        method: 'email',
        identifier: 'private-parent@example.com',
        displayName: '家长'
      }
    ],
    children: [{ id: 'c1', userId: 'u1', name: childName }],
    currentUserId: 'u1',
    currentChildId: 'c1'
  };
}

test('SQLite account store creates, restores, and updates an account', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-notebook-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = path.join(directory, 'account.sqlite');
  const store = createAccountStateStore({ dbPath });
  t.after(() => store.close());

  const created = store.create({
    method: 'email',
    identifier: 'private-parent@example.com',
    state: accountState()
  });
  assert.equal(created.revision, 1);
  assert.equal(created.state.children[0].name, '孩子一');
  assert.equal(created.state.users[0].identifier, 'private-parent@example.com');

  const updated = store.save({
    method: 'email',
    identifier: 'private-parent@example.com',
    state: accountState('孩子新名称')
  });
  assert.equal(updated.revision, 2);
  assert.equal(store.load({
    method: 'email',
    identifier: 'private-parent@example.com'
  }).state.children[0].name, '孩子新名称');

  const mode = (await stat(dbPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const bytes = await readFile(dbPath);
  assert.equal(bytes.includes(Buffer.from('private-parent@example.com')), false);
});
