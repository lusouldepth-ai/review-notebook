import { requestJson } from './api-client.js';

const ACCOUNT_FALLBACK_MESSAGE = '本地数据库操作失败，请稍后重试。';

function requestAccount(path, body, fetchImpl = fetch) {
  return requestJson(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    { fetchImpl, fallbackMessage: ACCOUNT_FALLBACK_MESSAGE }
  );
}

export function loginLocalAccount(input, fetchImpl = fetch) {
  return requestAccount('/api/account/login', input, fetchImpl);
}

export function saveLocalAccountState(input, fetchImpl = fetch) {
  return requestAccount('/api/account/state', input, fetchImpl);
}
