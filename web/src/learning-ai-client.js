import { requestJson } from './api-client.js';

export async function listTextbooks({ userId, childId, grade }, fetchImpl = fetch) {
  const query = new URLSearchParams({ userId, childId, grade });
  const payload = await requestJson(`/api/textbooks?${query}`, {}, {
    fetchImpl,
    fallbackMessage: '教材列表加载失败。'
  });
  return Array.isArray(payload.textbooks) ? payload.textbooks : [];
}

export async function uploadTextbook(
  { userId, childId, subject, grade, file },
  fetchImpl = fetch
) {
  if (!(file instanceof Blob) || file.size === 0) {
    throw new Error('请选择教材文件。');
  }
  const query = new URLSearchParams({ userId, childId, subject, grade });
  return requestJson(`/api/textbooks?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'textbook.pdf')
    },
    body: file
  }, {
    fetchImpl,
    fallbackMessage: '教材上传失败。'
  });
}

export async function evaluateFeynmanExplanation(input, fetchImpl = fetch) {
  return requestJson('/api/feynman/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  }, {
    fetchImpl,
    fallbackMessage: 'AI 评估失败。'
  });
}
