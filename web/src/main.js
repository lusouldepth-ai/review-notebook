import { listSavedLoginAccounts, loginWithLocalState, logoutWithLocalState } from './auth.js';
import { extractAccountState, mergeAccountState } from './account-state.js';
import { loginLocalAccount, saveLocalAccountState } from './account-state-client.js';
import {
  createDefaultAutoExport,
  evaluateAutoExport,
  normalizeAutoExportConfig
} from './auto-export.js';
import {
  appendAuditLog,
  normalizeAuditLogs
} from './audit-log.js';
import {
  buildBackupFileName,
  createBackupBundle,
  parseBackupBundleText,
  serializeBackupBundle
} from './backup.js';
import {
  buildExportFileName,
  buildExportPayload,
  generateMarkdownDocument,
  generatePdfDocument,
  generateTextDocument,
  resolveExportFormat
} from './exporter.js';
import {
  createFeynmanNote,
  getFeynmanMasteryOptions,
  listFeynmanNotesForUser,
  recordFeynmanReview
} from './feynman-notes.js';
import {
  getDateRangeByCycle,
  normalizeExportCycle,
  resolveExportRangeForCycleChange,
  resolveExportRangeForSubmit,
  shouldDisableExportDateInputs
} from './export-cycle.js';
import { inferRecordDateFromImageMetadata } from './date-inference.js';
import {
  createChildProfile,
  createMistakeRecord,
  createOcrDraftFromText,
  deleteMistakeRecord,
  detectPotentialDuplicateMistakes,
  filterMistakesForUser,
  findMistakeByIdForUser,
  getCategoryOptionsBySubject,
  getReviewStatusOptions,
  getSourceOptions,
  getSubjectOptions,
  listChildrenByUser,
  resolveCurrentChildForUser,
  setCurrentChildForUser,
  updateMistakeRecord,
  updateMistakeStatus
} from './mistake-book.js';
import {
  createDefaultReminder,
  evaluateReminder,
  normalizeReminder
} from './reminder.js';
import {
  getCurrentReviewMistakeId,
  getReviewSessionProgress,
  isReviewSessionActive,
  listReviewAttemptsForChild,
  recordWeakPointView,
  resumeOrCreateReviewSession,
  stopReviewSession,
  submitReviewAnswer
} from './review-session.js';
import { filterMistakesByRecentDays, summarizeWeakPoints } from './weak-points.js';
import { loadAppState, saveAppState } from './storage.js';
import { postImageForOcr } from './ocr-client.js';
import {
  evaluateFeynmanExplanation,
  listTextbooks,
  uploadTextbook
} from './learning-ai-client.js';
import {
  buildFeynmanReviewPoints,
  listFeynmanReviewTasks,
  migrateFeynmanNotesToReviewTasks,
  resolveFeynmanMastery,
  upsertFeynmanReviewTask
} from './learning-review.js';
import { postAudioForTranscription, startAudioRecording } from './transcribe-client.js';

const statusEl = document.getElementById('app-status');
const appEl = document.getElementById('app');
const MISTAKE_LIST_PAGE_SIZE = 20;

function normalizeRuntimeState(rawState) {
  const normalized = {
    ...rawState,
    reminder: normalizeReminder(rawState?.reminder ?? createDefaultReminder()),
    autoExport: normalizeAutoExportConfig(rawState?.autoExport ?? createDefaultAutoExport()),
    auditLogs: normalizeAuditLogs(rawState?.auditLogs)
  };
  return migrateFeynmanNotesToReviewTasks(normalized);
}

let state = saveAppState(normalizeRuntimeState(loadAppState()));
let recorderController = null;
let feynmanRecorderController = null;
let reminderTimerId = null;
let accountSaveQueue = Promise.resolve();
const databaseState = {
  status: getCurrentUser() ? 'connecting' : 'idle',
  revision: null,
  updatedAt: null,
  error: ''
};
const voiceState = {
  status: 'idle',
  text: '',
  engine: '',
  error: ''
};
const feynmanVoiceState = {
  status: 'idle',
  error: ''
};
const aiLearningState = {
  status: 'idle',
  error: '',
  evaluation: null,
  basis: null,
  model: '',
  reviewTask: null,
  pendingSave: null,
  saveStatus: 'idle',
  textbookStatus: 'idle',
  textbookError: '',
  textbooks: [],
  contextKey: '',
  draft: {
    subject: '数学',
    topic: '',
    explanation: ''
  }
};
const uiState = {
  activeWorkspace: 'review',
  exportCycle: 'week',
  exportExcludeMastered: false,
  exportPrioritizeNeedReview: true,
  mistakeSubject: '语文',
  mistakeCategory: '错别字',
  listFilterStartDate: '',
  listFilterEndDate: '',
  listFilterChildId: 'current',
  listFilterSubject: 'all',
  listFilterCategory: '',
  listFilterStatus: 'all',
  listFilterTag: '',
  listVisibleCount: MISTAKE_LIST_PAGE_SIZE,
  selectedMistakeId: null,
  editingMistakeId: null,
  activeReviewSessionId: null,
  lastReviewResult: null,
  weakPointScope: 'current',
  weakPointDays: '90',
  weakPointMinFrequency: '2',
  noteSubjectFilter: 'all',
  noteMasteryFilter: 'all'
};

const voiceStatusTextMap = {
  idle: '未录音',
  recording: '录音中',
  processing: '识别中',
  done: '识别完成'
};

function setStatusNotice(message = '') {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function getCurrentUser() {
  return state.users.find((user) => user.id === state.currentUserId) ?? null;
}

function getReminderConfig() {
  return normalizeReminder(state.reminder ?? createDefaultReminder());
}

function getAutoExportConfig() {
  return normalizeAutoExportConfig(state.autoExport ?? createDefaultAutoExport());
}

function getRecentAuditLogs(limit = 20) {
  const userId = getCurrentUser()?.id;
  return normalizeAuditLogs(state.auditLogs)
    .filter((item) => item.userId === userId)
    .slice()
    .reverse()
    .slice(0, limit);
}

function buildAccountPayload(sourceState = state) {
  const user = sourceState.users.find((item) => item.id === sourceState.currentUserId);
  if (!user) return null;
  const accountState = extractAccountState(sourceState, user.id);
  if (!accountState) return null;
  return { identifier: user.identifier, accountState };
}

function queueAccountSave(sourceState = state) {
  const payload = buildAccountPayload(sourceState);
  if (!payload) return accountSaveQueue;

  databaseState.status = 'saving';
  databaseState.error = '';
  accountSaveQueue = accountSaveQueue
    .catch(() => undefined)
    .then(async () => {
      const result = await saveLocalAccountState(payload);
      databaseState.status = 'synced';
      databaseState.revision = result.revision ?? databaseState.revision;
      databaseState.updatedAt = result.updatedAt ?? databaseState.updatedAt;
      return result;
    })
    .catch((error) => {
      databaseState.status = 'error';
      databaseState.error = error?.message || '本地数据库保存失败。';
      throw error;
    });
  return accountSaveQueue;
}

function saveRuntimeState(nextState) {
  state = saveAppState(normalizeRuntimeState(nextState));
  void queueAccountSave(state).catch(() => undefined);
  return state;
}

function writeAuditLog(action, result = 'success', detail = '', now = new Date()) {
  state = saveRuntimeState(
    appendAuditLog(
      state,
      {
        userId: getCurrentUser()?.id ?? null,
        action,
        result,
        detail
      },
      now
    )
  );
}

function confirmDangerAction({ actionLabel, summaryLines = [] }) {
  const summary = Array.isArray(summaryLines) ? summaryLines.filter(Boolean).join('\n') : '';
  const shouldContinue =
    typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm(`${actionLabel}\n${summary}\n\n请确认是否继续？`);
  if (!shouldContinue) {
    writeAuditLog('security.confirm_action', 'cancelled', `${actionLabel}：用户取消`);
    setStatusNotice('已取消敏感操作。');
    return false;
  }
  return true;
}

async function finishAccountLogin(result, successMessage) {
  state = saveAppState(normalizeRuntimeState(result.state));
  databaseState.status = 'connecting';
  databaseState.error = '';
  render('正在读取本地数据库...');

  try {
    const payload = buildAccountPayload(state);
    const databaseResult = await loginLocalAccount(payload);
    const remoteLearningReviews = Array.isArray(databaseResult.accountState?.learningReviews)
      ? databaseResult.accountState.learningReviews
      : [];
    state = saveAppState(
      normalizeRuntimeState(mergeAccountState(state, databaseResult.accountState))
    );
    databaseState.status = 'synced';
    databaseState.revision = databaseResult.revision ?? null;
    databaseState.updatedAt = databaseResult.updatedAt ?? null;
    const localLearningReviews =
      extractAccountState(state, state.currentUserId)?.learningReviews ?? [];
    if (JSON.stringify(localLearningReviews) !== JSON.stringify(remoteLearningReviews)) {
      await queueAccountSave(state);
    }
    successMessage = databaseResult.created
      ? `${successMessage} 已建立对应的本地数据库。`
      : `${successMessage} 已恢复该账号的孩子和学习记录。`;
  } catch (error) {
    databaseState.status = 'error';
    databaseState.error = error?.message || '本地数据库连接失败。';
    successMessage = `${successMessage} 数据库暂时不可用，当前记录仍保存在浏览器。`;
  }

  maybeTriggerReminder();
  maybeTriggerAutoExport();
  render(successMessage);
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = loginWithLocalState(state, {
    identifier: form.get('identifier'),
    displayName: form.get('displayName')
  });

  if (!result.ok) {
    render(result.error);
    return;
  }

  await finishAccountLogin(
    result,
    result.isNewUser ? '登录成功，已创建本地家长账号。' : '登录成功。'
  );
}

async function handleSavedAccountLogin(event) {
  const button = event.currentTarget;
  const identifier = String(button?.dataset?.identifier ?? '').trim();
  const displayName = String(button?.dataset?.displayName ?? '').trim();
  if (!identifier) {
    render('未找到该本机账号，请手动输入手机号或邮箱。');
    return;
  }

  const result = loginWithLocalState(state, {
    identifier,
    displayName
  });

  if (!result.ok) {
    render(result.error);
    return;
  }

  await finishAccountLogin(result, '已使用本机保存账号登录。');
}

async function handleLogout() {
  await accountSaveQueue.catch(() => undefined);
  recorderController = null;
  feynmanRecorderController = null;
  voiceState.status = 'idle';
  voiceState.text = '';
  voiceState.engine = '';
  voiceState.error = '';
  feynmanVoiceState.status = 'idle';
  feynmanVoiceState.error = '';
  resetAiLearningState();
  state = saveAppState(logoutWithLocalState(state));
  databaseState.status = 'idle';
  databaseState.error = '';
  render('已退出登录。');
}

function getDatabaseStatusLabel() {
  const labels = {
    idle: '未连接',
    connecting: '连接中',
    saving: '保存中',
    synced: '已保存',
    error: '保存异常'
  };
  return labels[databaseState.status] || labels.idle;
}

async function synchronizeCurrentAccountOnStartup() {
  const payload = buildAccountPayload(state);
  if (!payload) return;

  databaseState.status = 'connecting';
  databaseState.error = '';
  render('正在连接本地数据库...');
  try {
    const result = await loginLocalAccount(payload);
    state = saveAppState(normalizeRuntimeState(mergeAccountState(state, result.accountState)));
    const remoteLearningReviews = Array.isArray(result.accountState?.learningReviews)
      ? result.accountState.learningReviews
      : [];
    const localLearningReviews =
      extractAccountState(state, state.currentUserId)?.learningReviews ?? [];
    databaseState.status = 'synced';
    databaseState.revision = result.revision ?? null;
    databaseState.updatedAt = result.updatedAt ?? null;
    if (JSON.stringify(localLearningReviews) !== JSON.stringify(remoteLearningReviews)) {
      await queueAccountSave(state);
    }
    databaseState.status = 'synced';
    maybeTriggerReminder();
    maybeTriggerAutoExport();
    render(result.created ? '现有记录已迁移到本地数据库。' : '已从本地数据库恢复记录。');
  } catch (error) {
    databaseState.status = 'error';
    databaseState.error = error?.message || '本地数据库连接失败。';
    maybeTriggerReminder();
    maybeTriggerAutoExport();
    render('本地数据库暂时不可用，当前记录仍保存在浏览器。');
  }
}

function resetAiLearningState() {
  aiLearningState.status = 'idle';
  aiLearningState.error = '';
  aiLearningState.evaluation = null;
  aiLearningState.basis = null;
  aiLearningState.model = '';
  aiLearningState.reviewTask = null;
  aiLearningState.pendingSave = null;
  aiLearningState.saveStatus = 'idle';
  aiLearningState.textbookStatus = 'idle';
  aiLearningState.textbookError = '';
  aiLearningState.textbooks = [];
  aiLearningState.contextKey = '';
  aiLearningState.draft = {
    subject: '数学',
    topic: '',
    explanation: ''
  };
}

async function handleStartRecording() {
  if (voiceState.status === 'recording' || voiceState.status === 'processing') {
    return;
  }

  voiceState.error = '';
  voiceState.text = '';
  voiceState.engine = '';
  voiceState.status = 'recording';
  render();

  try {
    recorderController = await startAudioRecording();
    render('已开始录音。');
  } catch (error) {
    recorderController = null;
    voiceState.status = 'idle';
    voiceState.error = error?.message || '启动录音失败';
    render();
  }
}

async function handleStopRecording() {
  if (!recorderController || voiceState.status !== 'recording') {
    return;
  }

  voiceState.status = 'processing';
  voiceState.error = '';
  render();

  try {
    const blob = await recorderController.stop();
    recorderController = null;
    const result = await postAudioForTranscription(blob);
    voiceState.status = 'done';
    voiceState.text = result.text || '';
    voiceState.engine = result.engine || '';
    render('语音转写完成。');
  } catch (error) {
    recorderController = null;
    voiceState.status = 'idle';
    voiceState.error = error?.message || '转写失败';
    render();
  }
}

function maybeTriggerReminder() {
  if (!getCurrentUser()) {
    return;
  }

  const reminder = getReminderConfig();
  const now = new Date();
  const evaluation = evaluateReminder(reminder, now);
  if (!evaluation.shouldNotify) {
    return;
  }

  const nextReminder = {
    ...reminder,
    lastNotifiedAt: now.toISOString()
  };
  state = saveRuntimeState({
    ...state,
    reminder: nextReminder
  });

  const notice = '提醒：该整理并导出当前周期错题本了。';
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('错题本提醒', { body: notice });
  }
  render(notice);
}

function handleReminderSave(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const nextReminder = normalizeReminder({
    enabled: form.get('enabled') === 'on',
    cycle: form.get('cycle'),
    weekday: Number(form.get('weekday')),
    dayOfMonth: Number(form.get('dayOfMonth')),
    time: form.get('time'),
    lastNotifiedAt: state.reminder?.lastNotifiedAt ?? null
  });

  state = saveRuntimeState({
    ...state,
    reminder: nextReminder
  });

  render('提醒设置已保存。');
}

async function handleNotificationPermission() {
  if (typeof Notification === 'undefined') {
    render('当前浏览器不支持系统通知。');
    return;
  }

  if (Notification.permission === 'granted') {
    render('系统通知已开启。');
    return;
  }

  const permission = await Notification.requestPermission();
  render(
    permission === 'granted' ? '系统通知授权成功。' : '未授权系统通知，仍可使用站内提醒。'
  );
}

function formatDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getChildrenForCurrentUser() {
  const user = getCurrentUser();
  if (!user) return [];
  return listChildrenByUser(state, user.id);
}

function getCurrentChild() {
  const user = getCurrentUser();
  if (!user) return null;
  return resolveCurrentChildForUser(state, user.id);
}

function handleCreateChild(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const selectedSubjects = form.getAll('subjects').map((item) => String(item));
  const result = createChildProfile(
    state,
    user.id,
    {
      name: form.get('name'),
      grade: form.get('grade'),
      stage: form.get('stage'),
      subjects: selectedSubjects
    },
    new Date()
  );

  if (!result.ok) {
    render(result.error);
    return;
  }

  state = saveRuntimeState(result.state);
  uiState.activeWorkspace = 'notebook';
  resetAiLearningState();
  render(`孩子档案已创建：${result.child.name}。现在可以上传教材并开始讲给 AI 听。`);
  void refreshTextbooksForCurrentChild();
}

function handleSwitchChild(event) {
  const user = getCurrentUser();
  if (!user) {
    return;
  }
  const result = setCurrentChildForUser(state, user.id, event.target.value);
  if (!result.ok) {
    render(result.error);
    return;
  }
  state = saveRuntimeState(result.state);
  uiState.listVisibleCount = MISTAKE_LIST_PAGE_SIZE;
  uiState.selectedMistakeId = null;
  uiState.editingMistakeId = null;
  resetAiLearningState();
  render('已切换当前孩子。');
  if (uiState.activeWorkspace === 'notebook') {
    void refreshTextbooksForCurrentChild();
  }
}

function summarizeDuplicateCandidates(candidates) {
  return candidates
    .slice(0, 3)
    .map((item, index) => {
      const score = Math.round(item.score * 100);
      const preview = String(item.record.originalQuestion ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 24);
      return `${index + 1}. ${item.record.recordDate} ${item.record.subject}/${item.record.category} 相似度 ${score}%：${preview}${preview.length >= 24 ? '...' : ''}`;
    })
    .join('\n');
}

function resolveDuplicateDecision(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { shouldSave: true, relatedMistakeId: null };
  }

  const top = candidates[0];
  const summary = summarizeDuplicateCandidates(candidates);
  const shouldLink =
    typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm(
          `检测到可能重复错题：\n${summary}\n\n点击“确定”：关联第 1 条历史错题并保存。\n点击“取消”：进入下一步选择。`
        );
  if (shouldLink) {
    return { shouldSave: true, relatedMistakeId: top.id };
  }

  const shouldSaveAsNew =
    typeof window === 'undefined' || typeof window.confirm !== 'function'
      ? true
      : window.confirm(
          '将按“新错题”保存，不做关联。\n点击“确定”：继续保存。\n点击“取消”：返回编辑，不保存。'
        );
  if (!shouldSaveAsNew) {
    return { shouldSave: false, relatedMistakeId: null };
  }

  return { shouldSave: true, relatedMistakeId: null };
}

function handleCreateMistake(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const categoryMode = String(form.get('categoryMode') ?? '');
  const customCategory = String(form.get('categoryCustom') ?? '').trim();
  const resolvedCategory =
    categoryMode === '__custom__' ? customCategory || '未分类' : categoryMode || '未分类';

  const payload = {
    childId: form.get('childId'),
    recordDate: form.get('recordDate'),
    subject: form.get('subject'),
    category: resolvedCategory,
    originalQuestion: form.get('originalQuestion'),
    wrongAnswer: form.get('wrongAnswer'),
    correctAnswer: form.get('correctAnswer'),
    analysis: form.get('analysis'),
    reviewTip: form.get('reviewTip'),
    source: form.get('source'),
    status: form.get('status'),
    tags: form.get('tags')
  };
  const childId = String(payload.childId ?? '').trim();
  const duplicateCandidates = childId
    ? detectPotentialDuplicateMistakes(state, user.id, childId, payload, {
        maxCount: 3
      })
    : [];
  const duplicateDecision = resolveDuplicateDecision(duplicateCandidates);
  if (!duplicateDecision.shouldSave) {
    render('已取消保存，请继续编辑后再提交。');
    return;
  }

  const result = createMistakeRecord(
    state,
    user.id,
    {
      ...payload,
      relatedMistakeId: duplicateDecision.relatedMistakeId
    },
    new Date()
  );

  if (!result.ok) {
    render(result.error);
    return;
  }

  state = saveRuntimeState(result.state);
  uiState.mistakeSubject = String(form.get('subject') ?? '语文');
  uiState.mistakeCategory = resolvedCategory;
  render(
    duplicateDecision.relatedMistakeId
      ? '错题已保存，并已关联历史错题。'
      : '错题已保存到本地错题本。'
  );
}

function handleApplyVoiceResult() {
  const text = String(voiceState.text ?? '').trim();
  const field = document.getElementById('mistake-original-question');
  if (!field) {
    return;
  }
  if (!text) {
    setStatusNotice('暂无语音转写结果可回填。');
    return;
  }
  if (field.value.trim()) {
    field.value = `${field.value.trim()}\n${text}`;
  } else {
    field.value = text;
  }
  setStatusNotice('已将语音转写内容回填到原题内容。');
}

function handleGenerateOcrDraft() {
  const rawField = document.getElementById('ocr-raw-text');
  if (!rawField) {
    return;
  }
  const result = createOcrDraftFromText(rawField.value, new Date());
  if (!result.ok) {
    render(result.error);
    return;
  }

  const draft = result.draft;
  const subjectField = document.getElementById('mistake-subject');
  const sourceField = document.getElementById('mistake-source');
  const dateField = document.getElementById('mistake-record-date');
  const originalField = document.getElementById('mistake-original-question');

  if (subjectField) {
    subjectField.value = draft.subject;
    uiState.mistakeSubject = draft.subject;
    uiState.mistakeCategory = draft.category;
    resetCategoryOptionsBySubject(draft.subject, draft.category);
  }
  if (sourceField) sourceField.value = draft.source;
  if (dateField) dateField.value = draft.recordDate;
  if (originalField) originalField.value = draft.originalQuestion;

  setStatusNotice('已根据 OCR 原文生成错题草稿，请检查后保存。');
}

async function handleRunImageOcr() {
  const imageInput = document.getElementById('ocr-image-input');
  const runButton = document.getElementById('run-ocr-button');
  const engineHint = document.getElementById('ocr-engine-hint');
  const rawField = document.getElementById('ocr-raw-text');

  if (!imageInput || !runButton || !rawField) {
    return;
  }

  const file = imageInput.files?.[0];
  if (!file) {
    setStatusNotice('请先选择一张图片后再识别。');
    return;
  }

  runButton.disabled = true;
  const previousText = runButton.textContent;
  runButton.textContent = 'OCR 识别中...';
  setStatusNotice(`正在识别：${file.name}`);

  try {
    const result = await postImageForOcr(file);
    rawField.value = result.text || '';
    const inferredDate = inferRecordDateFromImageMetadata(file);
    if (inferredDate) {
      const recordDateField = document.getElementById('mistake-record-date');
      if (recordDateField) {
        const shouldApply =
          typeof window === 'undefined' || typeof window.confirm !== 'function'
            ? true
            : window.confirm(`检测到图片日期为 ${inferredDate}，是否填入错题记录日期？`);
        if (shouldApply) {
          recordDateField.value = inferredDate;
        }
      }
    }
    if (engineHint) {
      const lineCount = Array.isArray(result.lines) ? result.lines.length : 0;
      engineHint.textContent = `OCR 引擎：${result.engine || 'unknown'}${lineCount ? `，识别行数：${lineCount}` : ''}${inferredDate ? `，图片日期推断：${inferredDate}` : ''}`;
    }
    setStatusNotice('图片 OCR 识别完成，已填入 OCR 原文。');
  } catch (error) {
    setStatusNotice(error?.message || 'OCR 识别失败。');
  } finally {
    runButton.disabled = false;
    runButton.textContent = previousText || '上传图片并识别';
  }
}

function renderChildrenOptions(children, selectedChildId) {
  if (children.length === 0) {
    return '<option value="">请先创建孩子档案</option>';
  }
  return children
    .map(
      (child) =>
        `<option value="${child.id}" ${child.id === selectedChildId ? 'selected' : ''}>${child.name}（${child.grade}）</option>`
    )
    .join('');
}

function renderGradeOptions(selectedGrade = '一年级') {
  return ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级']
    .map(
      (grade) =>
        `<option value="${grade}" ${grade === selectedGrade ? 'selected' : ''}>${grade}</option>`
    )
    .join('');
}

function renderChildProfileForm() {
  return `<form id="child-form" class="form-grid top-gap">
    <div class="two-col-grid">
      <label>
        孩子姓名或昵称
        <input name="name" type="text" placeholder="例如 小明" required />
      </label>
      <label>
        年级
        <select name="grade">${renderGradeOptions()}</select>
      </label>
    </div>
    <input name="stage" type="hidden" value="小学" />
    <fieldset class="fieldset-inline">
      <legend>学习科目</legend>
      <label class="checkbox-line"><input type="checkbox" name="subjects" value="语文" checked />语文</label>
      <label class="checkbox-line"><input type="checkbox" name="subjects" value="数学" checked />数学</label>
      <label class="checkbox-line"><input type="checkbox" name="subjects" value="英语" checked />英语</label>
    </fieldset>
    <button type="submit">建立孩子档案</button>
  </form>`;
}

function renderTextbookEvidence(evidence, title = '教材原文证据') {
  const items = Array.isArray(evidence) ? evidence : [];
  if (items.length === 0) return '';
  return `<section class="textbook-evidence">
    <h3>${escapeHtml(title)}</h3>
    <ol>
      ${items
        .map(
          (item) => `<li>
            <strong>${escapeHtml(item.filename || '教材')} · 第 ${escapeHtml(item.page || 1)} 页</strong>
            <blockquote>${escapeHtml(item.excerpt || '')}</blockquote>
          </li>`
        )
        .join('')}
    </ol>
  </section>`;
}

function renderReviewPointList(items) {
  const points = Array.isArray(items) ? items.filter(Boolean) : [];
  if (points.length === 0) return '';
  return `<ul class="compact-list">${points
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</ul>`;
}

function renderAiEvaluationResult(evaluation, basis, reviewTask, saveStatus = 'idle') {
  if (!evaluation) return '';
  const isSaved = saveStatus === 'saved';
  const list = (items, emptyText) =>
    items.length > 0
      ? `<ul class="compact-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : `<p class="hint">${emptyText}</p>`;
  return `<section class="ai-evaluation-result" aria-live="polite">
    <div class="ai-score-head">
      <div class="ai-total-score"><strong>${escapeHtml(evaluation.totalScore)}</strong><span>综合得分</span></div>
      <div>
        <h3>${escapeHtml(evaluation.summary || 'AI 已完成教材对照评估')}</h3>
        <p class="hint">${escapeHtml(basis?.label || '本次评分依据已记录。')}</p>
      </div>
    </div>
    <div class="ai-dimension-grid">
      <span>知识准确 <strong>${escapeHtml(evaluation.dimensions.accuracy)}</strong></span>
      <span>内容完整 <strong>${escapeHtml(evaluation.dimensions.completeness)}</strong></span>
      <span>表达清楚 <strong>${escapeHtml(evaluation.dimensions.clarity)}</strong></span>
      <span>能教会人 <strong>${escapeHtml(evaluation.dimensions.teaching)}</strong></span>
    </div>
    ${
      basis?.mode === 'textbook'
        ? renderTextbookEvidence(basis.evidence)
        : '<section class="textbook-evidence"><h3>评分依据</h3><p class="hint">本次没有可靠命中教材，因此没有展示教材原文，评分使用通用知识。</p></section>'
    }
    ${
      reviewTask
        ? `<section class="learning-route ${reviewTask.status === '已掌握' ? 'is-mastered' : 'needs-review'}">
            <div>
              <p class="eyebrow">本次学习状态</p>
              <h3>${
                reviewTask.status === '已掌握'
                  ? isSaved
                    ? '已保存为已掌握'
                    : '保存后记录为已掌握'
                  : isSaved
                    ? '已加入待复习'
                    : '保存后加入待复习'
              }</h3>
            </div>
            <strong>${escapeHtml(reviewTask.mastery)} · ${escapeHtml(reviewTask.aiScore)} 分</strong>
          </section>`
        : ''
    }
    ${
      reviewTask
        ? `<section class="review-points">
            <h3>需要复习的要点</h3>
            ${
              reviewTask.reviewPoints?.length
                ? list(reviewTask.reviewPoints, '')
                : '<p class="hint">本次已达到掌握标准，没有需要加入复习队列的要点。</p>'
            }
          </section>`
        : ''
    }
    <div class="ai-feedback-grid">
      <section>
        <h3>已经讲明白</h3>
        ${list(evaluation.understood, '这次还没有识别出稳定掌握的部分。')}
      </section>
      <section>
        <h3>没讲明白</h3>
        ${list(evaluation.unclear, '没有发现明显讲错或遗漏。')}
      </section>
      <section>
        <h3>还不熟</h3>
        ${list(evaluation.unfamiliar, '没有发现明显不熟练的部分。')}
      </section>
    </div>
    <section class="ai-teach-better">
      <h3>如果教别人，可以这样讲</h3>
      <p>${escapeHtml(evaluation.teachBetter || '继续用自己的话，加上一个具体例子。')}</p>
    </section>
    <section class="ai-follow-up">
      <p class="eyebrow">AI 学生还有一个问题</p>
      <h3>${escapeHtml(evaluation.followUpQuestion || '你能再举一个不同的例子吗？')}</h3>
    </section>
    ${
      reviewTask
        ? `<div class="evaluation-save-bar">
            <p class="hint">${
              reviewTask.status === '已掌握'
                ? '保存到当前孩子的学习记录。'
                : `保存后将 ${reviewTask.reviewPoints.length} 个要点加入当前孩子的待复习。`
            }</p>
            <button type="button" id="save-feynman-evaluation-button" ${isSaved ? 'disabled' : ''}>${isSaved ? '已保存' : '保存本次结果'}</button>
          </div>`
        : ''
    }
  </section>`;
}

function renderSubjectOptions(selectedSubject = '语文') {
  return getSubjectOptions()
    .map(
      (subject) =>
        `<option value="${subject}" ${subject === selectedSubject ? 'selected' : ''}>${subject}</option>`
    )
    .join('');
}

function renderCategoryOptions(subject, selectedCategory = '') {
  const categoryOptions = getCategoryOptionsBySubject(subject);
  const useCustom = selectedCategory && !categoryOptions.includes(selectedCategory);
  return [
    ...categoryOptions.map(
      (category) =>
        `<option value="${category}" ${selectedCategory === category ? 'selected' : ''}>${category}</option>`
    ),
    `<option value="__custom__" ${useCustom ? 'selected' : ''}>自定义</option>`
  ].join('');
}

function renderSourceOptions(selectedSource = 'manual') {
  const labelMap = {
    manual: '手动输入',
    voice: '口述转写',
    photo: '照片/OCR'
  };
  return getSourceOptions()
    .map(
      (source) =>
        `<option value="${source}" ${source === selectedSource ? 'selected' : ''}>${labelMap[source]}</option>`
    )
    .join('');
}

function renderReviewStatusOptions(selectedStatus = '未复习') {
  return getReviewStatusOptions()
    .map(
      (status) =>
        `<option value="${status}" ${status === selectedStatus ? 'selected' : ''}>${status}</option>`
    )
    .join('');
}

function renderFeynmanMasteryOptions(selectedValue = '不熟', includeAll = false) {
  const options = includeAll
    ? [`<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部掌握度</option>`]
    : [];
  return [
    ...options,
    ...getFeynmanMasteryOptions().map(
      (mastery) =>
        `<option value="${mastery}" ${mastery === selectedValue ? 'selected' : ''}>${mastery}</option>`
    )
  ].join('');
}

function renderNotebookSubjectOptions(selectedValue = 'all') {
  return [
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部学科</option>`,
    ...getSubjectOptions().map(
      (subject) =>
        `<option value="${subject}" ${selectedValue === subject ? 'selected' : ''}>${subject}</option>`
    )
  ].join('');
}

function renderListFilterSubjectOptions(selectedValue = 'all') {
  return [
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部学科</option>`,
    ...getSubjectOptions().map(
      (subject) =>
        `<option value="${subject}" ${selectedValue === subject ? 'selected' : ''}>${subject}</option>`
    )
  ].join('');
}

function renderListFilterStatusOptions(selectedValue = 'all') {
  return [
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部状态</option>`,
    ...getReviewStatusOptions().map(
      (status) =>
        `<option value="${status}" ${selectedValue === status ? 'selected' : ''}>${status}</option>`
    )
  ].join('');
}

function renderListFilterChildOptions(children, currentChildId, selectedValue = 'current') {
  const options = [
    `<option value="current" ${selectedValue === 'current' ? 'selected' : ''}>当前孩子</option>`,
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部孩子</option>`
  ];

  children.forEach((child) => {
    const shouldSelect = selectedValue === child.id;
    options.push(
      `<option value="${child.id}" ${shouldSelect ? 'selected' : ''}>${child.name}（${child.grade}）</option>`
    );
  });

  return options.join('');
}

function renderAutoExportTargetOptions(children, currentChildId, selectedValue = 'current') {
  const options = [
    `<option value="current" ${selectedValue === 'current' ? 'selected' : ''}>当前孩子</option>`,
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部孩子</option>`
  ];
  children.forEach((child) => {
    const shouldSelect = selectedValue === child.id;
    options.push(
      `<option value="${child.id}" ${shouldSelect ? 'selected' : ''}>${child.name}（${child.grade}）</option>`
    );
  });
  return options.join('');
}

function renderWeakPointScopeOptions(selectedValue = 'current') {
  return [
    `<option value="current" ${selectedValue === 'current' ? 'selected' : ''}>当前孩子</option>`,
    `<option value="all" ${selectedValue === 'all' ? 'selected' : ''}>全部孩子</option>`
  ].join('');
}

function renderAutoExportFormatOptions(selectedValue = 'pdf') {
  const options = [
    ['txt', 'TXT'],
    ['markdown', 'Markdown'],
    ['pdf', 'PDF']
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selectedValue === value ? 'selected' : ''}>${label}</option>`
    )
    .join('');
}

function renderTemplateOptions(selectedValue = 'compact') {
  const options = [
    ['compact', '简洁打印版'],
    ['detailed', '详细讲解版']
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}" ${selectedValue === value ? 'selected' : ''}>${label}</option>`
    )
    .join('');
}

function syncCategoryInputVisibility() {
  const categorySelect = document.getElementById('mistake-category-select');
  const customWrap = document.getElementById('mistake-category-custom-wrap');
  const customInput = document.getElementById('mistake-category-custom');
  if (!categorySelect || !customWrap || !customInput) {
    return;
  }

  const useCustom = categorySelect.value === '__custom__';
  customWrap.style.display = useCustom ? '' : 'none';
  customInput.required = useCustom;
}

function resetCategoryOptionsBySubject(subject, selectedCategory = '') {
  const categorySelect = document.getElementById('mistake-category-select');
  const customInput = document.getElementById('mistake-category-custom');
  if (!categorySelect || !customInput) {
    return;
  }

  categorySelect.innerHTML = renderCategoryOptions(subject, selectedCategory);
  const categoryOptions = getCategoryOptionsBySubject(subject);
  if (selectedCategory && !categoryOptions.includes(selectedCategory)) {
    customInput.value = selectedCategory;
  } else if (!selectedCategory) {
    customInput.value = '';
  }
  syncCategoryInputVisibility();
}

function handleMistakeSubjectChange(event) {
  const subject = event.target.value;
  uiState.mistakeSubject = subject;
  const defaultCategory = getCategoryOptionsBySubject(subject)[0] ?? '未分类';
  uiState.mistakeCategory = defaultCategory;
  resetCategoryOptionsBySubject(subject, defaultCategory);
}

function handleMistakeCategoryChange(event) {
  const value = event.target.value;
  if (value !== '__custom__') {
    uiState.mistakeCategory = value;
  }
  syncCategoryInputVisibility();
}

function getCurrentListFilters() {
  return {
    startDate: uiState.listFilterStartDate,
    endDate: uiState.listFilterEndDate,
    childId: uiState.listFilterChildId,
    subject: uiState.listFilterSubject,
    category: uiState.listFilterCategory,
    status: uiState.listFilterStatus,
    tag: uiState.listFilterTag
  };
}

function getReviewPriority(status) {
  if (status === '需再次复习') return 0;
  if (status === '未复习') return 1;
  if (status === '已复习') return 2;
  if (status === '已掌握') return 3;
  return 4;
}

function getReviewPracticeMistakes(userId, childId) {
  if (!childId) {
    return [];
  }
  return filterMistakesForUser(state, userId, { childId })
    .filter((item) => item.status === '未复习' || item.status === '需再次复习')
    .slice()
    .sort((a, b) => {
      const priorityDiff = getReviewPriority(a.status) - getReviewPriority(b.status);
      if (priorityDiff !== 0) return priorityDiff;
      const reviewDiff = Number(a.reviewCount || 0) - Number(b.reviewCount || 0);
      if (reviewDiff !== 0) return reviewDiff;
      const dateCompare = String(a.lastReviewedAt || '').localeCompare(String(b.lastReviewedAt || ''));
      if (dateCompare !== 0) return dateCompare;
      return String(a.recordDate || '').localeCompare(String(b.recordDate || ''));
    });
}

function findRememberedReviewSession(userId, childId) {
  return (state.reviewSessions || [])
    .filter((session) => session.userId === userId && session.childId === childId && !session.completedAt)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] ?? null;
}

function handleListFilterSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  uiState.listFilterStartDate = String(form.get('startDate') ?? '').trim();
  uiState.listFilterEndDate = String(form.get('endDate') ?? '').trim();
  uiState.listFilterChildId = String(form.get('childId') ?? 'current').trim() || 'current';
  uiState.listFilterSubject = String(form.get('subject') ?? 'all').trim() || 'all';
  uiState.listFilterCategory = String(form.get('category') ?? '').trim();
  uiState.listFilterStatus = String(form.get('status') ?? 'all').trim() || 'all';
  uiState.listFilterTag = String(form.get('tag') ?? '').trim();
  uiState.listVisibleCount = MISTAKE_LIST_PAGE_SIZE;
  uiState.selectedMistakeId = null;
  uiState.editingMistakeId = null;
  render('已应用筛选条件。');
}

function handleListFilterReset() {
  uiState.listFilterStartDate = '';
  uiState.listFilterEndDate = '';
  uiState.listFilterChildId = 'current';
  uiState.listFilterSubject = 'all';
  uiState.listFilterCategory = '';
  uiState.listFilterStatus = 'all';
  uiState.listFilterTag = '';
  uiState.listVisibleCount = MISTAKE_LIST_PAGE_SIZE;
  uiState.selectedMistakeId = null;
  uiState.editingMistakeId = null;
  render('已重置筛选条件。');
}

function handleLoadMoreMistakes() {
  uiState.listVisibleCount += MISTAKE_LIST_PAGE_SIZE;
  render('已加载更多错题。');
}

function handleCollapseMistakes() {
  uiState.listVisibleCount = MISTAKE_LIST_PAGE_SIZE;
  render(`已收起列表，仅显示前 ${MISTAKE_LIST_PAGE_SIZE} 条。`);
}

function handleOpenMistakeDetail(event) {
  const mistakeId = String(event.currentTarget?.dataset?.mistakeId ?? '').trim();
  if (!mistakeId) {
    return;
  }
  uiState.activeWorkspace = 'review';
  uiState.selectedMistakeId = mistakeId;
  uiState.editingMistakeId = null;
  render();
}

function handleCloseMistakeDetail() {
  uiState.selectedMistakeId = null;
  uiState.editingMistakeId = null;
  render();
}

function handleStartEditMistake(event) {
  const mistakeId = String(event.currentTarget?.dataset?.mistakeId ?? '').trim();
  if (!mistakeId) {
    return;
  }
  uiState.activeWorkspace = 'review';
  uiState.selectedMistakeId = mistakeId;
  uiState.editingMistakeId = mistakeId;
  render();
}

function handleSwitchWorkspace(event) {
  const workspace = String(event.currentTarget?.dataset?.workspace ?? '').trim();
  if (!workspace) {
    return;
  }
  uiState.activeWorkspace = workspace;
  if (workspace === 'insight') {
    const user = getCurrentUser();
    if (user) {
      const result = recordWeakPointView(state, {
        userId: user.id,
        scope: uiState.weakPointScope,
        now: new Date()
      });
      state = saveRuntimeState(result.state);
    }
  }
  render();
  if (workspace === 'notebook' && aiLearningState.contextKey !== getAiLearningContextKey()) {
    void refreshTextbooksForCurrentChild();
  }
}

function handleResumeLearningReview(event) {
  const user = getCurrentUser();
  const child = getCurrentChild();
  const taskId = String(event.currentTarget?.dataset?.taskId ?? '').trim();
  const task = (state.learningReviews || []).find(
    (item) =>
      item.id === taskId &&
      item.userId === user?.id &&
      item.childId === child?.id &&
      item.status === '需再次复习'
  );
  if (!task) {
    render('没有找到这条知识复习任务。');
    return;
  }

  resetAiLearningState();
  aiLearningState.draft = {
    subject: task.subject,
    topic: task.topic,
    explanation: ''
  };
  uiState.activeWorkspace = 'notebook';
  render('请让孩子重新讲一遍，AI 会更新这条知识点的掌握状态。');
  document.getElementById('feynman-explanation')?.focus();
  void refreshTextbooksForCurrentChild();
}

function handleCancelEditMistake() {
  uiState.editingMistakeId = null;
  render('已取消编辑。');
}

function handleQuickUpdateMistakeStatus(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const mistakeId = String(form.get('mistakeId') ?? '').trim();
  const status = String(form.get('status') ?? '').trim();
  const result = updateMistakeStatus(state, user.id, mistakeId, status, new Date());
  if (!result.ok) {
    writeAuditLog('mistake.status_update', 'failed', result.error);
    render(result.error);
    return;
  }

  state = saveRuntimeState(result.state);
  writeAuditLog('mistake.status_update', 'success', `${mistakeId} -> ${status}`);
  render(`错题状态已更新为“${status}”。`);
}

function handleStartReviewSession() {
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }
  const currentChild = resolveCurrentChildForUser(state, user.id);
  if (!currentChild) {
    render('请先创建孩子档案。');
    return;
  }
  const queue = getReviewPracticeMistakes(user.id, currentChild.id);
  if (queue.length === 0) {
    render('当前孩子没有需要复习的错题。');
    return;
  }

  const result = resumeOrCreateReviewSession(state, {
    userId: user.id,
    childId: currentChild.id,
    mistakeIds: queue.map((item) => item.id),
    now: new Date()
  });
  state = saveRuntimeState(result.state);
  uiState.activeWorkspace = 'review';
  uiState.activeReviewSessionId = result.session.id;
  uiState.selectedMistakeId = result.currentMistakeId;
  uiState.editingMistakeId = null;
  uiState.lastReviewResult = null;
  render(result.isNewSession ? '已开始复习。' : '已继续上次复习。');
}

function handleStopReviewSession() {
  const user = getCurrentUser();
  if (!user || !uiState.activeReviewSessionId) {
    render('没有正在进行的复习。');
    return;
  }
  const result = stopReviewSession(state, {
    userId: user.id,
    sessionId: uiState.activeReviewSessionId,
    now: new Date()
  });
  if (!result.ok) {
    render(result.error);
    return;
  }
  state = saveRuntimeState(result.state);
  uiState.lastReviewResult = null;
  render('已停止复习，进度已保留。');
}

function handleReviewAnswerSubmit(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const sessionId = String(form.get('sessionId') ?? '').trim();
  const mistakeId = String(form.get('mistakeId') ?? '').trim();
  const mistake = findMistakeByIdForUser(state, user.id, mistakeId);
  if (!mistake) {
    render('未找到要复习的错题。');
    return;
  }

  const result = submitReviewAnswer(state, {
    userId: user.id,
    sessionId,
    mistakeId,
    userAnswer: form.get('userAnswer'),
    processNote: form.get('processNote'),
    correctAnswer: mistake.correctAnswer,
    now: new Date()
  });
  if (!result.ok) {
    render(result.error);
    return;
  }

  let nextState = result.state;
  const concept = String(form.get('noteConcept') ?? '').trim();
  const stuckPoint = String(form.get('stuckPoint') ?? '').trim();
  const unfamiliarPoint = String(form.get('unfamiliarPoint') ?? '').trim();
  const teachBack = String(form.get('teachBack') ?? '').trim();
  if (stuckPoint || unfamiliarPoint || teachBack) {
    const noteResult = createFeynmanNote(
      nextState,
      user.id,
      {
        subject: mistake.subject,
        concept: concept || `${mistake.subject} · ${mistake.category}`,
        explainSimply: mistake.analysis || mistake.reviewTip || '',
        teachBack,
        stuckPoint,
        unfamiliarPoint,
        example: mistake.originalQuestion,
        relatedMistakeId: mistake.id,
        mastery: stuckPoint ? '不懂' : '不熟'
      },
      new Date()
    );
    if (noteResult.ok) {
      nextState = noteResult.state;
    }
  }

  state = saveRuntimeState(nextState);
  uiState.activeReviewSessionId = result.session.id;
  uiState.selectedMistakeId = result.nextMistakeId;
  uiState.editingMistakeId = null;
  uiState.lastReviewResult = {
    mistakeId,
    isCorrect: result.attempt.isCorrect,
    userAnswer: result.attempt.userAnswer,
    correctAnswer: result.attempt.correctAnswerSnapshot,
    nextMistakeId: result.nextMistakeId
  };
  writeAuditLog(
    'review.answer_submit',
    result.attempt.isCorrect ? 'success' : 'failed',
    `${mistakeId} -> ${result.attempt.isCorrect ? '正确' : '需再复习'}`
  );
  render(result.nextMistakeId ? '已提交，自动进入下一题。' : '本轮复习已完成。');
}

function handleEditMistakeSubmit(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const mistakeId = String(form.get('mistakeId') ?? '').trim();
  const result = updateMistakeRecord(
    state,
    user.id,
    mistakeId,
    {
      recordDate: form.get('recordDate'),
      subject: form.get('subject'),
      category: form.get('category'),
      originalQuestion: form.get('originalQuestion'),
      wrongAnswer: form.get('wrongAnswer'),
      correctAnswer: form.get('correctAnswer'),
      analysis: form.get('analysis'),
      reviewTip: form.get('reviewTip'),
      source: form.get('source'),
      status: form.get('status'),
      tags: form.get('tags')
    },
    new Date()
  );

  if (!result.ok) {
    writeAuditLog('mistake.edit', 'failed', result.error);
    render(result.error);
    return;
  }

  state = saveRuntimeState(result.state);
  uiState.selectedMistakeId = mistakeId;
  uiState.editingMistakeId = null;
  writeAuditLog('mistake.edit', 'success', `更新错题：${mistakeId}`);
  render('错题内容已更新。');
}

function handleWeakPointFormSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  uiState.weakPointScope = String(form.get('scope') ?? 'current').trim() || 'current';
  uiState.weakPointDays = String(form.get('days') ?? '90').trim() || '90';
  uiState.weakPointMinFrequency = String(form.get('minFrequency') ?? '2').trim() || '2';
  const user = getCurrentUser();
  if (user) {
    const result = recordWeakPointView(state, {
      userId: user.id,
      scope: uiState.weakPointScope,
      now: new Date()
    });
    state = saveRuntimeState(result.state);
  }
  render('薄弱点归纳已刷新。');
}

function getAiLearningContextKey() {
  const user = getCurrentUser();
  const child = getCurrentChild();
  return user && child ? `${user.id}:${child.id}` : '';
}

async function refreshTextbooksForCurrentChild() {
  const user = getCurrentUser();
  const child = getCurrentChild();
  if (!user || !child) return;
  const contextKey = getAiLearningContextKey();
  aiLearningState.contextKey = contextKey;
  aiLearningState.textbookStatus = 'loading';
  aiLearningState.textbookError = '';
  render();
  try {
    const textbooks = await listTextbooks({
      userId: user.id,
      childId: child.id,
      grade: child.grade
    });
    if (getAiLearningContextKey() !== contextKey) return;
    aiLearningState.textbooks = textbooks;
    aiLearningState.textbookStatus = 'ready';
    render();
  } catch (error) {
    if (getAiLearningContextKey() !== contextKey) return;
    aiLearningState.textbookStatus = 'error';
    aiLearningState.textbookError = error?.message || '教材列表加载失败。';
    render();
  }
}

function captureAiLearningDraft(form) {
  const data = new FormData(form);
  aiLearningState.draft = {
    subject: String(data.get('subject') || '数学'),
    topic: String(data.get('topic') || ''),
    explanation: String(data.get('explanation') || '')
  };
  return aiLearningState.draft;
}

async function handleUploadTextbook(event) {
  event.preventDefault();
  const user = getCurrentUser();
  const child = getCurrentChild();
  if (!user || !child) {
    render('请先建立孩子档案。');
    return;
  }
  const form = new FormData(event.currentTarget);
  const file = form.get('textbookFile');
  if (!(file instanceof File) || file.size === 0) {
    render('请选择 PDF、TXT 或 Markdown 教材。');
    return;
  }
  aiLearningState.textbookStatus = 'uploading';
  aiLearningState.textbookError = '';
  render();
  try {
    const result = await uploadTextbook({
      userId: user.id,
      childId: child.id,
      subject: form.get('subject'),
      grade: child.grade,
      file
    });
    aiLearningState.draft.subject = String(form.get('subject') || '数学');
    writeAuditLog('textbook.upload', 'success', `教材已添加：${result.textbook.filename}`);
    await refreshTextbooksForCurrentChild();
    render('教材已添加，AI 评估将只使用相关教材片段。');
  } catch (error) {
    aiLearningState.textbookStatus = 'error';
    aiLearningState.textbookError = error?.message || '教材上传失败。';
    render(aiLearningState.textbookError);
  }
}

async function handleStartFeynmanRecording() {
  if (feynmanVoiceState.status === 'recording' || feynmanVoiceState.status === 'processing') {
    return;
  }
  const form = document.getElementById('feynman-ai-form');
  if (form) captureAiLearningDraft(form);
  feynmanVoiceState.status = 'recording';
  feynmanVoiceState.error = '';
  const startButton = document.getElementById('feynman-start-recording-button');
  const stopButton = document.getElementById('feynman-stop-recording-button');
  const status = document.getElementById('feynman-voice-status');
  if (startButton) startButton.disabled = true;
  if (stopButton) stopButton.disabled = false;
  if (status) status.textContent = '正在听孩子讲...';
  try {
    feynmanRecorderController = await startAudioRecording();
  } catch (error) {
    feynmanRecorderController = null;
    feynmanVoiceState.status = 'idle';
    feynmanVoiceState.error = error?.message || '启动录音失败。';
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    if (status) status.textContent = feynmanVoiceState.error;
  }
}

async function handleStopFeynmanRecording() {
  if (!feynmanRecorderController || feynmanVoiceState.status !== 'recording') return;
  feynmanVoiceState.status = 'processing';
  const stopButton = document.getElementById('feynman-stop-recording-button');
  const startButton = document.getElementById('feynman-start-recording-button');
  const status = document.getElementById('feynman-voice-status');
  if (stopButton) stopButton.disabled = true;
  if (status) status.textContent = '正在整理刚才的讲解...';
  try {
    const blob = await feynmanRecorderController.stop();
    feynmanRecorderController = null;
    const result = await postAudioForTranscription(blob);
    const field = document.getElementById('feynman-explanation');
    if (field) {
      field.value = [field.value.trim(), String(result.text || '').trim()].filter(Boolean).join('\n');
      aiLearningState.draft.explanation = field.value;
    }
    feynmanVoiceState.status = 'done';
    if (status) status.textContent = '讲解已转成文字，可以继续补充或请 AI 评分。';
  } catch (error) {
    feynmanRecorderController = null;
    feynmanVoiceState.status = 'idle';
    feynmanVoiceState.error = error?.message || '语音转写失败。';
    if (status) status.textContent = feynmanVoiceState.error;
  } finally {
    if (startButton) startButton.disabled = false;
  }
}

async function handleEvaluateFeynmanExplanation(event) {
  event.preventDefault();
  const user = getCurrentUser();
  const child = getCurrentChild();
  if (!user || !child) {
    render('请先建立孩子档案。');
    return;
  }
  const draft = captureAiLearningDraft(event.currentTarget);
  if (!draft.topic.trim() || !draft.explanation.trim()) {
    render('请填写知识点和孩子的讲解。');
    return;
  }

  aiLearningState.status = 'processing';
  aiLearningState.error = '';
  aiLearningState.evaluation = null;
  aiLearningState.basis = null;
  aiLearningState.reviewTask = null;
  aiLearningState.pendingSave = null;
  aiLearningState.saveStatus = 'idle';
  render('AI 正在对照教材听讲和评分...');
  try {
    const result = await evaluateFeynmanExplanation({
      userId: user.id,
      childId: child.id,
      grade: child.grade,
      subject: draft.subject,
      topic: draft.topic,
      explanation: draft.explanation,
      textbookId: ''
    });
    aiLearningState.status = 'done';
    aiLearningState.evaluation = result.evaluation;
    aiLearningState.basis = result.basis || null;
    aiLearningState.model = result.model || '';
    const score = Number(result.evaluation.totalScore || 0);
    const mastery = resolveFeynmanMastery(score);
    const reviewPoints = buildFeynmanReviewPoints(result.evaluation, score);
    const basisName =
      result.basis?.label || result.textbook?.filename || '通用知识评估';
    const evaluatedAt = new Date();
    const taskInput = {
      childId: child.id,
      subject: draft.subject,
      topic: draft.topic,
      explanation: draft.explanation,
      score,
      unclear: result.evaluation.unclear.join('；'),
      unfamiliar: result.evaluation.unfamiliar.join('；'),
      teachBetter: result.evaluation.teachBetter,
      followUpQuestion: result.evaluation.followUpQuestion,
      reviewPoints,
      evidence: result.basis?.evidence
    };
    const reviewTaskResult = upsertFeynmanReviewTask(
      state,
      user.id,
      taskInput,
      evaluatedAt
    );
    if (!reviewTaskResult.ok) {
      throw new Error(reviewTaskResult.error || '自动创建复习任务失败。');
    }
    aiLearningState.reviewTask = reviewTaskResult.task;
    aiLearningState.pendingSave = {
      userId: user.id,
      childId: child.id,
      evaluatedAt: evaluatedAt.toISOString(),
      draft: { ...draft },
      taskInput,
      noteInput: {
        childId: child.id,
        subject: draft.subject,
        concept: draft.topic,
        mastery,
        explainSimply: draft.explanation,
        stuckPoint: result.evaluation.unclear.join('；'),
        unfamiliarPoint: result.evaluation.unfamiliar.join('；'),
        teachBack: result.evaluation.teachBetter,
        example: result.evaluation.evidence.join('；'),
        aiScore: score,
        aiAssessment: result.evaluation,
        textbookId: result.textbook?.id || '',
        textbookName: basisName,
        textbookEvidence: result.basis?.evidence,
        reviewPoints
      }
    };
    aiLearningState.saveStatus = 'pending';
    render('AI 已完成评分并生成复习要点，请确认后保存。');
  } catch (error) {
    aiLearningState.status = 'error';
    aiLearningState.error = error?.message || 'AI 评估失败。';
    writeAuditLog('feynman.ai_evaluation', 'failed', aiLearningState.error);
    render(aiLearningState.error);
  }
}

function handleSaveFeynmanEvaluation() {
  const user = getCurrentUser();
  const child = getCurrentChild();
  const pending = aiLearningState.pendingSave;
  if (!user || !child || !pending) {
    render('当前没有可保存的 AI 评分结果。');
    return;
  }
  if (pending.userId !== user.id || pending.childId !== child.id) {
    resetAiLearningState();
    render('孩子档案已经切换，请重新讲解并评分。');
    return;
  }

  const form = document.getElementById('feynman-ai-form');
  const currentDraft = form ? captureAiLearningDraft(form) : aiLearningState.draft;
  const draftChanged = ['subject', 'topic', 'explanation'].some(
    (key) => String(currentDraft[key] || '').trim() !== String(pending.draft[key] || '').trim()
  );
  if (draftChanged) {
    aiLearningState.status = 'idle';
    aiLearningState.evaluation = null;
    aiLearningState.basis = null;
    aiLearningState.reviewTask = null;
    aiLearningState.pendingSave = null;
    aiLearningState.saveStatus = 'idle';
    render('讲解内容已修改，请重新请 AI 评分后再保存。');
    return;
  }

  const savedAt = new Date(pending.evaluatedAt);
  const reviewTaskResult = upsertFeynmanReviewTask(
    state,
    user.id,
    pending.taskInput,
    Number.isNaN(savedAt.getTime()) ? new Date() : savedAt
  );
  if (!reviewTaskResult.ok) {
    render(reviewTaskResult.error || '保存复习状态失败。');
    return;
  }
  const noteResult = createFeynmanNote(
    reviewTaskResult.state,
    user.id,
    {
      ...pending.noteInput,
      reviewTaskId: reviewTaskResult.task.id,
      reviewStatus: reviewTaskResult.status
    },
    Number.isNaN(savedAt.getTime()) ? new Date() : savedAt
  );
  if (!noteResult.ok) {
    render(noteResult.error || '保存学习记录失败。');
    return;
  }

  state = saveRuntimeState(noteResult.state);
  aiLearningState.reviewTask = reviewTaskResult.task;
  aiLearningState.pendingSave = null;
  aiLearningState.saveStatus = 'saved';
  writeAuditLog('feynman.ai_evaluation', 'success', `保存教材评估：${pending.draft.topic}`);
  render(
    reviewTaskResult.status === '已掌握'
      ? '已保存：本课记录为已掌握。'
      : `已保存：${reviewTaskResult.task.reviewPoints.length} 个要点已加入当前孩子的待复习。`
  );
}

function handleOpenChildManagement() {
  uiState.activeWorkspace = 'capture';
  render();
  const panel = document.getElementById('child-management-panel');
  if (panel) {
    panel.open = true;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function handleReviewFeynmanNote(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }
  const form = new FormData(event.currentTarget);
  const noteId = String(form.get('noteId') ?? '').trim();
  const result = recordFeynmanReview(
    state,
    user.id,
    noteId,
    {
      reviewText: form.get('reviewText'),
      mastery: form.get('mastery')
    },
    new Date()
  );
  if (!result.ok) {
    render(result.error);
    return;
  }

  state = saveRuntimeState(result.state);
  writeAuditLog('feynman_note.review', 'success', `复习笔记：${noteId}`);
  render('笔记复习记录已保存。');
}

function handleNotebookFilterSubmit(event) {
  event.preventDefault();
  const aiForm = document.getElementById('feynman-ai-form');
  if (aiForm) captureAiLearningDraft(aiForm);
  const form = new FormData(event.currentTarget);
  uiState.noteSubjectFilter = String(form.get('subject') ?? 'all').trim() || 'all';
  uiState.noteMasteryFilter = String(form.get('mastery') ?? 'all').trim() || 'all';
  render('笔记筛选已刷新。');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getCurrentExportRange() {
  return getDateRangeByCycle(uiState.exportCycle, new Date());
}

function shouldLockExportDateInputs() {
  return shouldDisableExportDateInputs(uiState.exportCycle);
}

function triggerDownload(blob, fileName) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function buildBackupSummary(stateLike) {
  return `账号 ${stateLike.users.length} 个、孩子 ${stateLike.children.length} 个、错题 ${stateLike.mistakes.length} 条、导出记录 ${stateLike.exports.length} 条`;
}

function handleExportBackup() {
  const now = new Date();
  const bundle = createBackupBundle(state, now);
  const text = serializeBackupBundle(bundle);
  const fileName = buildBackupFileName(now);
  triggerDownload(new Blob([text], { type: 'application/json;charset=utf-8' }), fileName);
  writeAuditLog('backup.export_json', 'success', `文件：${fileName}`, now);
  setStatusNotice(`备份已导出：${fileName}`);
}

async function handleImportBackup() {
  const fileInput = document.getElementById('backup-import-input');
  const importButton = document.getElementById('import-backup-button');
  if (!fileInput || !importButton) {
    return;
  }

  const file = fileInput.files?.[0];
  if (!file) {
    render('请先选择备份 JSON 文件。');
    return;
  }

  importButton.disabled = true;
  const previousText = importButton.textContent;
  importButton.textContent = '导入中...';

  try {
    const content = await file.text();
    const parsed = parseBackupBundleText(content);
    if (!parsed.ok) {
      writeAuditLog('backup.import_json', 'failed', parsed.error);
      render(parsed.error);
      return;
    }

    const summary = buildBackupSummary(parsed.state);
    const exportedAtText = parsed.meta.exportedAt
      ? new Date(parsed.meta.exportedAt).toLocaleString('zh-CN')
      : '未知';
    const confirmed = confirmDangerAction({
      actionLabel: '导入并恢复备份',
      summaryLines: [
        `版本：${parsed.meta.backupVersion}`,
        `导出时间：${exportedAtText}`,
        `备份内容：${summary}`,
        '注意：恢复会覆盖当前浏览器本地数据。'
      ]
    });
    if (!confirmed) {
      return;
    }

    recorderController = null;
    voiceState.status = 'idle';
    voiceState.text = '';
    voiceState.engine = '';
    voiceState.error = '';
    uiState.selectedMistakeId = null;

    state = saveRuntimeState(parsed.state);
    writeAuditLog('backup.import_json', 'success', `恢复成功：${summary}`);
    fileInput.value = '';
    render(`恢复成功：${summary}`);
  } catch (error) {
    writeAuditLog('backup.import_json', 'failed', error?.message || '导入异常');
    render(error?.message || '导入备份失败。');
  } finally {
    importButton.disabled = false;
    importButton.textContent = previousText || '导入并恢复';
  }
}

function handleDeleteMistake(event) {
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }
  const mistakeId = String(event.currentTarget?.dataset?.mistakeId ?? '').trim();
  if (!mistakeId) {
    render('缺少要删除的错题 ID。');
    return;
  }
  const target = findMistakeByIdForUser(state, user.id, mistakeId);
  if (!target) {
    writeAuditLog('mistake.delete', 'failed', `错题不存在：${mistakeId}`);
    render('要删除的错题不存在。');
    return;
  }

  const confirmed = confirmDangerAction({
    actionLabel: '删除错题',
    summaryLines: [
      `错题 ID：${target.id}`,
      `日期：${target.recordDate}`,
      `学科/类别：${target.subject}/${target.category}`,
      '删除后不可恢复（除非你有备份）。'
    ]
  });
  if (!confirmed) {
    return;
  }

  const result = deleteMistakeRecord(state, user.id, target.id, new Date());
  if (!result.ok) {
    writeAuditLog('mistake.delete', 'failed', result.error);
    render(result.error);
    return;
  }
  state = saveRuntimeState(result.state);
  uiState.selectedMistakeId = null;
  uiState.editingMistakeId = null;
  writeAuditLog('mistake.delete', 'success', `删除错题：${target.id}`);
  render(`错题已删除：${target.id}`);
}

function getChildByIdForUser(userId, childId) {
  return state.children.find((item) => item.userId === userId && item.id === childId) ?? null;
}

function resolveTargetChildIdsForExport(userId, targetChildId) {
  const children = listChildrenByUser(state, userId);
  if (children.length === 0) {
    return [];
  }

  const target = String(targetChildId ?? '').trim();
  if (target === 'all') {
    return children.map((item) => item.id);
  }
  if (target === 'current') {
    const current = children.find((item) => item.id === state.currentChildId) ?? children[0];
    return current ? [current.id] : [];
  }
  return children.some((item) => item.id === target) ? [target] : [];
}

function downloadByPayload(payload, format) {
  const fileName = buildExportFileName({
    childName: payload.child.name,
    from: payload.from,
    to: payload.to,
    format
  });
  if (format === 'pdf') {
    const bytes = generatePdfDocument(payload);
    triggerDownload(new Blob([bytes], { type: 'application/pdf' }), fileName);
  } else if (format === 'txt') {
    const text = generateTextDocument(payload);
    triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), fileName);
  } else {
    const markdown = generateMarkdownDocument(payload);
    triggerDownload(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), fileName);
  }
  return fileName;
}

function buildExportRecord({ userId, payload, format, template, source, cycle }) {
  const fileName = buildExportFileName({
    childName: payload.child.name,
    from: payload.from,
    to: payload.to,
    format
  });
  const options = payload.options ?? {};
  const excludeMastered = options.excludeMastered === true;
  const prioritizeNeedReview = options.prioritizeNeedReview !== false;
  return {
    id: `export_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    userId,
    childId: payload.child.id,
    childName: payload.child.name,
    from: payload.from,
    to: payload.to,
    format,
    template,
    cycle: cycle || 'custom',
    source: source || 'manual',
    excludeMastered,
    prioritizeNeedReview,
    createdAt: new Date().toISOString(),
    count: payload.mistakes.length,
    fileName
  };
}

function applyExportCycleToForm(formEl) {
  if (!formEl) return;
  const startInput = formEl.querySelector('input[name="startDate"]');
  const endInput = formEl.querySelector('input[name="endDate"]');
  const cycleSelect = formEl.querySelector('select[name="cycle"]');
  if (!startInput || !endInput || !cycleSelect) {
    return;
  }

  const cycle = normalizeExportCycle(cycleSelect.value);
  uiState.exportCycle = cycle;
  const range = resolveExportRangeForCycleChange(
    cycle,
    startInput.value,
    endInput.value,
    new Date()
  );
  startInput.value = range.startDate;
  endInput.value = range.endDate;
  startInput.disabled = shouldDisableExportDateInputs(cycle);
  endInput.disabled = shouldDisableExportDateInputs(cycle);
}

function handleExportCycleChange(event) {
  const form = event.currentTarget?.closest?.('form') ?? document.getElementById('export-form');
  applyExportCycleToForm(form);
  setStatusNotice(
    uiState.exportCycle === 'custom'
      ? '导出周期已切换为自定义。'
      : `导出周期已切换为${uiState.exportCycle === 'day' ? '按日' : uiState.exportCycle === 'week' ? '按周' : '按月'}。`
  );
}

function handleExportSubmit(event) {
  event.preventDefault();
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }

  const form = new FormData(event.currentTarget);
  const cycle = normalizeExportCycle(form.get('cycle'));
  uiState.exportCycle = cycle;
  const exportFormat = resolveExportFormat(form.get('exportFormat'), event.submitter?.value);
  const childId = String(form.get('childId') ?? '').trim();
  const template = String(form.get('template') ?? 'compact');
  const excludeMastered = form.get('excludeMastered') === 'on';
  const prioritizeNeedReview = form.get('prioritizeNeedReview') === 'on';
  uiState.exportExcludeMastered = excludeMastered;
  uiState.exportPrioritizeNeedReview = prioritizeNeedReview;
  const range = resolveExportRangeForSubmit(
    cycle,
    form.get('startDate'),
    form.get('endDate'),
    new Date()
  );
  const startDate = range.startDate;
  const endDate = range.endDate;

  const exportResult = buildExportPayload({
    state,
    userId: user.id,
    childId,
    startDate,
    endDate,
    template,
    excludeMastered,
    prioritizeNeedReview,
    now: new Date()
  });

  if (!exportResult.ok) {
    writeAuditLog('export.manual_download', 'failed', exportResult.error);
    render(exportResult.error);
    return;
  }

  const payload = exportResult.payload;
  const format = exportFormat;
  const fileName = downloadByPayload(payload, format);
  const exportRecord = buildExportRecord({
    userId: user.id,
    payload,
    format,
    template: payload.template,
    source: 'manual',
    cycle
  });
  exportRecord.fileName = fileName;

  state = saveRuntimeState({
    ...state,
    exports: [...state.exports, exportRecord]
  });
  const strategyText = `${excludeMastered ? '排除已掌握' : '包含已掌握'}，${
    prioritizeNeedReview ? '需再次复习优先' : '按日期排序'
  }`;
  writeAuditLog(
    'export.manual_download',
    'success',
    `${fileName}；${strategyText}；范围 ${payload.from}~${payload.to}`
  );
  render(`导出成功：${fileName}（${strategyText}）`);
}

function handleDownloadExportRecord(event) {
  const user = getCurrentUser();
  if (!user) {
    render('请先登录。');
    return;
  }
  const exportId = String(event.currentTarget?.dataset?.exportId ?? '').trim();
  if (!exportId) {
    return;
  }
  const record = state.exports.find((item) => item.id === exportId && item.userId === user.id);
  if (!record) {
    writeAuditLog('export.history_redownload', 'failed', `导出记录不存在：${exportId}`);
    render('导出记录不存在。');
    return;
  }
  const child = getChildByIdForUser(user.id, record.childId);
  if (!child) {
    writeAuditLog('export.history_redownload', 'failed', `孩子档案不存在：${record.childId}`);
    render('该导出记录对应的孩子档案不存在。');
    return;
  }
  const result = buildExportPayload({
    state,
    userId: user.id,
    childId: child.id,
    startDate: record.from,
    endDate: record.to,
    template: record.template,
    excludeMastered: record.excludeMastered === true,
    prioritizeNeedReview: record.prioritizeNeedReview !== false,
    now: new Date()
  });
  if (!result.ok) {
    writeAuditLog('export.history_redownload', 'failed', result.error);
    render(result.error);
    return;
  }
  downloadByPayload(result.payload, record.format);
  writeAuditLog(
    'export.history_redownload',
    'success',
    `${record.fileName}；范围 ${record.from}~${record.to}`
  );
  setStatusNotice(`已重新下载：${record.fileName}`);
}

function handleAutoExportSave(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const nextConfig = normalizeAutoExportConfig({
    enabled: form.get('enabled') === 'on',
    cycle: form.get('cycle'),
    time: form.get('time'),
    weekday: Number(form.get('weekday')),
    dayOfMonth: Number(form.get('dayOfMonth')),
    targetChildId: form.get('targetChildId'),
    template: form.get('template'),
    excludeMastered: form.get('excludeMastered') === 'on',
    prioritizeNeedReview: form.get('prioritizeNeedReview') === 'on',
    format: form.get('format'),
    lastGeneratedAt: state.autoExport?.lastGeneratedAt ?? null
  });
  state = saveRuntimeState({
    ...state,
    autoExport: nextConfig
  });
  writeAuditLog(
    'export.auto_config_save',
    'success',
    `周期 ${nextConfig.cycle}；目标 ${nextConfig.targetChildId}；格式 ${nextConfig.format}`
  );
  maybeTriggerAutoExport();
  render('自动导出设置已保存。');
}

function maybeTriggerAutoExport() {
  const user = getCurrentUser();
  if (!user) {
    return;
  }
  const config = getAutoExportConfig();
  const now = new Date();
  const evaluation = evaluateAutoExport(config, now);
  if (!evaluation.shouldGenerate) {
    return;
  }

  const targetChildIds = resolveTargetChildIdsForExport(user.id, config.targetChildId);
  const createdRecords = [];

  for (const childId of targetChildIds) {
    const result = buildExportPayload({
      state,
      userId: user.id,
      childId,
      ...getDateRangeByCycle(config.cycle, now),
      template: config.template,
      excludeMastered: config.excludeMastered === true,
      prioritizeNeedReview: config.prioritizeNeedReview !== false,
      now
    });
    if (!result.ok) {
      continue;
    }
    createdRecords.push(
      buildExportRecord({
        userId: user.id,
        payload: result.payload,
        format: config.format,
        template: config.template,
        source: 'auto',
        cycle: config.cycle
      })
    );
  }

  const nextState = {
    ...state,
    autoExport: {
      ...config,
      lastGeneratedAt: now.toISOString()
    }
  };

  if (createdRecords.length > 0) {
    nextState.exports = [...state.exports, ...createdRecords];
  }

  state = saveRuntimeState(nextState);
  writeAuditLog(
    'export.auto_generate',
    createdRecords.length > 0 ? 'success' : 'failed',
    createdRecords.length > 0 ? `自动生成 ${createdRecords.length} 份` : '到点但无可导出记录'
  );
  render(
    createdRecords.length > 0
      ? `已自动生成 ${createdRecords.length} 份导出记录，可在导出历史中下载。`
      : '已到自动导出时间，但没有可生成的导出记录。'
  );
}

function renderLoginForm(errorMessage) {
  const savedAccounts = listSavedLoginAccounts(state);
  const savedAccountPanel =
    savedAccounts.length === 0
      ? `<p class="hint top-gap">这个浏览器里暂时没有可识别的本机账号。请换回之前录错题时用的浏览器或浏览器配置文件。</p>`
      : `<section class="top-gap">
          <h4>本机已保存账号</h4>
          <p class="hint">如果忘记之前输入的是手机号还是邮箱，可以直接用下面的账号进入。</p>
          <div class="form-grid compact-grid">
            ${savedAccounts
              .map(
                (account) => `<button type="button" class="ghost saved-login-button" data-identifier="${escapeHtml(account.identifier)}" data-display-name="${escapeHtml(account.displayName)}">
                  ${escapeHtml(account.displayName)}｜${escapeHtml(account.identifier)}｜孩子 ${account.childCount}｜错题 ${account.mistakeCount}
                </button>`
              )
              .join('')}
          </div>
        </section>`;

  appEl.innerHTML = `
    <section class="auth-shell">
      <div class="auth-showcase">
        <p class="eyebrow">LOCAL-FIRST STUDY WORKSPACE</p>
        <h2>错题本</h2>
        <p class="hint">重启电脑后仍可继续使用，孩子和学习记录保存在本机数据库，不走云端。</p>
        <ul class="auth-points">
          <li>拍照 OCR + 语音转写 + 手动录入</li>
          <li>复习筛选、导出打印、自动提醒</li>
          <li>支持 JSON 备份与恢复</li>
        </ul>
      </div>
      <section class="auth-panel">
        <h3>登录本地错题本</h3>
        <p class="hint">手机号或邮箱均可，仅用于匹配这台电脑上的对应数据库。</p>
        ${errorMessage ? `<p class="error">${errorMessage}</p>` : ''}
        <form id="login-form" class="form-grid top-gap">
          <label>
            手机号或邮箱
          <input name="identifier" type="text" placeholder="手机号或 parent@example.com" required />
          </label>
          <label>
            家长昵称（可选）
            <input name="displayName" type="text" placeholder="例如 妈妈" />
          </label>
          <button type="submit">进入工作台</button>
        </form>
        ${savedAccountPanel}
      </section>
    </section>
  `;
  const loginForm = document.getElementById('login-form');
  loginForm?.addEventListener('submit', handleLogin);
  document.querySelectorAll('.saved-login-button').forEach((button) => {
    button.addEventListener('click', handleSavedAccountLogin);
  });
}

function renderWeekdayOptions(selectedValue) {
  const options = [
    ['1', '周一'],
    ['2', '周二'],
    ['3', '周三'],
    ['4', '周四'],
    ['5', '周五'],
    ['6', '周六'],
    ['0', '周日']
  ];
  return options
    .map(
      ([value, label]) =>
        `<option value="${value}" ${Number(selectedValue) === Number(value) ? 'selected' : ''}>${label}</option>`
    )
    .join('');
}

function renderDayOptions(selectedValue) {
  return Array.from({ length: 28 }, (_, index) => index + 1)
    .map((value) => `<option value="${value}" ${value === selectedValue ? 'selected' : ''}>${value}日</option>`)
    .join('');
}

function renderUserHome(message) {
  const user = getCurrentUser();
  if (!user) {
    renderLoginForm('当前登录状态失效，请重新登录。');
    return;
  }

  const children = getChildrenForCurrentUser();
  const currentChild = getCurrentChild();
  const currentChildId = currentChild?.id ?? '';
  const childNameById = new Map(children.map((child) => [child.id, child.name]));
  const filterValues = getCurrentListFilters();
  const resolvedFilterChildId =
    filterValues.childId === 'all'
      ? 'all'
      : filterValues.childId === 'current'
        ? currentChildId || '__none__'
        : filterValues.childId;
  const allMistakes =
    resolvedFilterChildId === '__none__'
      ? []
      : filterMistakesForUser(state, user.id, {
          childId: resolvedFilterChildId
        });
  const filteredMistakes =
    resolvedFilterChildId === '__none__'
      ? []
      : filterMistakesForUser(state, user.id, {
          ...filterValues,
          childId: resolvedFilterChildId
        });
  const visibleCount =
    Number.isInteger(uiState.listVisibleCount) && uiState.listVisibleCount > 0
      ? uiState.listVisibleCount
      : MISTAKE_LIST_PAGE_SIZE;
  const visibleMistakes = filteredMistakes.slice(0, visibleCount);
  const hasMoreMistakes = visibleMistakes.length < filteredMistakes.length;
  const canCollapseMistakes = visibleMistakes.length > MISTAKE_LIST_PAGE_SIZE;
  const selectedMistake = findMistakeByIdForUser(state, user.id, uiState.selectedMistakeId);
  const relatedMistake = selectedMistake?.relatedMistakeId
    ? findMistakeByIdForUser(state, user.id, selectedMistake.relatedMistakeId)
    : null;
  const relatedMistakeText = selectedMistake?.relatedMistakeId
    ? relatedMistake
      ? `${relatedMistake.id}（${relatedMistake.recordDate} ${relatedMistake.subject}/${relatedMistake.category}）`
      : `${selectedMistake.relatedMistakeId}（未找到关联详情）`
    : '无';
  const referencedByCount = selectedMistake
    ? allMistakes.filter((item) => item.relatedMistakeId === selectedMistake.id).length
    : 0;
  const isEditingSelectedMistake = Boolean(
    selectedMistake && uiState.editingMistakeId === selectedMistake.id
  );
  const reviewPracticeMistakes = currentChildId
    ? getReviewPracticeMistakes(user.id, currentChildId)
    : [];
  const learningReviewTasks = currentChildId
    ? listFeynmanReviewTasks(state, user.id, currentChildId, '需再次复习')
    : [];
  const pendingReviewCount = reviewPracticeMistakes.length + learningReviewTasks.length;
  const rememberedReviewSession = currentChildId
    ? findRememberedReviewSession(user.id, currentChildId)
    : null;
  const activeReviewSession =
    (state.reviewSessions || []).find(
      (session) =>
        session.id === uiState.activeReviewSessionId &&
        session.userId === user.id &&
        isReviewSessionActive(session)
    ) ||
    (rememberedReviewSession && isReviewSessionActive(rememberedReviewSession)
      ? rememberedReviewSession
      : null) ||
    null;
  const reviewProgressSession = activeReviewSession || rememberedReviewSession;
  const activeReviewProgress = reviewProgressSession
    ? getReviewSessionProgress(reviewProgressSession)
    : null;
  const activeReviewMistakeId = activeReviewSession
    ? getCurrentReviewMistakeId(activeReviewSession)
    : null;
  const practiceMistake =
    (activeReviewMistakeId ? findMistakeByIdForUser(state, user.id, activeReviewMistakeId) : null) ||
    selectedMistake;
  const hideSelectedDetailForActiveReview = Boolean(
    activeReviewSession && selectedMistake && selectedMistake.id === activeReviewMistakeId
  );
  const childReviewAttempts = currentChildId
    ? listReviewAttemptsForChild(state, user.id, currentChildId)
    : [];
  const currentWeakPointViews = (state.weakPointViews || []).filter((item) => item.userId === user.id);
  const feynmanNotes = listFeynmanNotesForUser(state, user.id, {
    childId: currentChildId || 'all',
    subject: uiState.noteSubjectFilter,
    mastery: uiState.noteMasteryFilter
  });
  const exportHistory = state.exports
    .filter((item) => item.userId === user.id)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  const auditLogs = getRecentAuditLogs(20);
  const auditRows =
    auditLogs.length === 0
      ? '<p class="hint">暂无审计记录。</p>'
      : `<div class="table-wrap">
           <table>
             <thead>
               <tr>
                 <th>时间</th>
                 <th>操作</th>
                 <th>结果</th>
                 <th>详情</th>
               </tr>
             </thead>
             <tbody>
               ${auditLogs
                 .map(
                   (item) => `<tr>
                      <td>${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))}</td>
                      <td>${escapeHtml(item.action)}</td>
                      <td>${escapeHtml(item.result)}</td>
                      <td>${escapeHtml(item.detail || '—')}</td>
                    </tr>`
                 )
                 .join('')}
             </tbody>
           </table>
         </div>`;

  const reminder = getReminderConfig();
  const reminderStatus = evaluateReminder(reminder, new Date());
  const nextReminderText = reminderStatus.nextAt
    ? reminderStatus.nextAt.toLocaleString('zh-CN')
    : '未启用';
  const autoExport = getAutoExportConfig();
  const autoExportStatus = evaluateAutoExport(autoExport, new Date());
  const autoExportNextText = autoExportStatus.nextAt
    ? autoExportStatus.nextAt.toLocaleString('zh-CN')
    : '未启用';
  const isWeekly = reminder.cycle === 'weekly';
  const notificationPermission =
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  const weakPointScopeChildId =
    uiState.weakPointScope === 'all' ? 'all' : currentChildId || '__none__';
  const weakPointBaseMistakes =
    weakPointScopeChildId === '__none__'
      ? []
      : filterMistakesForUser(state, user.id, {
          childId: weakPointScopeChildId
        });
  const weakPointDays = Number(uiState.weakPointDays);
  const weakPointRecentMistakes = filterMistakesByRecentDays(
    weakPointBaseMistakes,
    Number.isInteger(weakPointDays) ? weakPointDays : 90,
    new Date()
  );
  const weakPointMinFrequencyRaw = Number(uiState.weakPointMinFrequency);
  const weakPointMinFrequency =
    Number.isInteger(weakPointMinFrequencyRaw) && weakPointMinFrequencyRaw > 0
      ? weakPointMinFrequencyRaw
      : 2;
  const weakPointSummary = summarizeWeakPoints(weakPointRecentMistakes, {
    minSample: 6,
    minFrequency: weakPointMinFrequency,
    topN: 6,
    minConsecutiveWeeks: 3
  });

  const weakPointHighFrequencyHtml =
    weakPointSummary.highFrequency.length === 0
      ? '<p class="hint">未达到高频阈值。</p>'
      : `<ul class="compact-list">
           ${weakPointSummary.highFrequency
             .map(
               (item) =>
                 `<li>${escapeHtml(item.subject)} · ${escapeHtml(item.category)}：${item.count} 次（${item.firstDate} 至 ${item.lastDate}）</li>`
             )
             .join('')}
         </ul>`;
  const weakPointConsecutiveHtml =
    weakPointSummary.consecutiveWeeks.length === 0
      ? '<p class="hint">暂未发现连续多周重复错误。</p>'
      : `<ul class="compact-list">
           ${weakPointSummary.consecutiveWeeks
             .map(
               (item) =>
                 `<li>${escapeHtml(item.subject)} · ${escapeHtml(item.category)}：连续 ${item.weeks} 周（${item.streakStartWeek} 至 ${item.streakEndWeek}）</li>`
             )
             .join('')}
         </ul>`;
  const weakPointPatternHtml =
    weakPointSummary.patterns.length === 0
      ? '<p class="hint">暂未发现明显模式关键词。</p>'
      : `<ul class="compact-list">
           ${weakPointSummary.patterns
             .map(
               (item) =>
                 `<li>${escapeHtml(item.label)}：${item.count} 次（${item.firstDate} 至 ${item.lastDate}）</li>`
             )
             .join('')}
         </ul>`;
  const weakPointViewText =
    currentWeakPointViews.length === 0
      ? '还没有进入过薄弱点页'
      : currentWeakPointViews
          .map((item) => `${item.scope === 'all' ? '全部孩子' : '当前孩子'} ${item.viewCount} 次`)
          .join(' / ');

  const feynmanNoteRows =
    feynmanNotes.length === 0
      ? '<p class="hint">还没有费曼笔记。</p>'
      : `<div class="note-stream">
          ${feynmanNotes
            .map(
              (note) => `<article class="note-leaf">
                <div class="note-leaf__head">
                  <span>${escapeHtml(note.subject)}</span>
                  <strong>${escapeHtml(note.concept)}</strong>
                  <em>${escapeHtml(note.mastery)}</em>
                  ${Number.isFinite(Number(note.aiScore)) ? `<em class="note-score">AI ${escapeHtml(note.aiScore)} 分</em>` : ''}
                </div>
                <p>${escapeHtml(note.explainSimply || '还没有写自己的解释。')}</p>
                <p class="hint">没讲明白：${escapeHtml(note.stuckPoint || '—')} / 还不熟：${escapeHtml(note.unfamiliarPoint || '—')}</p>
                ${
                  note.reviewPoints?.length
                    ? `<div class="saved-review-points"><strong>复习要点</strong>${renderReviewPointList(note.reviewPoints)}</div>`
                    : ''
                }
                ${note.textbookName ? `<p class="hint">教材依据：${escapeHtml(note.textbookName)}</p>` : ''}
                ${note.reviewStatus ? `<p class="hint">复习状态：${escapeHtml(note.reviewStatus)}</p>` : ''}
                ${renderTextbookEvidence(note.textbookEvidence, '本次教材证据')}
                <details class="advanced-block">
                  <summary>补一条复习记录</summary>
                  <form class="feynman-review-form form-grid top-gap">
                    <input type="hidden" name="noteId" value="${escapeHtml(note.id)}" />
                    <label>
                      复习记录
                      <textarea name="reviewText" rows="3" placeholder="今天哪里讲清了，哪里还卡住"></textarea>
                    </label>
                    <label>
                      当前掌握度
                      <select name="mastery">${renderFeynmanMasteryOptions(note.mastery)}</select>
                    </label>
                    <button type="submit" class="ghost">保存复习记录</button>
                  </form>
                </details>
              </article>`
            )
            .join('')}
        </div>`;

  const lastReviewHtml = uiState.lastReviewResult
    ? `<div class="review-result ${uiState.lastReviewResult.isCorrect ? 'is-correct' : 'is-wrong'}">
        <strong>${uiState.lastReviewResult.isCorrect ? '上一题正确' : '上一题需要再复习'}</strong>
        <span>你的答案：${escapeHtml(uiState.lastReviewResult.userAnswer || '（空）')}</span>
        <span>正确答案：${escapeHtml(uiState.lastReviewResult.correctAnswer || '（空）')}</span>
      </div>`
    : '';
  const learningReviewPanel = `<section class="learning-thread">
    <div class="thread-head">
      <div>
        <p class="eyebrow">FEYNMAN REVIEW</p>
        <h2>知识讲解待复习</h2>
      </div>
      <strong>${learningReviewTasks.length} 个知识点</strong>
    </div>
    ${
      learningReviewTasks.length === 0
        ? '<p class="hint">当前没有需要重新讲解的知识点。</p>'
        : `<div class="learning-review-list">
            ${learningReviewTasks
              .map(
                (task) => `<article class="learning-review-item">
                  <div>
                    <span>${escapeHtml(task.subject)} · ${escapeHtml(task.mastery)}</span>
                    <h3>${escapeHtml(task.topic)}</h3>
                    <p class="hint">上次 ${escapeHtml(task.aiScore)} 分</p>
                    ${task.reviewPoints?.length ? renderReviewPointList(task.reviewPoints.slice(0, 3)) : ''}
                  </div>
                  <button type="button" class="ghost resume-learning-review-button" data-task-id="${escapeHtml(task.id)}">再讲一次</button>
                </article>`
              )
              .join('')}
          </div>`
    }
  </section>`;
  const reviewPracticePanel = `<section class="learning-thread">
      <div class="thread-head">
        <div>
          <p class="eyebrow">REVIEW FLOW</p>
          <h2>复习练习</h2>
        </div>
        <div class="action-row">
          <button type="button" id="start-review-session-button">${activeReviewSession || rememberedReviewSession ? '继续复习' : '开始复习'}</button>
          <button type="button" id="stop-review-session-button" class="ghost" ${activeReviewSession ? '' : 'disabled'}>停止并保存</button>
        </div>
      </div>
      <div class="learning-stats">
        <span>队列 ${reviewPracticeMistakes.length}</span>
        <span>已复习 ${activeReviewProgress?.reviewedCount ?? 0}</span>
        <span>未复习 ${activeReviewProgress?.pendingCount ?? reviewPracticeMistakes.length}</span>
        <span>总作答 ${childReviewAttempts.length}</span>
      </div>
      ${lastReviewHtml}
      ${
        practiceMistake && activeReviewSession
          ? `<article class="question-focus">
              <div class="question-meta">
                <span>${escapeHtml(practiceMistake.subject)}</span>
                <span>${escapeHtml(practiceMistake.category)}</span>
                <span>复习 ${Number(practiceMistake.reviewCount || 0)} 次</span>
              </div>
              <h3>原题</h3>
              <p class="question-text">${escapeHtml(practiceMistake.originalQuestion)}</p>
              <form id="review-answer-form" class="form-grid">
                <input type="hidden" name="sessionId" value="${escapeHtml(activeReviewSession.id)}" />
                <input type="hidden" name="mistakeId" value="${escapeHtml(practiceMistake.id)}" />
                <label>
                  孩子的答案
                  <textarea name="userAnswer" rows="4" placeholder="让孩子重新作答，提交后再看正确答案" required></textarea>
                </label>
                <label>
                  作答过程
                  <textarea name="processNote" rows="4" placeholder="记录推理、草稿步骤、卡住的位置"></textarea>
                </label>
                <details class="advanced-block">
                  <summary>把这题沉淀成费曼笔记</summary>
                  <div class="form-grid top-gap">
                    <label>
                      知识点
                      <input name="noteConcept" type="text" value="${escapeHtml(`${practiceMistake.subject} · ${practiceMistake.category}`)}" />
                    </label>
                    <label>
                      不懂在哪里
                      <textarea name="stuckPoint" rows="3"></textarea>
                    </label>
                    <label>
                      不熟在哪里
                      <textarea name="unfamiliarPoint" rows="3"></textarea>
                    </label>
                    <label>
                      用自己的话讲一遍
                      <textarea name="teachBack" rows="3"></textarea>
                    </label>
                  </div>
                </details>
                <button type="submit">提交并进入下一题</button>
              </form>
            </article>`
          : `<p class="hint">${reviewPracticeMistakes.length === 0 ? '当前没有需要复习的错题。' : '点击开始或继续复习，系统会接上未完成的进度。'}</p>`
      }
    </section>`;

  const mistakeRows =
    filteredMistakes.length === 0
      ? '<p class="hint">当前筛选条件下没有错题记录。</p>'
      : `<div class="table-wrap">
           <table>
             <thead>
               <tr>
                 <th>日期</th>
                 <th>孩子</th>
                 <th>学科</th>
                 <th>类别</th>
                 <th>状态</th>
                 <th>来源</th>
                 <th>原题内容</th>
                 <th>操作</th>
               </tr>
             </thead>
             <tbody>
               ${visibleMistakes
                 .map(
                   (item) => `<tr>
                      <td>${escapeHtml(item.recordDate)}</td>
                      <td>${escapeHtml(childNameById.get(item.childId) || item.childId)}</td>
                      <td>${escapeHtml(item.subject)}</td>
                      <td>${escapeHtml(item.category)}</td>
                      <td>${escapeHtml(item.status)}</td>
                      <td>${escapeHtml(item.source)}</td>
                      <td>${escapeHtml(item.originalQuestion).slice(0, 120)}</td>
                      <td><button type="button" class="ghost open-mistake-detail-button" data-mistake-id="${escapeHtml(item.id)}">查看详情</button></td>
                    </tr>`
                 )
                 .join('')}
             </tbody>
           </table>
         </div>
         <div class="action-row">
           ${
             hasMoreMistakes
               ? `<button type="button" id="load-more-mistakes-button" class="ghost">加载更多（已显示 ${visibleMistakes.length}/${filteredMistakes.length}）</button>`
               : `<span class="hint">已显示全部 ${filteredMistakes.length} 条。</span>`
           }
           ${
             canCollapseMistakes
               ? `<button type="button" id="collapse-mistakes-button" class="ghost">收起到前 ${MISTAKE_LIST_PAGE_SIZE} 条</button>`
               : ''
           }
         </div>`;
  const mistakeDetailPanel = selectedMistake && !hideSelectedDetailForActiveReview
    ? `<section class="panel top-gap">
         <h2>错题详情</h2>
         <ul class="meta-list">
           <li>错题 ID：${escapeHtml(selectedMistake.id)}</li>
           <li>孩子：${escapeHtml(childNameById.get(selectedMistake.childId) || selectedMistake.childId)}</li>
           <li>记录日期：${escapeHtml(selectedMistake.recordDate)}</li>
           <li>学科：${escapeHtml(selectedMistake.subject)}</li>
           <li>类别：${escapeHtml(selectedMistake.category)}</li>
           <li>来源：${escapeHtml(selectedMistake.source)}</li>
           <li>状态：${escapeHtml(selectedMistake.status)}</li>
           <li>标签：${selectedMistake.tags.length ? escapeHtml(selectedMistake.tags.join('、')) : '（空）'}</li>
           <li>关联历史错题：${escapeHtml(relatedMistakeText)}</li>
           <li>被后续关联次数：${escapeHtml(referencedByCount)} 次</li>
           <li>创建时间：${escapeHtml(new Date(selectedMistake.createdAt).toLocaleString('zh-CN'))}</li>
           <li>更新时间：${escapeHtml(new Date(selectedMistake.updatedAt).toLocaleString('zh-CN'))}</li>
         </ul>
         <label>原题内容<textarea rows="4" readonly>${escapeHtml(selectedMistake.originalQuestion)}</textarea></label>
         <label>错误答案/表现<textarea rows="3" readonly>${escapeHtml(selectedMistake.wrongAnswer || '（空）')}</textarea></label>
         <label>正确答案<textarea rows="3" readonly>${escapeHtml(selectedMistake.correctAnswer || '（空）')}</textarea></label>
         <label>解析/纠正说明<textarea rows="3" readonly>${escapeHtml(selectedMistake.analysis || '（空）')}</textarea></label>
         <label>复习建议<textarea rows="3" readonly>${escapeHtml(selectedMistake.reviewTip || '（空）')}</textarea></label>
         <form id="mistake-quick-status-form" class="form-grid">
           <input type="hidden" name="mistakeId" value="${escapeHtml(selectedMistake.id)}" />
           <label>
             快捷更新状态
             <select name="status">${renderReviewStatusOptions(selectedMistake.status)}</select>
           </label>
           <div class="action-row">
             <button type="submit" class="ghost">更新状态</button>
           </div>
         </form>
         <div class="action-row">
           <button type="button" id="close-mistake-detail-button" class="ghost">关闭详情</button>
           <button type="button" id="start-edit-mistake-button" class="ghost" data-mistake-id="${escapeHtml(selectedMistake.id)}">编辑错题</button>
           <button type="button" id="delete-mistake-button" class="ghost" data-mistake-id="${escapeHtml(selectedMistake.id)}">删除该错题</button>
         </div>
       </section>`
    : '';
  const mistakeEditPanel = isEditingSelectedMistake
    ? `<section class="panel top-gap">
         <h2>编辑错题</h2>
         <p class="hint">修改后会直接覆盖当前错题记录。</p>
         <form id="edit-mistake-form" class="form-grid">
           <input type="hidden" name="mistakeId" value="${escapeHtml(selectedMistake.id)}" />
           <div class="two-col-grid">
             <label>
               记录日期
               <input name="recordDate" type="date" value="${escapeHtml(selectedMistake.recordDate)}" required />
             </label>
             <label>
               学科
               <select name="subject">${renderSubjectOptions(selectedMistake.subject)}</select>
             </label>
           </div>
           <div class="two-col-grid">
             <label>
               类别
               <input name="category" type="text" value="${escapeHtml(selectedMistake.category)}" />
             </label>
             <label>
               来源
               <select name="source">${renderSourceOptions(selectedMistake.source)}</select>
             </label>
           </div>
           <label>
             原题内容
             <textarea name="originalQuestion" rows="5" required>${escapeHtml(selectedMistake.originalQuestion)}</textarea>
           </label>
           <div class="two-col-grid">
             <label>
               错误答案/表现
               <textarea name="wrongAnswer" rows="3">${escapeHtml(selectedMistake.wrongAnswer || '')}</textarea>
             </label>
             <label>
               正确答案
               <textarea name="correctAnswer" rows="3">${escapeHtml(selectedMistake.correctAnswer || '')}</textarea>
             </label>
           </div>
           <div class="two-col-grid">
             <label>
               解析/纠正说明
               <textarea name="analysis" rows="3">${escapeHtml(selectedMistake.analysis || '')}</textarea>
             </label>
             <label>
               复习建议
               <textarea name="reviewTip" rows="3">${escapeHtml(selectedMistake.reviewTip || '')}</textarea>
             </label>
           </div>
           <div class="two-col-grid">
             <label>
               状态
               <select name="status">${renderReviewStatusOptions(selectedMistake.status)}</select>
             </label>
             <label>
               标签
               <input name="tags" type="text" value="${escapeHtml((selectedMistake.tags || []).join('，'))}" placeholder="多个标签用逗号分隔" />
             </label>
           </div>
           <div class="action-row">
             <button type="submit">保存修改</button>
             <button type="button" id="cancel-edit-mistake-button" class="ghost">取消编辑</button>
           </div>
         </form>
       </section>`
    : '';
  const exportRows =
    exportHistory.length === 0
      ? '<p class="hint">还没有导出记录。</p>'
      : `<div class="table-wrap">
           <table>
             <thead>
               <tr>
                 <th>时间</th>
                 <th>孩子</th>
                 <th>范围</th>
                 <th>格式</th>
                 <th>模板</th>
                 <th>导出策略</th>
                 <th>来源</th>
                 <th>周期</th>
                 <th>题数</th>
                 <th>操作</th>
               </tr>
             </thead>
             <tbody>
               ${exportHistory
                 .map(
                    (item) => `<tr>
                      <td>${escapeHtml(new Date(item.createdAt).toLocaleString('zh-CN'))}</td>
                      <td>${escapeHtml(item.childName)}</td>
                      <td>${escapeHtml(item.from)} 至 ${escapeHtml(item.to)}</td>
                      <td>${escapeHtml(item.format.toUpperCase())}</td>
                      <td>${escapeHtml(item.template === 'detailed' ? '详细版' : '简洁版')}</td>
                      <td>${escapeHtml(
                        `${item.excludeMastered === true ? '排除已掌握' : '包含已掌握'} / ${item.prioritizeNeedReview !== false ? '需再次复习优先' : '按日期排序'}`
                      )}</td>
                      <td>${escapeHtml(item.source === 'auto' ? '自动' : '手动')}</td>
                      <td>${escapeHtml(item.cycle === 'day' ? '按日' : item.cycle === 'week' ? '按周' : item.cycle === 'month' ? '按月' : '自定义')}</td>
                      <td>${escapeHtml(item.count)}</td>
                      <td><button type="button" class="ghost download-export-record-button" data-export-id="${escapeHtml(item.id)}">下载</button></td>
                    </tr>`
                 )
                 .join('')}
             </tbody>
           </table>
         </div>`;
  const exportRange = getCurrentExportRange();
  const lockExportRange = shouldLockExportDateInputs();
  const workspaceOptions = ['review', 'capture', 'notebook', 'insight', 'export', 'settings'];
  const workspace = children.length === 0
    ? 'capture'
    : workspaceOptions.includes(uiState.activeWorkspace)
    ? uiState.activeWorkspace
    : 'review';
  uiState.activeWorkspace = workspace;
  const isCaptureWorkspace = workspace === 'capture';
  const isReviewWorkspace = workspace === 'review';
  const isNotebookWorkspace = workspace === 'notebook';
  const isExportWorkspace = workspace === 'export';
  const isInsightWorkspace = workspace === 'insight';
  const isSettingsWorkspace = workspace === 'settings';

  appEl.innerHTML = `
    <section class="study-shell">
      <aside class="study-rail">
        <div class="brand-mark">
          <span></span>
          <div>
            <h2>错题本</h2>
          </div>
        </div>
        <div class="child-switcher-block">
          <span class="field-label">当前孩子</span>
          ${
            children.length === 0
              ? '<button type="button" id="create-first-child-button">建立第一个孩子档案</button>'
              : `<select id="child-switcher">${renderChildrenOptions(children, currentChildId)}</select>
                 <button type="button" id="manage-child-button" class="ghost compact-button">新增或管理孩子</button>`
          }
        </div>
        <nav class="workspace-tabs">
          <button type="button" class="workspace-tab ${isReviewWorkspace ? 'active' : ''}" data-workspace="review" ${children.length === 0 ? 'disabled' : ''}>复习</button>
          <button type="button" class="workspace-tab ${isCaptureWorkspace ? 'active' : ''}" data-workspace="capture" ${children.length === 0 ? 'disabled' : ''}>录入</button>
          <button type="button" class="workspace-tab ${isNotebookWorkspace ? 'active' : ''}" data-workspace="notebook" ${children.length === 0 ? 'disabled' : ''}>讲给 AI</button>
          <button type="button" class="workspace-tab ${isInsightWorkspace ? 'active' : ''}" data-workspace="insight" ${children.length === 0 ? 'disabled' : ''}>薄弱点</button>
          <button type="button" class="workspace-tab ${isExportWorkspace ? 'active' : ''}" data-workspace="export" ${children.length === 0 ? 'disabled' : ''}>导出</button>
          <button type="button" class="workspace-tab ${isSettingsWorkspace ? 'active' : ''}" data-workspace="settings" ${children.length === 0 ? 'disabled' : ''}>设置</button>
        </nav>
        <div class="rail-stats">
          <span>孩子 ${children.length}</span>
          <span>错题 ${allMistakes.length}</span>
          <span>笔记 ${feynmanNotes.length}</span>
          <span>知识待复习 ${learningReviewTasks.length}</span>
          <span>薄弱点进入 ${currentWeakPointViews.reduce((sum, item) => sum + Number(item.viewCount || 0), 0)}</span>
        </div>
        <button id="logout-button" class="ghost">退出登录</button>
      </aside>

      <main class="study-stage">
        <header class="study-hero">
          <div>
            <p class="eyebrow">家长工作台</p>
            <h1>${currentChild ? `${escapeHtml(currentChild.name)}的学习现场` : '错题本工作台'}</h1>
          </div>
          <div class="command-metrics">
            <span class="stat-pill">登录：${user.method === 'phone' ? '手机号' : '邮箱'}</span>
            <span class="stat-pill" title="${escapeHtml(databaseState.error || '孩子和学习记录保存在本机 SQLite 数据库')}">本地数据库：${getDatabaseStatusLabel()}</span>
            <span class="stat-pill">待复习：${pendingReviewCount}</span>
            <span class="stat-pill">本轮：${activeReviewProgress?.reviewedCount ?? 0}/${activeReviewProgress?.totalCount ?? reviewPracticeMistakes.length}</span>
          </div>
          ${message ? `<p class="success">${message}</p>` : ''}
        </header>

    ${
      children.length === 0
        ? `<section class="workspace-panel child-onboarding top-gap">
            <section class="panel onboarding-panel">
              <p class="eyebrow">第一步</p>
              <h2>建立孩子档案</h2>
              <p class="hint">选择孩子当前年级和学习科目。建立后，就能上传对应教材、录入错题并让孩子讲给 AI 听。</p>
              ${renderChildProfileForm()}
            </section>
          </section>`
        : ''
    }

    <section class="workspace-panel ${isCaptureWorkspace && children.length > 0 ? '' : 'is-hidden'} top-gap">
      <section class="panel">
        <h2>步骤 1｜录入错题</h2>
        <p class="hint">先填核心字段，其他内容放到展开项，保证录入路径短而稳定。</p>
        <form id="mistake-form" class="form-grid">
          <div class="three-col-grid">
            <label>
              孩子
              <select name="childId" ${children.length === 0 ? 'disabled' : ''}>
                ${renderChildrenOptions(children, currentChildId)}
              </select>
            </label>
            <label>
              记录日期
              <input id="mistake-record-date" name="recordDate" type="date" value="${formatDateInputValue()}" required />
            </label>
            <label>
              学科
              <select id="mistake-subject" name="subject">${renderSubjectOptions(uiState.mistakeSubject)}</select>
            </label>
          </div>
          <div class="two-col-grid">
            <label>
              类别
              <select id="mistake-category-select" name="categoryMode">
                ${renderCategoryOptions(uiState.mistakeSubject, uiState.mistakeCategory)}
              </select>
            </label>
            <label>
              复习状态
              <select name="status">${renderReviewStatusOptions()}</select>
            </label>
          </div>
          <label id="mistake-category-custom-wrap" style="display:none;">
            自定义类别
            <input id="mistake-category-custom" name="categoryCustom" type="text" placeholder="输入自定义类别" />
          </label>
          <label>
            错题内容（必填）
            <textarea id="mistake-original-question" name="originalQuestion" rows="4" placeholder="例如：把“拔河”写成“拨河”" required></textarea>
          </label>
          <div class="two-col-grid">
            <label>
              错误答案/表现（可选）
              <textarea name="wrongAnswer" rows="3"></textarea>
            </label>
            <label>
              正确答案（可选）
              <textarea name="correctAnswer" rows="3"></textarea>
            </label>
          </div>
          <details class="advanced-block">
            <summary>更多选项（可选）</summary>
            <div class="form-grid top-gap">
              <div class="two-col-grid">
                <label>
                  解析/纠正说明
                  <textarea name="analysis" rows="3"></textarea>
                </label>
                <label>
                  复习建议
                  <textarea name="reviewTip" rows="3"></textarea>
                </label>
              </div>
              <div class="three-col-grid">
                <label>
                  来源
                  <select id="mistake-source" name="source">${renderSourceOptions()}</select>
                </label>
                <label>
                  标签
                  <input name="tags" type="text" placeholder="多个标签用逗号分隔" />
                </label>
              </div>
            </div>
          </details>
          <button type="submit" ${children.length === 0 ? 'disabled' : ''}>保存错题</button>
        </form>
      </section>

      <section class="panel top-gap">
        <h2>辅助输入通道</h2>
        <div class="two-col-grid">
          <section class="subpanel">
            <h3>语音转写（开源 faster-whisper）</h3>
            <div class="action-row">
              <button id="start-recording-button" ${
                voiceState.status === 'recording' || voiceState.status === 'processing' ? 'disabled' : ''
              }>开始录音</button>
              <button id="stop-recording-button" class="ghost" ${
                voiceState.status !== 'recording' ? 'disabled' : ''
              }>结束并转写</button>
            </div>
            <p class="hint">状态：${voiceStatusTextMap[voiceState.status]}</p>
            ${voiceState.error ? `<p class="error">${voiceState.error}</p>` : ''}
            ${
              voiceState.text
                ? `<label>转写结果<textarea rows="5">${voiceState.text}</textarea></label>
                   <div class="action-row">
                     <button type="button" id="fill-voice-button" class="ghost">把语音结果填入错题内容</button>
                   </div>
                   ${voiceState.engine ? `<p class="hint">引擎：${voiceState.engine}</p>` : ''}`
                : `<div class="action-row"><button type="button" id="fill-voice-button" class="ghost" disabled>把语音结果填入错题内容</button></div>`
            }
          </section>

          <section class="subpanel">
            <h3>图片 OCR</h3>
            <label>
              上传错题图片
              <input id="ocr-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,image/bmp" />
            </label>
            <div class="action-row">
              <button type="button" id="run-ocr-button" class="ghost">上传并识别</button>
              <button type="button" id="generate-ocr-draft-button" class="ghost">按 OCR 生成草稿</button>
            </div>
            <p id="ocr-engine-hint" class="hint"></p>
            <label>
              OCR 原文（可编辑）
              <textarea id="ocr-raw-text" rows="5" placeholder="识别结果会显示在这里"></textarea>
            </label>
          </section>
        </div>
      </section>

      ${
        children.length > 0
          ? `<details id="child-management-panel" class="panel top-gap details-panel">
              <summary>新增孩子档案</summary>
              ${renderChildProfileForm()}
            </details>`
          : ''
      }
    </section>

    <section class="workspace-panel ${isReviewWorkspace ? '' : 'is-hidden'} top-gap">
      ${learningReviewPanel}
      ${reviewPracticePanel}
      <section class="panel">
        <h2>复习队列</h2>
        <p class="hint">当前孩子共 ${allMistakes.length} 条，筛选后 ${filteredMistakes.length} 条，当前显示 ${visibleMistakes.length} 条。</p>
        <form id="mistake-filter-form" class="form-grid">
          <div class="three-col-grid">
            <label>
              学科
              <select name="subject">${renderListFilterSubjectOptions(filterValues.subject)}</select>
            </label>
            <label>
              状态
              <select name="status">${renderListFilterStatusOptions(filterValues.status)}</select>
            </label>
            <label>
              开始日期
              <input name="startDate" type="date" value="${filterValues.startDate}" />
            </label>
            <label>
              结束日期
              <input name="endDate" type="date" value="${filterValues.endDate}" />
            </label>
          </div>
          <details class="advanced-block">
            <summary>更多筛选（可选）</summary>
            <div class="form-grid top-gap">
              <div class="three-col-grid">
                <label>
                  孩子
                  <select name="childId" ${children.length === 0 ? 'disabled' : ''}>
                    ${renderListFilterChildOptions(children, currentChildId, filterValues.childId)}
                  </select>
                </label>
                <label>
                  类别（关键词）
                  <input name="category" type="text" value="${escapeHtml(filterValues.category)}" placeholder="例如 单位 / 错别字" />
                </label>
                <label>
                  标签（关键词）
                  <input name="tag" type="text" value="${escapeHtml(filterValues.tag)}" placeholder="例如 高频 / 期中" />
                </label>
              </div>
            </div>
          </details>
          <div class="action-row">
            <button type="submit">应用筛选</button>
            <button type="button" id="reset-mistake-filter-button" class="ghost">重置筛选</button>
          </div>
        </form>
        ${mistakeRows}
      </section>
      ${mistakeDetailPanel}
      ${mistakeEditPanel}
    </section>

    <section class="workspace-panel ${isNotebookWorkspace ? '' : 'is-hidden'} top-gap">
      <section class="panel ai-learning-lab">
        <div class="thread-head">
          <div>
            <p class="eyebrow">孩子当老师，AI 当学生</p>
            <h2>把今天学会的内容讲给 AI 听</h2>
            <p class="hint">AI 会先检索当前年级的对应教材，判断哪里讲明白了、哪里没讲清、哪里还不熟。</p>
          </div>
        </div>

        <section class="textbook-scope">
          <div>
            <h3>后台教材库</h3>
            <p class="hint">当前年级已配置 ${aiLearningState.textbooks.filter((item) => item.builtIn).length} 本系统教材。AI 会先自动检索，未命中时才使用通用知识。</p>
          </div>
          <details class="advanced-block">
            <summary>添加家庭补充教材（可选）</summary>
            <form id="textbook-upload-form" class="textbook-upload-form top-gap">
              <select name="subject" aria-label="教材学科">${renderSubjectOptions(aiLearningState.draft.subject)}</select>
              <input name="textbookFile" type="file" accept="application/pdf,text/plain,text/markdown,.pdf,.txt,.md" aria-label="选择教材文件" required />
              <button type="submit" class="ghost" ${aiLearningState.textbookStatus === 'uploading' ? 'disabled' : ''}>${aiLearningState.textbookStatus === 'uploading' ? '正在读取教材...' : '添加教材'}</button>
            </form>
          </details>
          ${aiLearningState.textbookError ? `<p class="error">${escapeHtml(aiLearningState.textbookError)}</p>` : ''}
        </section>

        <form id="feynman-ai-form" class="feynman-board">
          <label>
            学科
            <select name="subject">${renderSubjectOptions(aiLearningState.draft.subject)}</select>
          </label>
          <label>
            今天要讲的知识点
            <input name="topic" type="text" value="${escapeHtml(aiLearningState.draft.topic)}" placeholder="例如：分数表示什么" required />
          </label>
          <div class="ai-teach-box">
            <label for="feynman-explanation">现在你是老师，请用自己的话讲给 AI 学生听</label>
            <textarea id="feynman-explanation" name="explanation" rows="8" placeholder="可以直接讲，也可以先输入文字。尽量说清楚：它是什么、为什么、怎么用，再举一个例子。" required>${escapeHtml(aiLearningState.draft.explanation)}</textarea>
            <div class="action-row">
              <button type="button" id="feynman-start-recording-button" class="ghost" ${feynmanVoiceState.status === 'recording' || feynmanVoiceState.status === 'processing' ? 'disabled' : ''}>开始讲</button>
              <button type="button" id="feynman-stop-recording-button" class="ghost" ${feynmanVoiceState.status !== 'recording' ? 'disabled' : ''}>讲完了</button>
              <p id="feynman-voice-status" class="hint">${
                feynmanVoiceState.status === 'recording'
                  ? '正在听孩子讲...'
                  : feynmanVoiceState.status === 'processing'
                    ? '正在整理刚才的讲解...'
                    : feynmanVoiceState.error || '可以语音讲解，也可以直接输入文字。'
              }</p>
            </div>
          </div>
          <button type="submit" ${aiLearningState.status === 'processing' ? 'disabled' : ''}>${aiLearningState.status === 'processing' ? 'AI 正在听讲和评分...' : '请 AI 听讲并打分'}</button>
        </form>
        ${aiLearningState.error ? `<p class="error">${escapeHtml(aiLearningState.error)}</p>` : ''}
        ${renderAiEvaluationResult(
          aiLearningState.evaluation,
          aiLearningState.basis,
          aiLearningState.reviewTask,
          aiLearningState.saveStatus
        )}
      </section>
      <section class="panel note-list-panel">
        <div class="thread-head">
          <div>
            <h2>学习记录</h2>
            <p class="hint">AI 评分后点击保存，方便回看孩子表达和理解的变化。</p>
          </div>
          <form id="notebook-filter-form" class="mini-filter">
            <select name="subject">${renderNotebookSubjectOptions(uiState.noteSubjectFilter)}</select>
            <select name="mastery">${renderFeynmanMasteryOptions(uiState.noteMasteryFilter, true)}</select>
            <button type="submit" class="ghost">筛选</button>
          </form>
        </div>
        ${feynmanNoteRows}
      </section>
    </section>

    <section class="workspace-panel ${isExportWorkspace ? '' : 'is-hidden'} top-gap">
      <section class="panel">
        <h2>步骤 3｜导出与打印</h2>
        <p class="hint">先选周期和对象，再决定格式。家庭打印场景优先 PDF。</p>
        <form id="export-form" class="form-grid">
          <label>
            导出周期
            <select name="cycle">
              <option value="day" ${uiState.exportCycle === 'day' ? 'selected' : ''}>按日</option>
              <option value="week" ${uiState.exportCycle === 'week' ? 'selected' : ''}>按周</option>
              <option value="month" ${uiState.exportCycle === 'month' ? 'selected' : ''}>按月</option>
              <option value="custom" ${uiState.exportCycle === 'custom' ? 'selected' : ''}>自定义</option>
            </select>
          </label>
          <div class="three-col-grid">
            <label>
              孩子
              <select name="childId" ${children.length === 0 ? 'disabled' : ''}>
                ${renderChildrenOptions(children, currentChildId)}
              </select>
            </label>
            <label>
              开始日期
              <input name="startDate" type="date" value="${exportRange.startDate}" ${lockExportRange ? 'disabled' : ''} required />
            </label>
            <label>
              结束日期
              <input name="endDate" type="date" value="${exportRange.endDate}" ${lockExportRange ? 'disabled' : ''} required />
            </label>
          </div>
          <details class="advanced-block">
            <summary>导出选项（可选）</summary>
            <div class="form-grid top-gap">
              <label>
                导出模板
                <select name="template">
                  <option value="compact">简洁打印版</option>
                  <option value="detailed">详细讲解版</option>
                </select>
              </label>
              <div class="three-col-grid">
                <label class="checkbox-line">
                  <input name="excludeMastered" type="checkbox" ${uiState.exportExcludeMastered ? 'checked' : ''} />
                  导出时排除“已掌握”
                </label>
                <label class="checkbox-line">
                  <input name="prioritizeNeedReview" type="checkbox" ${uiState.exportPrioritizeNeedReview ? 'checked' : ''} />
                  优先“需再次复习”
                </label>
              </div>
            </div>
          </details>
          <div class="action-row">
            <button type="submit" name="exportFormat" value="pdf" ${children.length === 0 ? 'disabled' : ''}>导出 PDF（推荐）</button>
            <button type="submit" name="exportFormat" value="markdown" class="ghost" ${children.length === 0 ? 'disabled' : ''}>导出 Markdown</button>
            <button type="submit" name="exportFormat" value="txt" class="ghost" ${children.length === 0 ? 'disabled' : ''}>导出 TXT</button>
          </div>
        </form>

        <h3>导出历史（最近 10 次）</h3>
        ${exportRows}
      </section>

      <details class="panel top-gap details-panel">
        <summary>自动定期导出（可选）</summary>
        <p class="hint top-gap">下次自动导出时间：${autoExportNextText}</p>
        <form id="auto-export-form" class="form-grid top-gap">
          <label class="checkbox-line">
            <input name="enabled" type="checkbox" ${autoExport.enabled ? 'checked' : ''} />
            启用自动导出
          </label>
          <div class="three-col-grid">
            <label>
              导出周期
              <select name="cycle">
                <option value="day" ${autoExport.cycle === 'day' ? 'selected' : ''}>按日</option>
                <option value="week" ${autoExport.cycle === 'week' ? 'selected' : ''}>按周</option>
                <option value="month" ${autoExport.cycle === 'month' ? 'selected' : ''}>按月</option>
              </select>
            </label>
            <label id="auto-weekday-field" style="${autoExport.cycle === 'week' ? '' : 'display:none;'}">
              每周几
              <select name="weekday">${renderWeekdayOptions(autoExport.weekday)}</select>
            </label>
            <label id="auto-day-of-month-field" style="${autoExport.cycle === 'month' ? '' : 'display:none;'}">
              每月几号
              <select name="dayOfMonth">${renderDayOptions(autoExport.dayOfMonth)}</select>
            </label>
            <label>
              时间
              <input name="time" type="time" value="${autoExport.time}" required />
            </label>
          </div>
          <div class="three-col-grid">
            <label>
              目标孩子
              <select name="targetChildId" ${children.length === 0 ? 'disabled' : ''}>
                ${renderAutoExportTargetOptions(children, currentChildId, autoExport.targetChildId)}
              </select>
            </label>
            <label>
              模板
              <select name="template">${renderTemplateOptions(autoExport.template)}</select>
            </label>
            <label>
              格式
              <select name="format">${renderAutoExportFormatOptions(autoExport.format)}</select>
            </label>
          </div>
          <div class="three-col-grid">
            <label class="checkbox-line">
              <input name="excludeMastered" type="checkbox" ${autoExport.excludeMastered ? 'checked' : ''} />
              导出时排除“已掌握”
            </label>
            <label class="checkbox-line">
              <input name="prioritizeNeedReview" type="checkbox" ${autoExport.prioritizeNeedReview ? 'checked' : ''} />
              优先“需再次复习”
            </label>
          </div>
          <button type="submit">保存自动导出设置</button>
        </form>
      </details>
    </section>

    <section class="workspace-panel ${isInsightWorkspace ? '' : 'is-hidden'} top-gap">
      <section class="panel">
        <h2>步骤 4｜薄弱点归纳</h2>
        <p class="hint">进入记录：${escapeHtml(weakPointViewText)}</p>
        <p class="hint">
          ${
            weakPointSummary.dateRange
              ? `样本范围：${weakPointSummary.dateRange.startDate} 至 ${weakPointSummary.dateRange.endDate}，共 ${weakPointSummary.sampleCount} 条。`
              : '当前没有可分析样本。'
          }
        </p>
        <form id="weak-point-form" class="form-grid">
          <div class="three-col-grid">
            <label>
              分析范围
              <select name="scope">${renderWeakPointScopeOptions(uiState.weakPointScope)}</select>
            </label>
            <label>
              时间窗口
              <select name="days">
                <option value="30" ${uiState.weakPointDays === '30' ? 'selected' : ''}>近 30 天</option>
                <option value="90" ${uiState.weakPointDays === '90' ? 'selected' : ''}>近 90 天</option>
                <option value="180" ${uiState.weakPointDays === '180' ? 'selected' : ''}>近 180 天</option>
                <option value="0" ${uiState.weakPointDays === '0' ? 'selected' : ''}>全部历史</option>
              </select>
            </label>
            <label>
              高频阈值（最少次数）
              <select name="minFrequency">
                <option value="2" ${uiState.weakPointMinFrequency === '2' ? 'selected' : ''}>2 次</option>
                <option value="3" ${uiState.weakPointMinFrequency === '3' ? 'selected' : ''}>3 次</option>
                <option value="4" ${uiState.weakPointMinFrequency === '4' ? 'selected' : ''}>4 次</option>
              </select>
            </label>
          </div>
          <div class="action-row">
            <button type="submit">刷新归纳</button>
          </div>
        </form>
        ${
          !weakPointSummary.sufficient
            ? `<p class="hint">当前样本不足（${weakPointSummary.sampleCount} 条），至少需要 ${weakPointSummary.minSample} 条错题才可稳定归纳。</p>`
            : `<h3>高频错误</h3>
               ${weakPointHighFrequencyHtml}
               <h3>连续多周重复</h3>
               ${weakPointConsecutiveHtml}
               <h3>模式关键词</h3>
               ${weakPointPatternHtml}`
        }
      </section>
    </section>

    <section class="workspace-panel ${isSettingsWorkspace ? '' : 'is-hidden'} top-gap">
      <section class="panel">
        <h2>步骤 5｜本地备份与恢复</h2>
        <p class="hint">导入恢复会覆盖当前浏览器全部本地数据。</p>
        <div class="action-row">
          <button type="button" id="export-backup-button">导出备份 JSON</button>
        </div>
        <div class="three-col-grid">
          <label>
            备份文件
            <input id="backup-import-input" type="file" accept=".json,application/json" />
          </label>
          <div class="action-row">
            <button type="button" id="import-backup-button" class="ghost">导入并恢复</button>
          </div>
        </div>
      </section>

      <section class="panel top-gap">
        <h2>周期提醒</h2>
        <p class="hint">下次提醒时间：${nextReminderText}</p>
        <form id="reminder-form" class="form-grid">
          <label class="checkbox-line">
            <input name="enabled" type="checkbox" ${reminder.enabled ? 'checked' : ''} />
            启用提醒
          </label>
          <label>
            周期
            <select name="cycle">
              <option value="weekly" ${isWeekly ? 'selected' : ''}>每周</option>
              <option value="monthly" ${!isWeekly ? 'selected' : ''}>每月</option>
            </select>
          </label>
          <label id="weekly-field" style="${isWeekly ? '' : 'display:none;'}">
            每周几
            <select name="weekday">${renderWeekdayOptions(reminder.weekday)}</select>
          </label>
          <label id="monthly-field" style="${isWeekly ? 'display:none;' : ''}">
            每月几号
            <select name="dayOfMonth">${renderDayOptions(reminder.dayOfMonth)}</select>
          </label>
          <label>
            提醒时间
            <input name="time" type="time" value="${reminder.time}" required />
          </label>
          <div class="action-row">
            <button type="submit">保存提醒</button>
            <button type="button" id="notification-permission-button" class="ghost">
              ${
                notificationPermission === 'granted'
                  ? '系统通知已授权'
                  : notificationPermission === 'denied'
                    ? '系统通知已拒绝'
                    : notificationPermission === 'unsupported'
                      ? '浏览器不支持系统通知'
                      : '授权系统通知'
              }
            </button>
          </div>
        </form>
      </section>

      <details class="panel top-gap details-panel">
        <summary>操作审计日志（最近 20 条）</summary>
        <div class="top-gap">${auditRows}</div>
      </details>
    </section>
      </main>
    </section>
  `;

  const logoutButton = document.getElementById('logout-button');
  logoutButton?.addEventListener('click', handleLogout);
  const workspaceTabs = document.querySelectorAll('.workspace-tab');
  workspaceTabs.forEach((button) => {
    button.addEventListener('click', handleSwitchWorkspace);
  });
  const childSwitcher = document.getElementById('child-switcher');
  childSwitcher?.addEventListener('change', handleSwitchChild);
  const createFirstChildButton = document.getElementById('create-first-child-button');
  createFirstChildButton?.addEventListener('click', () => {
    document.querySelector('#child-form input[name="name"]')?.focus();
  });
  const manageChildButton = document.getElementById('manage-child-button');
  manageChildButton?.addEventListener('click', handleOpenChildManagement);
  const childForm = document.getElementById('child-form');
  childForm?.addEventListener('submit', handleCreateChild);
  const startRecordingButton = document.getElementById('start-recording-button');
  startRecordingButton?.addEventListener('click', handleStartRecording);
  const stopRecordingButton = document.getElementById('stop-recording-button');
  stopRecordingButton?.addEventListener('click', handleStopRecording);
  const fillVoiceButton = document.getElementById('fill-voice-button');
  fillVoiceButton?.addEventListener('click', handleApplyVoiceResult);
  const runOcrButton = document.getElementById('run-ocr-button');
  runOcrButton?.addEventListener('click', handleRunImageOcr);
  const generateOcrDraftButton = document.getElementById('generate-ocr-draft-button');
  generateOcrDraftButton?.addEventListener('click', handleGenerateOcrDraft);
  const mistakeSubjectSelect = document.getElementById('mistake-subject');
  mistakeSubjectSelect?.addEventListener('change', handleMistakeSubjectChange);
  const mistakeCategorySelect = document.getElementById('mistake-category-select');
  mistakeCategorySelect?.addEventListener('change', handleMistakeCategoryChange);
  syncCategoryInputVisibility();
  const mistakeForm = document.getElementById('mistake-form');
  mistakeForm?.addEventListener('submit', handleCreateMistake);
  const mistakeFilterForm = document.getElementById('mistake-filter-form');
  mistakeFilterForm?.addEventListener('submit', handleListFilterSubmit);
  const resetMistakeFilterButton = document.getElementById('reset-mistake-filter-button');
  resetMistakeFilterButton?.addEventListener('click', handleListFilterReset);
  const loadMoreMistakesButton = document.getElementById('load-more-mistakes-button');
  loadMoreMistakesButton?.addEventListener('click', handleLoadMoreMistakes);
  const collapseMistakesButton = document.getElementById('collapse-mistakes-button');
  collapseMistakesButton?.addEventListener('click', handleCollapseMistakes);
  const detailButtons = document.querySelectorAll('.open-mistake-detail-button');
  detailButtons.forEach((button) => {
    button.addEventListener('click', handleOpenMistakeDetail);
  });
  const closeMistakeDetailButton = document.getElementById('close-mistake-detail-button');
  closeMistakeDetailButton?.addEventListener('click', handleCloseMistakeDetail);
  const quickStatusForm = document.getElementById('mistake-quick-status-form');
  quickStatusForm?.addEventListener('submit', handleQuickUpdateMistakeStatus);
  const startReviewSessionButton = document.getElementById('start-review-session-button');
  startReviewSessionButton?.addEventListener('click', handleStartReviewSession);
  const stopReviewSessionButton = document.getElementById('stop-review-session-button');
  stopReviewSessionButton?.addEventListener('click', handleStopReviewSession);
  const reviewAnswerForm = document.getElementById('review-answer-form');
  reviewAnswerForm?.addEventListener('submit', handleReviewAnswerSubmit);
  document.querySelectorAll('.resume-learning-review-button').forEach((button) => {
    button.addEventListener('click', handleResumeLearningReview);
  });
  const startEditMistakeButton = document.getElementById('start-edit-mistake-button');
  startEditMistakeButton?.addEventListener('click', handleStartEditMistake);
  const editMistakeForm = document.getElementById('edit-mistake-form');
  editMistakeForm?.addEventListener('submit', handleEditMistakeSubmit);
  const cancelEditMistakeButton = document.getElementById('cancel-edit-mistake-button');
  cancelEditMistakeButton?.addEventListener('click', handleCancelEditMistake);
  const deleteMistakeButton = document.getElementById('delete-mistake-button');
  deleteMistakeButton?.addEventListener('click', handleDeleteMistake);
  const weakPointForm = document.getElementById('weak-point-form');
  weakPointForm?.addEventListener('submit', handleWeakPointFormSubmit);
  const textbookUploadForm = document.getElementById('textbook-upload-form');
  textbookUploadForm?.addEventListener('submit', handleUploadTextbook);
  const feynmanAiForm = document.getElementById('feynman-ai-form');
  feynmanAiForm?.addEventListener('submit', handleEvaluateFeynmanExplanation);
  const saveFeynmanEvaluationButton = document.getElementById('save-feynman-evaluation-button');
  saveFeynmanEvaluationButton?.addEventListener('click', handleSaveFeynmanEvaluation);
  const feynmanStartRecordingButton = document.getElementById('feynman-start-recording-button');
  feynmanStartRecordingButton?.addEventListener('click', handleStartFeynmanRecording);
  const feynmanStopRecordingButton = document.getElementById('feynman-stop-recording-button');
  feynmanStopRecordingButton?.addEventListener('click', handleStopFeynmanRecording);
  const notebookFilterForm = document.getElementById('notebook-filter-form');
  notebookFilterForm?.addEventListener('submit', handleNotebookFilterSubmit);
  document.querySelectorAll('.feynman-review-form').forEach((form) => {
    form.addEventListener('submit', handleReviewFeynmanNote);
  });
  const exportForm = document.getElementById('export-form');
  exportForm?.addEventListener('submit', handleExportSubmit);
  const exportCycleSelect = exportForm?.querySelector('select[name="cycle"]');
  exportCycleSelect?.addEventListener('change', handleExportCycleChange);
  applyExportCycleToForm(exportForm);
  const downloadExportButtons = document.querySelectorAll('.download-export-record-button');
  downloadExportButtons.forEach((button) => {
    button.addEventListener('click', handleDownloadExportRecord);
  });

  const autoExportForm = document.getElementById('auto-export-form');
  autoExportForm?.addEventListener('submit', handleAutoExportSave);
  const autoExportCycleSelect = autoExportForm?.querySelector('select[name="cycle"]');
  autoExportCycleSelect?.addEventListener('change', (event) => {
    const nextCycle = event.target.value;
    const weekdayField = document.getElementById('auto-weekday-field');
    const dayOfMonthField = document.getElementById('auto-day-of-month-field');
    if (nextCycle === 'week') {
      weekdayField.style.display = '';
      dayOfMonthField.style.display = 'none';
    } else if (nextCycle === 'month') {
      weekdayField.style.display = 'none';
      dayOfMonthField.style.display = '';
    } else {
      weekdayField.style.display = 'none';
      dayOfMonthField.style.display = 'none';
    }
  });

  const exportBackupButton = document.getElementById('export-backup-button');
  exportBackupButton?.addEventListener('click', handleExportBackup);
  const importBackupButton = document.getElementById('import-backup-button');
  importBackupButton?.addEventListener('click', handleImportBackup);

  const reminderForm = document.getElementById('reminder-form');
  reminderForm?.addEventListener('submit', handleReminderSave);
  const cycleSelect = reminderForm?.querySelector('select[name="cycle"]');
  cycleSelect?.addEventListener('change', (event) => {
    const nextCycle = event.target.value;
    const weeklyField = document.getElementById('weekly-field');
    const monthlyField = document.getElementById('monthly-field');
    if (nextCycle === 'weekly') {
      weeklyField.style.display = '';
      monthlyField.style.display = 'none';
    } else {
      weeklyField.style.display = 'none';
      monthlyField.style.display = '';
    }
  });
  const notificationPermissionButton = document.getElementById('notification-permission-button');
  notificationPermissionButton?.addEventListener('click', handleNotificationPermission);
}

function render(message = '') {
  setStatusNotice();
  const currentUser = getCurrentUser();
  if (!currentUser) {
    renderLoginForm(message);
    return;
  }

  renderUserHome(message);
}

function startReminderTicker() {
  if (reminderTimerId) {
    clearInterval(reminderTimerId);
  }
  reminderTimerId = setInterval(() => {
    maybeTriggerReminder();
    maybeTriggerAutoExport();
  }, 60 * 1000);
}

startReminderTicker();
render();
void synchronizeCurrentAccountOnStartup();
