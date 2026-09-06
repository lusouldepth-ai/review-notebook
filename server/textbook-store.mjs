import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_TEXTBOOK_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.txt', '.md']);
export const MIN_TEXTBOOK_RELEVANCE_SCORE = 6;
const GRADE_SEMESTER_PATTERN = /(一年级|二年级|三年级|四年级|五年级|六年级)(上册|下册)/;

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function safeFileName(value) {
  return path.basename(String(value ?? 'textbook')).replace(/[\u0000-\u001f]/g, '').slice(0, 160);
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) !== -1) {
    count += 1;
    index += term.length;
  }
  return count;
}

function buildQueryTerms(query) {
  const normalized = cleanText(query).toLowerCase();
  const terms = normalized
    .split(/[\s，。！？、；：,.!?;:()（）\[\]【】]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{3,}/g) || [];
  chineseRuns.forEach((run) => {
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        terms.push(run.slice(index, index + size));
      }
    }
  });
  return [...new Set(terms)].slice(0, 160);
}

function publicTextbookRecord(record) {
  const { textPath, filePath, ...publicRecord } = record;
  void textPath;
  void filePath;
  return publicRecord;
}

export function inferTextbookMetadataFromFilename(filename, subject) {
  const match = safeFileName(filename).match(GRADE_SEMESTER_PATTERN);
  return {
    subject: cleanText(subject),
    grade: match?.[1] || '',
    semester: match?.[2] || ''
  };
}

export function validateTextbookUpload({ filename, buffer }) {
  const name = safeFileName(filename);
  const extension = path.extname(name).toLowerCase();
  if (!name || !ALLOWED_EXTENSIONS.has(extension)) {
    return { ok: false, error: '教材仅支持 PDF、TXT 或 Markdown 文件。' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: '教材文件为空。' };
  }
  if (buffer.length > MAX_TEXTBOOK_BYTES) {
    return { ok: false, error: '教材文件不能超过 25MB。' };
  }
  return { ok: true, filename: name, extension };
}

async function extractText(filePath, extension) {
  if (extension === '.txt' || extension === '.md') {
    return cleanText(await fs.readFile(filePath, 'utf8'));
  }

  try {
    const result = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 45_000
    });
    return cleanText(result.stdout);
  } catch (error) {
    const wrapped = new Error(
      error?.code === 'ENOENT'
        ? '本机缺少 pdftotext，暂时无法读取 PDF 教材。'
        : 'PDF 教材文字提取失败，请确认文件可正常打开且没有加密。'
    );
    wrapped.code = 'TEXTBOOK_EXTRACTION_FAILED';
    throw wrapped;
  }
}

export function splitTextbookIntoPassages(text, chunkSize = 1800) {
  const pages = String(text ?? '').split('\f');
  const passages = [];
  pages.forEach((rawPage, pageIndex) => {
    const pageText = cleanText(rawPage);
    if (!pageText) return;
    for (let offset = 0; offset < pageText.length; offset += chunkSize) {
      const chunk = pageText.slice(offset, offset + chunkSize).trim();
      if (chunk) {
        passages.push({ page: pageIndex + 1, text: chunk });
      }
    }
  });
  return passages;
}

export function rankRelevantPassages(text, query, limit = 6) {
  const passages = splitTextbookIntoPassages(text);
  const terms = buildQueryTerms(query);
  if (terms.length === 0) {
    return passages.slice(0, limit).map((passage) => ({ ...passage, score: 0 }));
  }

  return passages
    .map((passage, index) => {
      const haystack = passage.text.toLowerCase();
      const score = terms.reduce(
        (sum, term) => sum + countOccurrences(haystack, term) * Math.min(term.length, 6),
        0
      );
      return { ...passage, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ page, text: passageText, score }) => ({ page, text: passageText, score }));
}

export function selectRelevantPassages(text, query, limit = 6) {
  return rankRelevantPassages(text, query, limit)
    .sort((a, b) => a.page - b.page)
    .map(({ page, text: passageText }) => ({ page, text: passageText }));
}

export function createTextbookStore({ rootDir }) {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, 'index.json');

  async function ensureRoot() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }

  async function readIndex() {
    await ensureRoot();
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function writeIndex(records) {
    await ensureRoot();
    await fs.writeFile(indexPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    async list({ userId, childId, grade = '' }) {
      const records = await readIndex();
      return records
        .filter((item) => {
          if (item.scope === 'system') return !grade || item.grade === grade;
          return item.userId === userId && item.childId === childId;
        })
        .map(publicTextbookRecord)
        .sort((a, b) => {
          if (Boolean(a.builtIn) !== Boolean(b.builtIn)) return a.builtIn ? -1 : 1;
          return `${a.subject}${a.grade}${a.semester || ''}`.localeCompare(
            `${b.subject}${b.grade}${b.semester || ''}`,
            'zh-CN'
          );
        });
    },

    async create({ userId, childId, subject, grade, filename, buffer, now = new Date() }) {
      const validated = validateTextbookUpload({ filename, buffer });
      if (!validated.ok) return validated;
      if (!String(userId ?? '').trim() || !String(childId ?? '').trim()) {
        return { ok: false, error: '缺少教材所属的孩子档案。' };
      }

      await ensureRoot();
      const id = `textbook_${randomUUID()}`;
      const filePath = path.join(root, `${id}${validated.extension}`);
      const textPath = path.join(root, `${id}.txt`);
      await fs.writeFile(filePath, buffer, { mode: 0o600 });

      try {
        const text = await extractText(filePath, validated.extension);
        if (text.length < 20) {
          throw new Error('教材中没有提取到足够的文字内容。');
        }
        await fs.writeFile(textPath, text, { encoding: 'utf8', mode: 0o600 });
        const record = {
          id,
          scope: 'child',
          builtIn: false,
          userId: String(userId),
          childId: String(childId),
          subject: cleanText(subject) || '未分类',
          grade: cleanText(grade),
          filename: validated.filename,
          size: buffer.length,
          pageCount: String(text).split('\f').filter((page) => page.trim()).length,
          charCount: text.length,
          filePath,
          textPath,
          createdAt: now.toISOString()
        };
        const records = await readIndex();
        await writeIndex([...records, record]);
        return { ok: true, textbook: publicTextbookRecord(record) };
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        await fs.unlink(textPath).catch(() => {});
        return { ok: false, error: error?.message || '教材处理失败。' };
      }
    },

    async importSystemFile({ subject, grade, semester, sourcePath, now = new Date() }) {
      const filename = safeFileName(path.basename(sourcePath));
      const extension = path.extname(filename).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        return { ok: false, error: `不支持的教材格式：${filename}` };
      }
      if (!cleanText(subject) || !cleanText(grade)) {
        return { ok: false, error: `无法识别教材年级或学科：${filename}` };
      }

      await ensureRoot();
      const sourceStat = await fs.stat(sourcePath);
      const digest = createHash('sha256')
        .update(`${cleanText(subject)}\n${cleanText(grade)}\n${cleanText(semester)}\n${filename}`)
        .digest('hex')
        .slice(0, 24);
      const id = `system_textbook_${digest}`;
      const textPath = path.join(root, `${id}.txt`);

      try {
        const text = await extractText(sourcePath, extension);
        if (text.length < 20) {
          throw new Error('教材中没有提取到足够的文字内容。');
        }
        await fs.writeFile(textPath, text, { encoding: 'utf8', mode: 0o600 });
        const record = {
          id,
          scope: 'system',
          builtIn: true,
          userId: '',
          childId: '',
          subject: cleanText(subject),
          grade: cleanText(grade),
          semester: cleanText(semester),
          filename,
          size: sourceStat.size,
          pageCount: String(text).split('\f').filter((page) => page.trim()).length,
          charCount: text.length,
          textPath,
          createdAt: now.toISOString()
        };
        const records = await readIndex();
        const replacedRecords = records.filter(
          (item) =>
            item.scope === 'system' &&
            item.subject === record.subject &&
            item.filename === record.filename
        );
        const nextRecords = [
          ...records.filter(
            (item) =>
              item.id !== id &&
              !(
                item.scope === 'system' &&
                item.subject === record.subject &&
                item.filename === record.filename
              )
          ),
          record
        ];
        await writeIndex(nextRecords);
        await Promise.all(
          replacedRecords
            .filter((item) => item.textPath && item.textPath !== textPath)
            .map((item) => fs.unlink(item.textPath).catch(() => {}))
        );
        return { ok: true, textbook: publicTextbookRecord(record) };
      } catch (error) {
        await fs.unlink(textPath).catch(() => {});
        return { ok: false, error: error?.message || `教材导入失败：${filename}` };
      }
    },

    async getWithText({ id, userId, childId }) {
      const records = await readIndex();
      const record = records.find(
        (item) =>
          item.id === id &&
          (item.scope === 'system' || (item.userId === userId && item.childId === childId))
      );
      if (!record) return null;
      const text = await fs.readFile(record.textPath, 'utf8');
      return { ...publicTextbookRecord(record), text };
    },

    async listWithText({ userId, childId, grade, subject, textbookId = '' }) {
      const records = await readIndex();
      const candidates = records.filter((item) => {
        const canAccess =
          item.scope === 'system' || (item.userId === userId && item.childId === childId);
        if (!canAccess) return false;
        if (textbookId) return item.id === textbookId;
        return item.grade === grade && item.subject === subject;
      });
      return Promise.all(
        candidates.map(async (record) => ({
          ...publicTextbookRecord(record),
          text: await fs.readFile(record.textPath, 'utf8')
        }))
      );
    }
  };
}
