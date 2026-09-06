import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loginLocalAccount,
  saveLocalAccountState
} from '../web/src/account-state-client.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('loginLocalAccount sends account state to the local login endpoint', async () => {
  let request;
  const result = await loginLocalAccount(
    { identifier: 'parent@example.com', accountState: { users: [] } },
    async (url, options) => {
      request = { url, options };
      return jsonResponse({ ok: true, accountState: { users: [] }, revision: 1 });
    }
  );

  assert.equal(request.url, '/api/account/login');
  assert.equal(request.options.method, 'POST');
  assert.equal(JSON.parse(request.options.body).identifier, 'parent@example.com');
  assert.equal(result.revision, 1);
});

test('saveLocalAccountState uses the local state endpoint', async () => {
  let url;
  await saveLocalAccountState(
    { identifier: 'parent@example.com', accountState: { users: [] } },
    async (requestUrl) => {
      url = requestUrl;
      return jsonResponse({ ok: true, revision: 2 });
    }
  );
  assert.equal(url, '/api/account/state');
});
