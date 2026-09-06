import { normalizeState } from './storage.js';

export const ACCOUNT_SCOPED_COLLECTIONS = [
  'children',
  'mistakes',
  'exports',
  'reviewSessions',
  'reviewAttempts',
  'feynmanNotes',
  'weakPointViews',
  'auditLogs'
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameLogin(user, method, identifier) {
  return user?.method === method && user?.identifier === identifier;
}

export function extractAccountState(rawState, userId) {
  const state = normalizeState(rawState);
  const user = state.users.find((item) => item?.id === userId);
  if (!user) return null;

  const children = state.children.filter((item) => item?.userId === user.id);
  const childIds = new Set(children.map((item) => item.id));
  const currentChildId = childIds.has(state.currentChildId) ? state.currentChildId : children[0]?.id ?? null;

  return {
    ...normalizeState({}),
    users: [user],
    children,
    mistakes: state.mistakes.filter((item) => item?.userId === user.id),
    exports: state.exports.filter((item) => item?.userId === user.id),
    reviewSessions: state.reviewSessions.filter((item) => item?.userId === user.id),
    reviewAttempts: state.reviewAttempts.filter((item) => item?.userId === user.id),
    feynmanNotes: state.feynmanNotes.filter((item) => item?.userId === user.id),
    weakPointViews: state.weakPointViews.filter((item) => item?.userId === user.id),
    auditLogs: state.auditLogs.filter((item) => item?.userId === user.id),
    reminder: state.reminder,
    autoExport: state.autoExport,
    currentUserId: user.id,
    currentChildId
  };
}

export function validateAccountState(rawState, { method, identifier } = {}) {
  if (!isObject(rawState) || !Array.isArray(rawState.users) || rawState.users.length !== 1) {
    return { ok: false, error: '账户数据格式无效。' };
  }

  const user = rawState.users[0];
  if (
    !isObject(user) ||
    typeof user.id !== 'string' ||
    !user.id ||
    !sameLogin(user, method, identifier)
  ) {
    return { ok: false, error: '账户身份与本地记录不一致。' };
  }

  for (const key of ACCOUNT_SCOPED_COLLECTIONS) {
    if (!Array.isArray(rawState[key])) {
      return { ok: false, error: `账户数据缺少 ${key} 记录。` };
    }
    if (rawState[key].some((item) => !isObject(item) || item.userId !== user.id)) {
      return { ok: false, error: `${key} 中包含其他账户的数据。` };
    }
  }

  const childIds = new Set(rawState.children.map((item) => item.id));
  for (const key of ACCOUNT_SCOPED_COLLECTIONS.filter((item) => item !== 'children')) {
    if (
      rawState[key].some(
        (item) => item.childId && typeof item.childId === 'string' && !childIds.has(item.childId)
      )
    ) {
      return { ok: false, error: `${key} 中包含不属于当前账户的孩子记录。` };
    }
  }

  const state = normalizeState(rawState);
  state.currentUserId = user.id;
  state.currentChildId = childIds.has(state.currentChildId)
    ? state.currentChildId
    : state.children[0]?.id ?? null;
  return { ok: true, state };
}

export function mergeAccountState(rawLocalState, rawAccountState) {
  const localState = normalizeState(rawLocalState);
  const accountState = normalizeState(rawAccountState);
  const accountUser = accountState.users[0];
  if (!accountUser) return localState;

  const replacedUserIds = new Set(
    localState.users
      .filter(
        (user) =>
          user?.id === accountUser.id ||
          sameLogin(user, accountUser.method, accountUser.identifier)
      )
      .map((user) => user.id)
  );

  const nextState = {
    ...localState,
    users: [
      ...localState.users.filter((user) => !replacedUserIds.has(user.id)),
      accountUser
    ],
    reminder: accountState.reminder,
    autoExport: accountState.autoExport,
    currentUserId: accountUser.id,
    currentChildId: accountState.currentChildId
  };

  for (const key of ACCOUNT_SCOPED_COLLECTIONS) {
    nextState[key] = [
      ...localState[key].filter((item) => !replacedUserIds.has(item?.userId)),
      ...accountState[key]
    ];
  }

  return normalizeState(nextState);
}
