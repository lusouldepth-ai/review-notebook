const CN_PHONE_REGEX = /^1\d{10}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function detectLoginMethod(identifier) {
  if (CN_PHONE_REGEX.test(identifier)) {
    return 'phone';
  }

  if (EMAIL_REGEX.test(identifier)) {
    return 'email';
  }

  return null;
}

export function normalizeIdentifier(rawIdentifier) {
  const trimmed = String(rawIdentifier ?? '').trim();
  const method = detectLoginMethod(trimmed);
  if (method === 'email') {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export function validateLoginInput(input) {
  const identifier = normalizeIdentifier(input?.identifier);
  const method = detectLoginMethod(identifier);

  if (!identifier) {
    return { ok: false, error: '请输入手机号或邮箱。' };
  }

  if (!method) {
    return { ok: false, error: '手机号需为 11 位中国大陆手机号，或输入有效邮箱。' };
  }

  return { ok: true, method, identifier };
}

export function upsertUserByIdentifier(state, payload) {
  const matchIndex = state.users.findIndex(
    (user) => user.method === payload.method && user.identifier === payload.identifier
  );

  if (matchIndex >= 0) {
    const existing = state.users[matchIndex];
    const nextUser =
      payload.displayName && payload.displayName !== existing.displayName
        ? { ...existing, displayName: payload.displayName, updatedAt: payload.updatedAt }
        : existing;

    const nextUsers = [...state.users];
    nextUsers[matchIndex] = nextUser;
    return { user: nextUser, users: nextUsers, isNewUser: false };
  }

  const user = {
    id: `user_${payload.timestamp}_${Math.random().toString(16).slice(2, 8)}`,
    identifier: payload.identifier,
    method: payload.method,
    displayName: payload.displayName || (payload.method === 'phone' ? '家长用户' : '家长'),
    createdAt: payload.updatedAt,
    updatedAt: payload.updatedAt
  };

  return { user, users: [...state.users, user], isNewUser: true };
}

export function loginWithLocalState(state, input, now = new Date()) {
  const valid = validateLoginInput(input);
  if (!valid.ok) {
    return { ok: false, error: valid.error };
  }

  const updatedAt = now.toISOString();
  const { user, users, isNewUser } = upsertUserByIdentifier(state, {
    identifier: valid.identifier,
    method: valid.method,
    displayName: String(input?.displayName ?? '').trim(),
    timestamp: now.getTime(),
    updatedAt
  });

  return {
    ok: true,
    user,
    isNewUser,
    state: {
      ...state,
      users,
      currentUserId: user.id
    }
  };
}

function getUserActivityTime(user) {
  return String(user?.updatedAt || user?.createdAt || '');
}

export function listSavedLoginAccounts(state) {
  const users = Array.isArray(state?.users) ? state.users : [];
  const children = Array.isArray(state?.children) ? state.children : [];
  const mistakes = Array.isArray(state?.mistakes) ? state.mistakes : [];

  return users
    .filter((user) => user && detectLoginMethod(String(user.identifier ?? '')) === user.method)
    .map((user) => ({
      id: user.id,
      identifier: user.identifier,
      method: user.method,
      displayName: user.displayName || (user.method === 'phone' ? '家长用户' : '家长'),
      lastActiveAt: getUserActivityTime(user),
      childCount: children.filter((child) => child.userId === user.id).length,
      mistakeCount: mistakes.filter((mistake) => mistake.userId === user.id).length
    }))
    .sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt)));
}

export function buildAccountRestoreMessage({ prefix = '', created = false, childCount = 0 } = {}) {
  const lead = String(prefix).trim();
  if (created) {
    return `${lead}${lead ? ' ' : ''}已建立对应的本地数据库。`;
  }

  if (Number(childCount) === 0) {
    return `${lead}${lead ? ' ' : ''}当前登录账号没有孩子档案；如果上次已经建档，请切换到当时使用的手机号或邮箱。`;
  }

  return `${lead}${lead ? ' ' : ''}已从本地数据库恢复 ${childCount} 个孩子及学习记录。`;
}

export function logoutWithLocalState(state) {
  return {
    ...state,
    currentUserId: null
  };
}
