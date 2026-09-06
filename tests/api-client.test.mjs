import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_SERVICE_UNAVAILABLE_MESSAGE,
  requestJson
} from '../web/src/api-client.js';

test('requestJson translates network failures into a local-service message', async () => {
  await assert.rejects(
    () => requestJson('/api/test', {}, {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      }
    }),
    new RegExp(LOCAL_SERVICE_UNAVAILABLE_MESSAGE)
  );
});

test('requestJson preserves readable backend errors', async () => {
  await assert.rejects(
    () => requestJson('/api/test', {}, {
      fetchImpl: async () => new Response(
        JSON.stringify({ ok: false, error: '教材处理失败。' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }),
    /教材处理失败/
  );
});
