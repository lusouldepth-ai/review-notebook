export const LOCAL_SERVICE_UNAVAILABLE_MESSAGE =
  '无法连接本地服务，请确认项目已启动后刷新页面。';

export async function requestJson(
  url,
  options = {},
  { fetchImpl = fetch, fallbackMessage = '请求失败，请稍后重试。' } = {}
) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    throw new Error(LOCAL_SERVICE_UNAVAILABLE_MESSAGE);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || fallbackMessage);
  }
  return payload;
}
