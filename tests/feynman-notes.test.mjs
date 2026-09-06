import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createFeynmanNote,
  listFeynmanNotesForUser,
  normalizeFeynmanNoteInput,
  recordFeynmanReview
} from '../web/src/feynman-notes.js';
import { createEmptyState } from '../web/src/storage.js';

const NOW = new Date('2026-05-17T10:00:00.000Z');

test('normalizeFeynmanNoteInput requires a concept and keeps learning fields', () => {
  const invalid = normalizeFeynmanNoteInput({ concept: '' });
  assert.equal(invalid.ok, false);

  const valid = normalizeFeynmanNoteInput({
    childId: 'c1',
    subject: '数学',
    concept: '单位',
    explainSimply: '答案要带单位',
    teachBack: '如果讲给同学听，我会先问题目问什么',
    stuckPoint: '总忘记最后写单位',
    unfamiliarPoint: '应用题单位转换',
    example: '36支',
    relatedMistakeId: 'm1',
    reviewTaskId: 'm1',
    reviewStatus: '需再次复习',
    textbookEvidence: [
      { textbookId: 't1', filename: '数学三年级.pdf', page: 12, excerpt: '把一个整体平均分。' }
    ]
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.note.concept, '单位');
  assert.equal(valid.note.mastery, '不熟');
  assert.equal(valid.note.childId, 'c1');
  assert.equal(valid.note.reviewStatus, '需再次复习');
  assert.equal(valid.note.textbookEvidence[0].page, 12);
});

test('createFeynmanNote stores user note and links related mistake', () => {
  const result = createFeynmanNote(createEmptyState(), 'u1', {
    subject: '数学',
    concept: '单位',
    explainSimply: '答案要带单位',
    stuckPoint: '容易漏写',
    relatedMistakeId: 'm1'
  }, NOW);

  assert.equal(result.ok, true);
  assert.equal(result.state.feynmanNotes.length, 1);
  assert.equal(result.note.userId, 'u1');
  assert.equal(result.note.relatedMistakeId, 'm1');
});

test('recordFeynmanReview appends review process and can raise mastery', () => {
  const created = createFeynmanNote(createEmptyState(), 'u1', {
    subject: '数学',
    concept: '单位',
    explainSimply: '答案要带单位'
  }, NOW);

  const reviewed = recordFeynmanReview(created.state, 'u1', created.note.id, {
    reviewText: '今天能讲清为什么要写单位',
    mastery: '能讲清'
  }, new Date('2026-05-18T10:00:00.000Z'));

  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.note.mastery, '能讲清');
  assert.equal(reviewed.note.reviewLogs.length, 1);
});

test('listFeynmanNotesForUser sorts newest updated notes first', () => {
  let state = createEmptyState();
  state = createFeynmanNote(state, 'u1', {
    subject: '数学',
    concept: '单位',
    explainSimply: '答案要带单位'
  }, NOW).state;
  state = createFeynmanNote(state, 'u1', {
    subject: '语文',
    concept: '形近字',
    explainSimply: '看偏旁'
  }, new Date('2026-05-18T10:00:00.000Z')).state;

  const notes = listFeynmanNotesForUser(state, 'u1');
  assert.deepEqual(notes.map((note) => note.concept), ['形近字', '单位']);
});

test('listFeynmanNotesForUser can isolate notes by child', () => {
  let state = createEmptyState();
  state = createFeynmanNote(state, 'u1', {
    childId: 'c1',
    subject: '数学',
    concept: '分数',
    explainSimply: '分数表示整体的一部分'
  }, NOW).state;
  state = createFeynmanNote(state, 'u1', {
    childId: 'c2',
    subject: '语文',
    concept: '比喻句',
    explainSimply: '把一种事物比作另一种事物'
  }, new Date('2026-05-18T10:00:00.000Z')).state;

  const notes = listFeynmanNotesForUser(state, 'u1', { childId: 'c1' });
  assert.deepEqual(notes.map((note) => note.concept), ['分数']);
});
