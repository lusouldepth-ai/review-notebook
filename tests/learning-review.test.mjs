import test from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateFeynmanNotesToReviewTasks,
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
    evidence: [{ filename: '语文四年级上册.pdf', page: 2, excerpt: '钱塘江大潮，自古以来被称为天下奇观。' }]
  }, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.status, '需再次复习');
  assert.equal(result.task.childId, 'c1');
  assert.equal(result.task.textbookEvidence[0].page, 2);
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
    teachBetter: '先分级，再从最高级读起。'
  }, new Date('2026-09-07T05:00:00.000Z'));

  assert.equal(second.ok, true);
  assert.equal(second.isNew, false);
  assert.equal(second.status, '已掌握');
  assert.equal(second.state.learningReviews.length, 1);
  assert.equal(second.task.id, first.task.id);
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
});
