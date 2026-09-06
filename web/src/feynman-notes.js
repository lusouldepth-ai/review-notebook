import { normalizeReviewPoints, normalizeTextbookEvidence } from './learning-review.js';

const MASTERY_OPTIONS = ['不懂', '不熟', '能讲清'];

function makeId(prefix, now = new Date()) {
  return `${prefix}_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeMastery(value, fallback = '不熟') {
  const text = String(value ?? '').trim();
  return MASTERY_OPTIONS.includes(text) ? text : fallback;
}

export function getFeynmanMasteryOptions() {
  return [...MASTERY_OPTIONS];
}

export function normalizeFeynmanNoteInput(input) {
  const concept = String(input?.concept ?? '').trim();
  if (!concept) {
    return { ok: false, error: '请填写笔记主题或知识点。' };
  }

  const stuckPoint = String(input?.stuckPoint ?? '').trim();
  const unfamiliarPoint = String(input?.unfamiliarPoint ?? '').trim();

  return {
    ok: true,
    note: {
      childId: String(input?.childId ?? '').trim(),
      subject: String(input?.subject ?? '未分类').trim() || '未分类',
      concept,
      explainSimply: String(input?.explainSimply ?? '').trim(),
      teachBack: String(input?.teachBack ?? '').trim(),
      stuckPoint,
      unfamiliarPoint,
      example: String(input?.example ?? '').trim(),
      relatedMistakeId: String(input?.relatedMistakeId ?? '').trim(),
      mastery: normalizeMastery(input?.mastery, '不熟'),
      aiScore: Number.isFinite(Number(input?.aiScore))
        ? Math.max(0, Math.min(100, Math.round(Number(input.aiScore))))
        : null,
      aiAssessment:
        input?.aiAssessment && typeof input.aiAssessment === 'object'
          ? input.aiAssessment
          : null,
      textbookId: String(input?.textbookId ?? '').trim(),
      textbookName: String(input?.textbookName ?? '').trim(),
      textbookEvidence: normalizeTextbookEvidence(input?.textbookEvidence),
      reviewPoints: normalizeReviewPoints(input?.reviewPoints),
      reviewTaskId: String(input?.reviewTaskId ?? '').trim(),
      reviewStatus: String(input?.reviewStatus ?? '').trim()
    }
  };
}

export function createFeynmanNote(state, userId, input, now = new Date()) {
  const normalized = normalizeFeynmanNoteInput(input);
  if (!normalized.ok) {
    return normalized;
  }

  const timestamp = now.toISOString();
  const note = {
    id: makeId('feynman_note', now),
    userId,
    ...normalized.note,
    reviewLogs: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };

  return {
    ok: true,
    state: {
      ...state,
      feynmanNotes: [...ensureArray(state.feynmanNotes), note]
    },
    note
  };
}

export function recordFeynmanReview(state, userId, noteId, input, now = new Date()) {
  const notes = ensureArray(state.feynmanNotes);
  const note = notes.find((item) => item.id === noteId && item.userId === userId);
  if (!note) {
    return { ok: false, error: '未找到这条费曼笔记。' };
  }

  const timestamp = now.toISOString();
  const log = {
    id: makeId('feynman_review', now),
    reviewText: String(input?.reviewText ?? '').trim(),
    mastery: normalizeMastery(input?.mastery, note.mastery),
    createdAt: timestamp
  };
  const nextNote = {
    ...note,
    mastery: log.mastery,
    reviewLogs: [...ensureArray(note.reviewLogs), log],
    updatedAt: timestamp
  };

  return {
    ok: true,
    state: {
      ...state,
      feynmanNotes: notes.map((item) => (item.id === note.id ? nextNote : item))
    },
    note: nextNote,
    log
  };
}

export function listFeynmanNotesForUser(state, userId, filters = {}) {
  const subject = String(filters.subject ?? 'all').trim();
  const mastery = String(filters.mastery ?? 'all').trim();
  const childId = String(filters.childId ?? 'all').trim();
  return ensureArray(state.feynmanNotes)
    .filter((note) => note.userId === userId)
    .filter((note) => childId === 'all' || note.childId === childId)
    .filter((note) => subject === 'all' || note.subject === subject)
    .filter((note) => mastery === 'all' || note.mastery === mastery)
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
