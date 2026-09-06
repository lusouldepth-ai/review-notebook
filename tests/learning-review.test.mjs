import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeynmanReviewPoints,
  migrateFeynmanNotesToReviewTasks,
  normalizeReviewPoints,
  resolveFeynmanMastery,
  resolveFeynmanReviewStatus,
  upsertFeynmanReviewTask
} from '../web/src/learning-review.js';
import { createEmptyState } from '../web/src/storage.js';

const NOW = new Date('2026-09-06T05:00:00.000Z');

function stateWithChild() {
  return {
    ...createEmptyState(),
    children: [{ id: 'c1', userId: 'u1', name: '学生', grade: '四年级' }]
  };
}

test('score thresholds map to mastery and review status', () => {
  assert.equal(resolveFeynmanMastery(59), '不懂');
  assert.equal(resolveFeynmanMastery(60), '不熟');
  assert.equal(resolveFeynmanMastery(85), '能讲清');
  assert.equal(resolveFeynmanReviewStatus(84), '需再次复习');
  assert.equal(resolveFeynmanReviewStatus(85), '已掌握');
});

test('low score turns unclear and unfamiliar feedback into review points', () => {
  const points = buildFeynmanReviewPoints({
    unclear: ['没有说清楚运算顺序', '没有说清楚运算顺序'],
    unfamiliar: ['小括号和中括号的先后顺序']
  }, 62);

  assert.deepEqual(points, ['没有说清楚运算顺序', '小括号和中括号的先后顺序']);
  assert.deepEqual(normalizeReviewPoints('第一点；第二点\n第一点'), ['第一点', '第二点']);
  assert.deepEqual(buildFeynmanReviewPoints({ unclear: ['不应保留'] }, 90), []);
});

test('low score creates a child-scoped Feynman task in the review queue', () => {
  const result = upsertFeynmanReviewTask(stateWithChild(), 'u1', {
    childId: 'c1',
    subject: '语文',
    topic: '观潮',
    explanation: '潮水很壮观。',
    score: 45,
    unclear: '没有讲清潮来时的变化',
    unfamiliar: '课文顺序',
    teachBetter: '先讲潮来前，再讲潮来时和潮去后。',
    followUpQuestion: '课文按什么顺序写？',
    reviewPoints: ['讲清潮来前、潮来时和潮去后的顺序'],
    evidence: [{ filename: '语文四年级上册.pdf', page: 2, excerpt: '钱塘江大潮，自古以来被称为天下奇观。' }]
  }, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.status, '需再次复习');
  assert.equal(result.task.childId, 'c1');
  assert.equal(result.task.textbookEvidence[0].page, 2);
  assert.deepEqual(result.task.reviewPoints, ['讲清潮来前、潮来时和潮去后的顺序']);
  assert.equal(result.state.learningReviews.length, 1);
  assert.equal(result.state.mistakes.length, 0);
});

test('a later high score updates the same lesson task to mastered', () => {
  const first = upsertFeynmanReviewTask(stateWithChild(), 'u1', {
    childId: 'c1', subject: '数学', topic: '大数的读写', score: 40
  }, NOW);
  const second = upsertFeynmanReviewTask(first.state, 'u1', {
    childId: 'c1',
    subject: '数学',
    topic: '大数的读写',
    explanation: '从高位起一级一级读。',
    score: 91,
    reviewPoints: ['高分时不应继续保留'],
    teachBetter: '先分级，再从最高级读起。'
  }, new Date('2026-09-07T05:00:00.000Z'));

  assert.equal(second.ok, true);
  assert.equal(second.isNew, false);
  assert.equal(second.status, '已掌握');
  assert.equal(second.state.learningReviews.length, 1);
  assert.equal(second.task.id, first.task.id);
  assert.deepEqual(second.task.reviewPoints, []);
});

test('existing Feynman notes migrate to the latest child-scoped review status', () => {
  const state = {
    ...stateWithChild(),
    feynmanNotes: [
      {
        id: 'n1', userId: 'u1', childId: 'c1', subject: '数学', concept: '大数的读写',
        explainSimply: '第一次讲解', aiScore: 40, updatedAt: '2026-09-05T05:00:00.000Z'
      },
      {
        id: 'n2', userId: 'u1', childId: 'c1', subject: '数学', concept: '大数的读写',
        explainSimply: '第二次已经讲清楚', aiScore: 90, updatedAt: '2026-09-06T05:00:00.000Z'
      }
    ]
  };

  const migrated = migrateFeynmanNotesToReviewTasks(state);

  assert.equal(migrated.learningReviews.length, 1);
  assert.equal(migrated.learningReviews[0].explanation, '第二次已经讲清楚');
  assert.equal(migrated.learningReviews[0].aiScore, 90);
  assert.equal(migrated.learningReviews[0].status, '已掌握');
  assert.deepEqual(migrated.learningReviews[0].reviewPoints, []);
});

test('legacy pending tasks gain review points from saved feedback', () => {
  const state = {
    ...stateWithChild(),
    learningReviews: [{
      id: 'r1', userId: 'u1', childId: 'c1', subject: '语文', topic: '观潮',
      aiScore: 45, status: '需再次复习', unclear: '没有讲清时间顺序', unfamiliar: '生字读音'
    }]
  };

  const migrated = migrateFeynmanNotesToReviewTasks(state);

  assert.deepEqual(migrated.learningReviews[0].reviewPoints, [
    '没有讲清时间顺序',
    '生字读音'
  ]);
});
