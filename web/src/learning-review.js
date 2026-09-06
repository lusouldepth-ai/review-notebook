export const FEYNMAN_MASTERY_SCORE = 85;
export const FEYNMAN_FAMILIAR_SCORE = 60;

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
}

export function normalizeTextbookEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === 'object' && clean(item.excerpt))
    .slice(0, 3)
    .map((item) => ({
      textbookId: clean(item.textbookId),
      filename: clean(item.filename).slice(0, 160),
      page: Math.max(1, Number(item.page) || 1),
      excerpt: clean(item.excerpt).slice(0, 500)
    }));
}

export function resolveFeynmanMastery(score) {
  const normalized = normalizeScore(score);
  if (normalized >= FEYNMAN_MASTERY_SCORE) return '能讲清';
  if (normalized >= FEYNMAN_FAMILIAR_SCORE) return '不熟';
  return '不懂';
}

export function resolveFeynmanReviewStatus(score) {
  return normalizeScore(score) >= FEYNMAN_MASTERY_SCORE ? '已掌握' : '需再次复习';
}

export function upsertFeynmanReviewTask(state, userId, input, now = new Date()) {
  const childId = clean(input?.childId);
  const subject = clean(input?.subject);
  const topic = clean(input?.topic);
  if (!userId || !childId || !subject || !topic) {
    return { ok: false, error: '缺少费曼复习任务所需的孩子、学科或知识点。' };
  }

  const score = normalizeScore(input?.score);
  const mastery = resolveFeynmanMastery(score);
  const status = resolveFeynmanReviewStatus(score);
  const evidence = normalizeTextbookEvidence(input?.evidence);
  const child = (state.children || []).find(
    (item) => item.id === childId && item.userId === userId
  );
  if (!child) {
    return { ok: false, error: '该孩子档案不存在或不属于当前账号。' };
  }
  const existing = (state.learningReviews || []).find(
    (item) =>
      item.userId === userId &&
      item.childId === childId &&
      item.subject === subject &&
      item.topic === topic
  );
  const timestamp = now.toISOString();
  const task = {
    ...(existing || {
      id: `learning_review_${now.getTime()}_${Math.random().toString(16).slice(2, 8)}`,
      userId,
      childId,
      subject,
      topic,
      createdAt: timestamp
    }),
    explanation: clean(input?.explanation),
    unclear: clean(input?.unclear),
    unfamiliar: clean(input?.unfamiliar),
    teachBetter: clean(input?.teachBetter),
    followUpQuestion: clean(input?.followUpQuestion),
    aiScore: score,
    mastery,
    status,
    textbookEvidence: evidence,
    lastEvaluatedAt: timestamp,
    updatedAt: timestamp
  };
  const learningReviews = Array.isArray(state.learningReviews) ? state.learningReviews : [];
  return {
    ok: true,
    isNew: !existing,
    mastery,
    status,
    task,
    state: {
      ...state,
      learningReviews: existing
        ? learningReviews.map((item) => (item.id === task.id ? task : item))
        : [...learningReviews, task]
    }
  };
}

export function listFeynmanReviewTasks(state, userId, childId, status = '') {
  return (Array.isArray(state?.learningReviews) ? state.learningReviews : [])
    .filter((item) => item.userId === userId && item.childId === childId)
    .filter((item) => !status || item.status === status)
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function migrateFeynmanNotesToReviewTasks(state) {
  const existingKeys = new Set(
    (Array.isArray(state?.learningReviews) ? state.learningReviews : []).map(
      (item) => `${item.userId}:${item.childId}:${item.subject}:${item.topic}`
    )
  );
  const latestNotes = new Map();
  for (const note of Array.isArray(state?.feynmanNotes) ? state.feynmanNotes : []) {
    if (!note?.userId || !note?.childId || !note?.subject || !note?.concept) continue;
    if (!Number.isFinite(Number(note.aiScore))) continue;
    const key = `${note.userId}:${note.childId}:${note.subject}:${note.concept}`;
    const current = latestNotes.get(key);
    if (!current || String(note.updatedAt || '').localeCompare(String(current.updatedAt || '')) > 0) {
      latestNotes.set(key, note);
    }
  }

  let nextState = state;
  for (const [key, note] of latestNotes) {
    if (existingKeys.has(key)) continue;
    const timestamp = new Date(note.updatedAt || note.createdAt || Date.now());
    const now = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
    const result = upsertFeynmanReviewTask(nextState, note.userId, {
      childId: note.childId,
      subject: note.subject,
      topic: note.concept,
      explanation: note.explainSimply,
      score: note.aiScore,
      unclear: note.stuckPoint,
      unfamiliar: note.unfamiliarPoint,
      teachBetter: note.teachBack,
      followUpQuestion: note.aiAssessment?.followUpQuestion,
      evidence: note.textbookEvidence
    }, now);
    if (result.ok) {
      nextState = result.state;
      existingKeys.add(key);
    }
  }
  return nextState;
}
