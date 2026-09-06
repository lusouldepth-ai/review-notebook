import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAccountState,
  mergeAccountState,
  validateAccountState
} from '../web/src/account-state.js';
import { createEmptyState } from '../web/src/storage.js';

function buildState() {
  return {
    ...createEmptyState(),
    users: [
      { id: 'u1', method: 'email', identifier: 'one@example.com', displayName: '一号家长' },
      { id: 'u2', method: 'email', identifier: 'two@example.com', displayName: '二号家长' }
    ],
    children: [
      { id: 'c1', userId: 'u1', name: '孩子一' },
      { id: 'c2', userId: 'u2', name: '孩子二' }
    ],
    mistakes: [
      { id: 'm1', userId: 'u1', childId: 'c1' },
      { id: 'm2', userId: 'u2', childId: 'c2' }
    ],
    feynmanNotes: [{ id: 'f1', userId: 'u1', childId: 'c1' }],
    reminder: { enabled: true },
    currentUserId: 'u1',
    currentChildId: 'c1'
  };
}

test('extractAccountState only includes the selected account records', () => {
  const account = extractAccountState(buildState(), 'u1');
  assert.deepEqual(account.users.map((item) => item.id), ['u1']);
  assert.deepEqual(account.children.map((item) => item.id), ['c1']);
  assert.deepEqual(account.mistakes.map((item) => item.id), ['m1']);
  assert.deepEqual(account.feynmanNotes.map((item) => item.id), ['f1']);
  assert.equal(account.currentChildId, 'c1');
});

test('mergeAccountState replaces one login while preserving other local accounts', () => {
  const local = buildState();
  const incoming = {
    ...createEmptyState(),
    users: [
      { id: 'server-u1', method: 'email', identifier: 'one@example.com', displayName: '一号家长' }
    ],
    children: [{ id: 'server-c1', userId: 'server-u1', name: '恢复的孩子' }],
    mistakes: [{ id: 'server-m1', userId: 'server-u1', childId: 'server-c1' }],
    currentUserId: 'server-u1',
    currentChildId: 'server-c1'
  };

  const merged = mergeAccountState(local, incoming);
  assert.deepEqual(merged.users.map((item) => item.id).sort(), ['server-u1', 'u2']);
  assert.deepEqual(merged.children.map((item) => item.id).sort(), ['c2', 'server-c1']);
  assert.deepEqual(merged.mistakes.map((item) => item.id).sort(), ['m2', 'server-m1']);
  assert.equal(merged.currentUserId, 'server-u1');
  assert.equal(merged.currentChildId, 'server-c1');
});

test('validateAccountState rejects records belonging to another account', () => {
  const account = extractAccountState(buildState(), 'u1');
  account.mistakes.push({ id: 'foreign', userId: 'u2', childId: 'c2' });
  const result = validateAccountState(account, {
    method: 'email',
    identifier: 'one@example.com'
  });
  assert.equal(result.ok, false);
});
