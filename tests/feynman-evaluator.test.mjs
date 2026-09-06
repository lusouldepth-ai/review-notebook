import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFeynmanMessages,
  evaluateWithDeepSeek,
  normalizeFeynmanEvaluation
} from '../server/feynman-evaluator.mjs';

test('normalizeFeynmanEvaluation clamps scores and keeps actionable feedback', () => {
  const result = normalizeFeynmanEvaluation({
    totalScore: 108,
    dimensions: { accuracy: 90, completeness: 80, clarity: 70, teaching: -2 },
    unclear: ['没有解释分母表示什么'],
    unfamiliar: ['举例不稳定'],
    teachBetter: '先说整体，再说平均分成几份。',
    followUpQuestion: '为什么分母不能是零？'
  });

  assert.equal(result.totalScore, 100);
  assert.equal(result.dimensions.teaching, 0);
  assert.deepEqual(result.unclear, ['没有解释分母表示什么']);
});

test('buildFeynmanMessages labels textbook page evidence', () => {
  const messages = buildFeynmanMessages({
    grade: '三年级',
    subject: '数学',
    topic: '分数',
    explanation: '我认为分数表示一部分。',
    passages: [{ filename: '三年级数学上册.pdf', page: 12, text: '把一个整体平均分成若干份。' }]
  });

  assert.match(messages[0].content, /只输出 JSON/);
  assert.match(messages[1].content, /三年级数学上册\.pdf 第 12 页/);
  assert.match(messages[1].content, /孩子的讲解/);
});

test('buildFeynmanMessages explicitly marks general-knowledge fallback', () => {
  const messages = buildFeynmanMessages({
    grade: '一年级',
    subject: '英语',
    topic: 'greetings',
    explanation: 'Hello means 你好。',
    passages: [],
    sourceMode: 'general'
  });

  assert.match(messages[0].content, /未命中教材，按通用知识评估/);
  assert.match(messages[1].content, /没有检索到可靠的教材片段/);
  assert.doesNotMatch(messages[1].content, /本次检索到的教材片段/);
});

test('evaluateWithDeepSeek calls JSON output and returns normalized result', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      model: 'deepseek-v4-flash',
      choices: [{ message: { content: JSON.stringify({
        totalScore: 82,
        dimensions: { accuracy: 90, completeness: 80, clarity: 78, teaching: 80 },
        summary: '基本讲清楚了。',
        understood: ['知道分数表示部分与整体的关系'],
        unclear: ['没有说明平均分'],
        unfamiliar: ['分母的含义'],
        teachBetter: '先拿一个苹果举例。',
        followUpQuestion: '如果没有平均分，还能用分数表示吗？',
        evidence: ['教材第 12 页：平均分']
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await evaluateWithDeepSeek({
    apiKey: 'test-key-not-real',
    input: {
      grade: '三年级',
      subject: '数学',
      topic: '分数',
      explanation: '分数是一部分。',
      passages: [{ page: 12, text: '把一个整体平均分成若干份。' }]
    },
    fetchImpl
  });

  assert.equal(result.evaluation.totalScore, 82);
  assert.equal(result.usage.totalTokens, 160);
  const request = JSON.parse(calls[0].options.body);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key-not-real');
});

test('evaluateWithDeepSeek retries one empty JSON response', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const content =
      calls === 1
        ? ''
        : JSON.stringify({
            totalScore: 70,
            dimensions: { accuracy: 70, completeness: 70, clarity: 70, teaching: 70 }
          });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const result = await evaluateWithDeepSeek({
    apiKey: 'test-key-not-real',
    input: {
      grade: '三年级',
      subject: '数学',
      topic: '分数',
      explanation: '分数表示整体的一部分。',
      passages: []
    },
    fetchImpl
  });

  assert.equal(calls, 2);
  assert.equal(result.evaluation.totalScore, 70);
});
