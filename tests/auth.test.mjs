import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAccountRestoreMessage,
  detectLoginMethod,
  listSavedLoginAccounts,
  loginWithLocalState,
  logoutWithLocalState,
  normalizeIdentifier,
  validateLoginInput
} from '../web/src/auth.js';
import { createEmptyState } from '../web/src/storage.js';

const TEST_PHONE = ['138', '0013', '8000'].join('');

test('detectLoginMethod supports CN phone and email', () => {
  assert.equal(detectLoginMethod(TEST_PHONE), 'phone');
  assert.equal(detectLoginMethod('Parent@Example.com'), 'email');
  assert.equal(detectLoginMethod('abc'), null);
});

test('normalizeIdentifier lowercases email only', () => {
  assert.equal(normalizeIdentifier(' Parent@Example.com '), 'parent@example.com');
  assert.equal(normalizeIdentifier(` ${TEST_PHONE} `), TEST_PHONE);
});

test('validateLoginInput rejects invalid input', () => {
  assert.equal(validateLoginInput({ identifier: '' }).ok, false);
  assert.equal(validateLoginInput({ identifier: '111222' }).ok, false);
  assert.equal(validateLoginInput({ identifier: TEST_PHONE }).ok, true);
  assert.equal(validateLoginInput({ identifier: 'student@example.com' }).ok, true);
});

test('loginWithLocalState creates and reuses user', () => {
  const now = new Date('2026-04-18T10:00:00.000Z');
  const initial = createEmptyState();

  const first = loginWithLocalState(initial, {
    identifier: TEST_PHONE,
    displayName: '妈妈'
  }, now);

  assert.equal(first.ok, true);
  assert.equal(first.state.users.length, 1);
  assert.equal(first.state.users[0].displayName, '妈妈');
  assert.equal(first.isNewUser, true);

  const second = loginWithLocalState(first.state, {
    identifier: TEST_PHONE,
    displayName: '妈妈-更新'
  }, new Date('2026-04-18T11:00:00.000Z'));

  assert.equal(second.ok, true);
  assert.equal(second.state.users.length, 1);
  assert.equal(second.isNewUser, false);
  assert.equal(second.state.users[0].displayName, '妈妈-更新');
});

test('listSavedLoginAccounts returns valid accounts with child and mistake counts', () => {
  const state = {
    ...createEmptyState(),
    users: [
      {
        id: 'u_old',
        displayName: '爸爸',
        method: 'phone',
        identifier: TEST_PHONE,
        createdAt: '2026-04-01T10:00:00.000Z'
      },
      {
        id: 'u_new',
        displayName: '妈妈',
        method: 'email',
        identifier: 'parent@example.com',
        updatedAt: '2026-04-02T10:00:00.000Z'
      },
      {
        id: 'bad',
        displayName: '坏数据',
        method: 'email',
        identifier: ''
      }
    ],
    children: [
      { id: 'c1', userId: 'u_new' },
      { id: 'c2', userId: 'u_old' },
      { id: 'c3', userId: 'u_new' }
    ],
    mistakes: [
      { id: 'm1', userId: 'u_new' },
      { id: 'm2', userId: 'u_old' },
      { id: 'm3', userId: 'u_new' }
    ]
  };

  const accounts = listSavedLoginAccounts(state);

  assert.deepEqual(
    accounts.map((account) => account.id),
    ['u_new', 'u_old']
  );
  assert.equal(accounts[0].identifier, 'parent@example.com');
  assert.equal(accounts[0].childCount, 2);
  assert.equal(accounts[0].mistakeCount, 2);
  assert.equal(accounts[1].childCount, 1);
  assert.equal(accounts[1].mistakeCount, 1);
});

test('buildAccountRestoreMessage distinguishes empty and restored accounts', () => {
  assert.match(
    buildAccountRestoreMessage({ prefix: '登录成功。', created: false, childCount: 0 }),
    /当前登录账号没有孩子档案/
  );
  assert.match(
    buildAccountRestoreMessage({ prefix: '登录成功。', created: false, childCount: 2 }),
    /恢复 2 个孩子及学习记录/
  );
  assert.match(
    buildAccountRestoreMessage({ prefix: '登录成功。', created: true, childCount: 0 }),
    /已建立对应的本地数据库/
  );
});

test('logoutWithLocalState clears current session only', () => {
  const state = {
    ...createEmptyState(),
    users: [{ id: 'u1', displayName: '家长', method: 'phone', identifier: TEST_PHONE }],
    currentUserId: 'u1'
  };

  const next = logoutWithLocalState(state);
  assert.equal(next.currentUserId, null);
  assert.equal(next.users.length, 1);
});
