import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTextbookStore,
  inferTextbookMetadataFromFilename,
  MIN_TEXTBOOK_RELEVANCE_SCORE,
  rankRelevantPassages,
  selectRelevantPassages,
  validateTextbookUpload
} from '../server/textbook-store.mjs';

test('validateTextbookUpload rejects unsupported files', () => {
  assert.equal(validateTextbookUpload({ filename: 'book.docx', buffer: Buffer.from('x') }).ok, false);
  assert.equal(validateTextbookUpload({ filename: 'book.pdf', buffer: Buffer.alloc(0) }).ok, false);
});

test('inferTextbookMetadataFromFilename ignores the English starting-grade label', () => {
  assert.deepEqual(
    inferTextbookMetadataFromFilename(
      '义务教育教科书·英语（PEP）（三年级起点）六年级上册.pdf',
      '英语'
    ),
    { subject: '英语', grade: '六年级', semester: '上册' }
  );
});

test('textbook store persists extracted text without exposing local paths', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-notebook-textbooks-'));
  const store = createTextbookStore({ rootDir });
  const created = await store.create({
    userId: 'u1',
    childId: 'c1',
    subject: '数学',
    grade: '三年级',
    filename: '三年级数学.txt',
    buffer: Buffer.from('分数表示整体的一部分。把一个整体平均分成若干份，其中的一份或几份可以用分数表示。')
  });

  assert.equal(created.ok, true);
  assert.equal('filePath' in created.textbook, false);
  const list = await store.list({ userId: 'u1', childId: 'c1' });
  assert.equal(list.length, 1);
  const loaded = await store.getWithText({ id: created.textbook.id, userId: 'u1', childId: 'c1' });
  assert.match(loaded.text, /平均分/);
  await fs.rm(rootDir, { recursive: true, force: true });
});

test('selectRelevantPassages favors content matching the lesson topic', () => {
  const text = [
    '第一课是认识方向。东南西北可以帮助我们描述位置。',
    '第二课认识分数。把一个整体平均分成若干份，其中一份可以用分数表示。',
    '第三课学习长度单位。厘米和米用于测量长度。'
  ].join('\f');
  const selected = selectRelevantPassages(text, '分数 平均分 分母', 1);
  assert.equal(selected[0].page, 2);
});

test('rankRelevantPassages distinguishes reliable matches from missing topics', () => {
  const text = [
    '认识方向。东南西北可以帮助我们描述位置。',
    '认识分数。把一个整体平均分成若干份，其中一份可以用分数表示。'
  ].join('\f');
  const matched = rankRelevantPassages(text, '分数 平均分', 2);
  const missing = rankRelevantPassages(text, '光合作用 叶绿体', 2);

  assert.ok(matched[0].score >= MIN_TEXTBOOK_RELEVANCE_SCORE);
  assert.equal(missing[0].score, 0);
});

test('system textbooks are available by grade without exposing source paths', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-notebook-system-books-'));
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-notebook-source-books-'));
  const sourcePath = path.join(sourceDir, '三年级数学上册.txt');
  await fs.writeFile(sourcePath, '认识分数。把一个整体平均分成若干份，其中一份可以用分数表示。');
  const store = createTextbookStore({ rootDir });

  const imported = await store.importSystemFile({
    subject: '数学',
    grade: '三年级',
    semester: '上册',
    sourcePath
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.textbook.builtIn, true);
  assert.equal('sourcePath' in imported.textbook, false);

  const matching = await store.list({ userId: 'u1', childId: 'c1', grade: '三年级' });
  const otherGrade = await store.list({ userId: 'u1', childId: 'c1', grade: '四年级' });
  assert.equal(matching.length, 1);
  assert.equal(otherGrade.length, 0);

  const candidates = await store.listWithText({
    userId: 'u1',
    childId: 'c1',
    grade: '三年级',
    subject: '数学'
  });
  assert.match(candidates[0].text, /平均分/);
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.rm(sourceDir, { recursive: true, force: true });
});
