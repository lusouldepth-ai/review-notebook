async function readJsonResponse(response, fallbackMessage) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || fallbackMessage);
  }
  return payload;
}

export async function listTextbooks({ userId, childId, grade }, fetchImpl = fetch) {
  const query = new URLSearchParams({ userId, childId, grade });
  const response = await fetchImpl(`/api/textbooks?${query}`);
  const payload = await readJsonResponse(response, '教材列表加载失败。');
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
  const response = await fetchImpl(`/api/textbooks?${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'textbook.pdf')
    },
    body: file
  });
  return readJsonResponse(response, '教材上传失败。');
}

export async function evaluateFeynmanExplanation(input, fetchImpl = fetch) {
  const response = await fetchImpl('/api/feynman/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  return readJsonResponse(response, 'AI 评估失败。');
}
