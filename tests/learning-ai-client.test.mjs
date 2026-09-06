import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateFeynmanExplanation,
  listTextbooks,
  uploadTextbook
} from '../web/src/learning-ai-client.js';

test('listTextbooks scopes request by user, child, and grade', async () => {
  let requestedUrl = '';
  const items = await listTextbooks(
    { userId: 'u1', childId: 'c1', grade: '三年级' },
    async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ ok: true, textbooks: [{ id: 't1' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    }
  );
  assert.match(requestedUrl, /userId=u1/);
  assert.match(requestedUrl, /childId=c1/);
  assert.match(requestedUrl, /grade=%E4%B8%89%E5%B9%B4%E7%BA%A7/);
  assert.equal(items[0].id, 't1');
});

test('uploadTextbook posts raw file with encoded filename', async () => {
  let request = null;
  const file = new File(['教材内容'], '三年级数学.txt', { type: 'text/plain' });
  await uploadTextbook(
    { userId: 'u1', childId: 'c1', subject: '数学', grade: '三年级', file },
    async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true, textbook: { id: 't1' } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  );
  assert.equal(request.options.method, 'POST');
  assert.equal(decodeURIComponent(request.options.headers['X-File-Name']), '三年级数学.txt');
});

test('evaluateFeynmanExplanation surfaces backend errors', async () => {
  await assert.rejects(
    () => evaluateFeynmanExplanation({ topic: '分数' }, async () => new Response(
      JSON.stringify({ ok: false, error: '请选择教材' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )),
    /请选择教材/
  );
});
