export const APP_STATE_KEY = 'mistake-book-state-v1';
export const APP_STATE_RECOVERY_KEY = `${APP_STATE_KEY}:last-good`;
export const APP_STATE_CORRUPT_KEY = `${APP_STATE_KEY}:corrupt`;

export function createEmptyState() {
  return {
    users: [],
    children: [],
    mistakes: [],
    exports: [],
    reviewSessions: [],
    reviewAttempts: [],
    feynmanNotes: [],
    learningReviews: [],
    weakPointViews: [],
    auditLogs: [],
    reminder: null,
    autoExport: null,
    currentUserId: null,
    currentChildId: null
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStateText(raw) {
  if (!raw) {
    return { ok: false, state: null };
  }
  try {
    return { ok: true, state: normalizeState(JSON.parse(raw)) };
  } catch {
    return { ok: false, state: null };
  }
}

function preserveCorruptState(storage, raw) {
  if (!raw) return;
  try {
    storage.setItem(APP_STATE_CORRUPT_KEY, raw);
  } catch {
    // Keeping the app usable is more important than preserving a corrupt copy.
  }
}

function preserveRecoveryState(storage, raw) {
  const parsed = parseStateText(raw);
  if (!parsed.ok) return false;
  try {
    storage.setItem(APP_STATE_RECOVERY_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

export function normalizeState(value) {
  if (!isObject(value)) {
    return createEmptyState();
  }

  return {
    users: Array.isArray(value.users) ? value.users : [],
    children: Array.isArray(value.children) ? value.children : [],
    mistakes: Array.isArray(value.mistakes) ? value.mistakes : [],
    exports: Array.isArray(value.exports) ? value.exports : [],
    reviewSessions: Array.isArray(value.reviewSessions) ? value.reviewSessions : [],
    reviewAttempts: Array.isArray(value.reviewAttempts) ? value.reviewAttempts : [],
    feynmanNotes: Array.isArray(value.feynmanNotes) ? value.feynmanNotes : [],
    learningReviews: Array.isArray(value.learningReviews) ? value.learningReviews : [],
    weakPointViews: Array.isArray(value.weakPointViews) ? value.weakPointViews : [],
    auditLogs: Array.isArray(value.auditLogs) ? value.auditLogs : [],
    reminder: isObject(value.reminder) ? value.reminder : null,
    autoExport: isObject(value.autoExport) ? value.autoExport : null,
    currentUserId: typeof value.currentUserId === 'string' ? value.currentUserId : null,
    currentChildId: typeof value.currentChildId === 'string' ? value.currentChildId : null
  };
}

export function loadAppState(storageLike) {
  const storage = storageLike ?? globalThis.localStorage;
  const raw = storage.getItem(APP_STATE_KEY);
  if (!raw) {
    const recovery = parseStateText(storage.getItem(APP_STATE_RECOVERY_KEY));
    return recovery.ok ? recovery.state : createEmptyState();
  }

  const parsed = parseStateText(raw);
  if (parsed.ok) {
    return parsed.state;
  }

  preserveCorruptState(storage, raw);
  const recovery = parseStateText(storage.getItem(APP_STATE_RECOVERY_KEY));
  return recovery.ok ? recovery.state : createEmptyState();
}

export function saveAppState(state, storageLike) {
  const storage = storageLike ?? globalThis.localStorage;
  const previousRaw = storage.getItem(APP_STATE_KEY);
  const hasRecovery = previousRaw ? preserveRecoveryState(storage, previousRaw) : false;
  const normalized = normalizeState(state);
  const nextRaw = JSON.stringify(normalized);
  storage.setItem(APP_STATE_KEY, nextRaw);
  if (!hasRecovery) {
    preserveRecoveryState(storage, nextRaw);
  }
  return normalized;
}
