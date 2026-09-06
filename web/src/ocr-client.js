import { requestJson } from './api-client.js';

export async function postImageForOcr(fileOrBlob, fetchImpl = fetch) {
  return requestJson('/api/ocr', {
    method: 'POST',
    headers: {
      'Content-Type': fileOrBlob.type || 'image/png'
    },
    body: fileOrBlob
  }, {
    fetchImpl,
    fallbackMessage: 'OCR 识别失败，请稍后重试。'
  });
}
