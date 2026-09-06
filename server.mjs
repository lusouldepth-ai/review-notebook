import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTempImageFile,
  extensionFromImageContentType,
  runImageOcrRecognition,
  writeTempImageFile
} from './server/ocr-runner.mjs';
import {
  cleanupTempFile,
  extensionFromContentType,
  runWhisperTranscription,
  writeTempAudioFile
} from './server/transcribe-runner.mjs';
import { evaluateWithDeepSeek } from './server/feynman-evaluator.mjs';
import { getApiErrorStatus, resolveStaticPath } from './server/http-utils.mjs';
import { createAccountStateStore } from './server/account-state-store.mjs';
import {
  buildTextbookEvidence,
  createTextbookStore,
  MIN_TEXTBOOK_RELEVANCE_SCORE,
  rankRelevantPassages
} from './server/textbook-store.mjs';
import { validateLoginInput } from './web/src/auth.js';
import { validateAccountState } from './web/src/account-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, 'web');
const port = Number(process.env.PORT || 5173);
const textbookStore = createTextbookStore({ rootDir: path.join(__dirname, 'data', 'textbooks') });
const accountStateStore = createAccountStateStore({
  dbPath: path.join(__dirname, 'data', 'review-notebook.sqlite')
});

const contentTypeMap = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.ico', 'image/x-icon']
]);

async function serveStatic(req, res) {
  const fullPath = resolveStaticPath(webRoot, req.url || '/');
  if (!fullPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = contentTypeMap.get(ext) || 'application/octet-stream';
    const content = await fs.readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function readRequestBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buffer = await readRequestBody(req, maxBytes);
  if (buffer.length === 0) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

async function handleTranscribe(req, res) {
  let tempFilePath = null;
  try {
    const buffer = await readRequestBody(req);
    if (buffer.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'empty_audio' }));
      return;
    }

    const contentType = req.headers['content-type'] || '';
    const extension = extensionFromContentType(contentType);
    tempFilePath = await writeTempAudioFile(buffer, extension);

    const result = await runWhisperTranscription({
      audioPath: tempFilePath,
      language: 'zh',
      model: 'small'
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (error) {
    const statusCode = getApiErrorStatus(error);
    const message =
      error?.message === 'payload_too_large'
        ? '音频文件过大，请控制在 20MB 内。'
        : `语音转写失败：${error?.message || 'unknown error'}`;
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: message }));
  } finally {
    if (tempFilePath) {
      await cleanupTempFile(tempFilePath);
    }
  }
}

async function handleOcr(req, res) {
  let tempFilePath = null;
  try {
    const buffer = await readRequestBody(req);
    if (buffer.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'empty_image' }));
      return;
    }

    const contentType = req.headers['content-type'] || '';
    const extension = extensionFromImageContentType(contentType);
    tempFilePath = await writeTempImageFile(buffer, extension);

    const result = await runImageOcrRecognition({
      imagePath: tempFilePath
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
  } catch (error) {
    const statusCode = getApiErrorStatus(error);
    const message =
      error?.message === 'payload_too_large'
        ? '图片文件过大，请控制在 20MB 内。'
        : `OCR 识别失败：${error?.message || 'unknown error'}`;
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: message }));
  } finally {
    if (tempFilePath) {
      await cleanupTempImageFile(tempFilePath);
    }
  }
}

async function handleListTextbooks(requestUrl, res) {
  const userId = String(requestUrl.searchParams.get('userId') || '').trim();
  const childId = String(requestUrl.searchParams.get('childId') || '').trim();
  const grade = String(requestUrl.searchParams.get('grade') || '').trim();
  if (!userId || !childId) {
    sendJson(res, 400, { ok: false, error: '缺少家长或孩子档案信息。' });
    return;
  }
  try {
    const textbooks = await textbookStore.list({ userId, childId, grade });
    sendJson(res, 200, { ok: true, textbooks });
  } catch {
    sendJson(res, 500, { ok: false, error: '教材列表加载失败。' });
  }
}

async function handleUploadTextbook(req, requestUrl, res) {
  try {
    const buffer = await readRequestBody(req, 25 * 1024 * 1024);
    const userId = String(requestUrl.searchParams.get('userId') || '').trim();
    const childId = String(requestUrl.searchParams.get('childId') || '').trim();
    const subject = String(requestUrl.searchParams.get('subject') || '').trim();
    const grade = String(requestUrl.searchParams.get('grade') || '').trim();
    const encodedName = String(req.headers['x-file-name'] || 'textbook.pdf');
    let filename = 'textbook.pdf';
    try {
      filename = decodeURIComponent(encodedName);
    } catch {
      filename = 'textbook.pdf';
    }
    const result = await textbookStore.create({
      userId,
      childId,
      subject,
      grade,
      filename,
      buffer
    });
    sendJson(res, result.ok ? 201 : 400, result);
  } catch (error) {
    const status = error?.message === 'payload_too_large' ? 413 : 500;
    sendJson(res, status, {
      ok: false,
      error: status === 413 ? '教材文件不能超过 25MB。' : '教材上传失败。'
    });
  }
}

async function handleFeynmanEvaluation(req, res) {
  try {
    const input = await readJsonBody(req);
    const userId = String(input.userId || '').trim();
    const childId = String(input.childId || '').trim();
    const textbookId = String(input.textbookId || '').trim();
    const topic = String(input.topic || '').trim();
    const explanation = String(input.explanation || '').trim();
    const grade = String(input.grade || '').trim();
    const subject = String(input.subject || '').trim();
    if (!userId || !childId || !grade || !subject || !topic || !explanation) {
      sendJson(res, 400, { ok: false, error: '请填写学科、知识点和孩子的讲解。' });
      return;
    }

    const candidates = await textbookStore.listWithText({
      userId,
      childId,
      grade,
      subject,
      textbookId
    });
    if (textbookId && candidates.length === 0) {
      sendJson(res, 404, { ok: false, error: '没有找到当前孩子的这本教材。' });
      return;
    }

    const rankedPassages = candidates
      .flatMap((textbook) =>
        rankRelevantPassages(textbook.text, `${topic}\n${topic}\n${explanation}`, 8).map(
          (passage) => ({
            ...passage,
            textbookId: textbook.id,
            filename: textbook.filename,
            subject: textbook.subject,
            grade: textbook.grade
          })
        )
      )
      .sort((a, b) => b.score - a.score);
    const passages = rankedPassages
      .filter((passage) => passage.score >= MIN_TEXTBOOK_RELEVANCE_SCORE)
      .slice(0, 6);
    const sourceMode = passages.length > 0 ? 'textbook' : 'general';
    const evidence =
      sourceMode === 'textbook'
        ? buildTextbookEvidence(passages, `${topic}\n${explanation}`, 3)
        : [];
    const matchedIds = new Set(passages.map((passage) => passage.textbookId));
    const matchedTextbooks = candidates
      .filter((textbook) => matchedIds.has(textbook.id))
      .map(({ text, ...textbook }) => textbook);

    const result = await evaluateWithDeepSeek({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      model: process.env.DEEPSEEK_MODEL,
      input: {
        grade,
        subject,
        topic,
        explanation,
        passages,
        sourceMode
      }
    });
    const basisLabel =
      sourceMode === 'textbook'
        ? `已核对：${matchedTextbooks.map((item) => item.filename).join('、')}`
        : '教材库未可靠命中，使用通用知识评估';
    sendJson(res, 200, {
      ok: true,
      evaluation: result.evaluation,
      model: result.model,
      usage: result.usage,
      basis: {
        mode: sourceMode,
        label: basisLabel,
        matchedPassageCount: passages.length,
        evidence,
        textbooks: matchedTextbooks
      },
      textbook: matchedTextbooks[0] || null
    });
  } catch (error) {
    const status =
      error?.code === 'INVALID_JSON'
        ? 400
        : error?.code === 'AI_NOT_CONFIGURED'
          ? 503
          : error?.code === 'AI_UPSTREAM_ERROR'
            ? 502
            : error?.code === 'AI_TIMEOUT'
              ? 504
              : 500;
    sendJson(res, status, { ok: false, error: error?.message || 'AI 评估失败。' });
  }
}

function validateAccountRequest(input) {
  const login = validateLoginInput({ identifier: input?.identifier });
  if (!login.ok) return login;

  const account = validateAccountState(input?.accountState, {
    method: login.method,
    identifier: login.identifier
  });
  if (!account.ok) return account;

  return {
    ok: true,
    method: login.method,
    identifier: login.identifier,
    state: account.state
  };
}

async function handleAccountLogin(req, res) {
  try {
    const input = await readJsonBody(req, 5 * 1024 * 1024);
    const validated = validateAccountRequest(input);
    if (!validated.ok) {
      sendJson(res, 400, { ok: false, error: validated.error });
      return;
    }

    let record = accountStateStore.load(validated);
    const created = !record;
    if (!record) {
      record = accountStateStore.create({
        method: validated.method,
        identifier: validated.identifier,
        state: validated.state
      });
    }
    sendJson(res, 200, {
      ok: true,
      created,
      accountState: record.state,
      revision: record.revision,
      updatedAt: record.updatedAt
    });
  } catch (error) {
    const status = error?.message === 'payload_too_large' ? 413 : error?.code === 'INVALID_JSON' ? 400 : 500;
    sendJson(res, status, {
      ok: false,
      error: status === 413 ? '本地账户数据过大，无法保存。' : '本地数据库登录失败。'
    });
  }
}

async function handleAccountSave(req, res) {
  try {
    const input = await readJsonBody(req, 5 * 1024 * 1024);
    const validated = validateAccountRequest(input);
    if (!validated.ok) {
      sendJson(res, 400, { ok: false, error: validated.error });
      return;
    }

    const record = accountStateStore.save({
      method: validated.method,
      identifier: validated.identifier,
      state: validated.state
    });
    sendJson(res, 200, {
      ok: true,
      revision: record.revision,
      updatedAt: record.updatedAt
    });
  } catch (error) {
    const status = error?.message === 'payload_too_large' ? 413 : error?.code === 'INVALID_JSON' ? 400 : 500;
    sendJson(res, status, {
      ok: false,
      error: status === 413 ? '本地账户数据过大，无法保存。' : '本地数据库保存失败。'
    });
  }
}

createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && requestUrl.pathname === '/api/account/login') {
    await handleAccountLogin(req, res);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/account/state') {
    await handleAccountSave(req, res);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/transcribe') {
    await handleTranscribe(req, res);
    return;
  }

  if (req.method === 'POST' && requestUrl.pathname === '/api/ocr') {
    await handleOcr(req, res);
    return;
  }

  if (requestUrl.pathname === '/api/textbooks' && req.method === 'GET') {
    await handleListTextbooks(requestUrl, res);
    return;
  }

  if (requestUrl.pathname === '/api/textbooks' && req.method === 'POST') {
    await handleUploadTextbook(req, requestUrl, res);
    return;
  }

  if (requestUrl.pathname === '/api/feynman/evaluate' && req.method === 'POST') {
    await handleFeynmanEvaluation(req, res);
    return;
  }

  await serveStatic(req, res);
}).listen(port, () => {
  console.log(`Local web app is running on http://localhost:${port}`);
});
