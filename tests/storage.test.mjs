import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_STATE_CORRUPT_KEY,
  APP_STATE_KEY,
  APP_STATE_RECOVERY_KEY,
  createEmptyState,
  loadAppState,
  normalizeState,
  saveAppState
} from '../web/src/storage.js';

function createFakeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
    dump() {
      return map;
    },
    setItem(key, value) {
      map.set(key, value);
    }
  };
}

test('createEmptyState returns required top-level fields', () => {
  const value = createEmptyState();
  assert.deepEqual(Object.keys(value).sort(), [
    'auditLogs',
    'autoExport',
    'children',
    'currentChildId',
    'currentUserId',
    'exports',
    'feynmanNotes',
    'learningReviews',
    'mistakes',
    'reminder',
    'reviewAttempts',
    'reviewSessions',
    'users',
    'weakPointViews'
  ]);
});

test('normalizeState falls back to empty fields when shape is invalid', () => {
  const normalized = normalizeState({ users: 'wrong', currentUserId: 123 });
  assert.deepEqual(normalized.users, []);
  assert.deepEqual(normalized.reviewSessions, []);
  assert.deepEqual(normalized.reviewAttempts, []);
  assert.deepEqual(normalized.feynmanNotes, []);
  assert.deepEqual(normalized.learningReviews, []);
  assert.deepEqual(normalized.weakPointViews, []);
  assert.equal(normalized.currentUserId, null);
});

test('saveAppState and loadAppState preserve normalized value', () => {
  const storage = createFakeStorage();
  const saved = saveAppState(
    {
      users: [{ id: 'u1' }],
      children: 'bad',
      mistakes: [],
      exports: [],
      reminder: { enabled: true },
      autoExport: { enabled: true, cycle: 'week' },
      currentUserId: 'u1',
      currentChildId: 'c1'
    },
    storage
  );

  assert.equal(saved.children.length, 0);
  const loaded = loadAppState(storage);
  assert.deepEqual(loaded.users, [{ id: 'u1' }]);
  assert.equal(loaded.currentUserId, 'u1');
  assert.equal(loaded.currentChildId, 'c1');
  assert.equal(loaded.autoExport?.enabled, true);
  assert.ok(storage.getItem(APP_STATE_KEY));
});

test('loadAppState returns empty state on invalid JSON', () => {
  const storage = createFakeStorage();
  storage.setItem(APP_STATE_KEY, '{not json');
  const loaded = loadAppState(storage);
  assert.deepEqual(loaded, createEmptyState());
  assert.equal(storage.getItem(APP_STATE_CORRUPT_KEY), '{not json');
});

test('saveAppState stores previous valid state as local recovery copy', () => {
  const storage = createFakeStorage();
  const firstState = {
    ...createEmptyState(),
    users: [{ id: 'u1' }],
    children: [{ id: 'c1' }],
    mistakes: [{ id: 'm1', question: 'old' }]
  };
  saveAppState(firstState, storage);

  const secondState = {
    ...firstState,
    mistakes: [{ id: 'm2', question: 'new' }]
  };
  saveAppState(secondState, storage);

  const recovery = JSON.parse(storage.getItem(APP_STATE_RECOVERY_KEY));
  assert.deepEqual(recovery.mistakes, [{ id: 'm1', question: 'old' }]);
});

test('loadAppState recovers from last valid local copy when primary state is corrupted', () => {
  const storage = createFakeStorage();
  storage.setItem(APP_STATE_KEY, '{not json');
  storage.setItem(
    APP_STATE_RECOVERY_KEY,
    JSON.stringify({
      ...createEmptyState(),
      users: [{ id: 'u1' }],
      mistakes: [{ id: 'm1' }]
    })
  );

  const loaded = loadAppState(storage);
  assert.deepEqual(loaded.users, [{ id: 'u1' }]);
  assert.deepEqual(loaded.mistakes, [{ id: 'm1' }]);
  assert.equal(storage.getItem(APP_STATE_CORRUPT_KEY), '{not json');
});

test('loadAppState recovers from last valid local copy when primary state is missing', () => {
  const storage = createFakeStorage();
  storage.setItem(
    APP_STATE_RECOVERY_KEY,
    JSON.stringify({
      ...createEmptyState(),
      children: [{ id: 'c1' }],
      mistakes: [{ id: 'm1' }, { id: 'm2' }]
    })
  );

  const loaded = loadAppState(storage);
  assert.deepEqual(loaded.children, [{ id: 'c1' }]);
  assert.deepEqual(loaded.mistakes, [{ id: 'm1' }, { id: 'm2' }]);
});
