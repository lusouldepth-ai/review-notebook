const SCORE_FIELDS = ['accuracy', 'completeness', 'clarity', 'teaching'];

function cleanText(value, maxLength = 5000) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function clampScore(value, fallback = 0) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, 320)).filter(Boolean).slice(0, 6);
}

export function normalizeFeynmanEvaluation(value) {
  const dimensions = {};
  SCORE_FIELDS.forEach((field) => {
    dimensions[field] = clampScore(value?.dimensions?.[field]);
  });
  const average = Math.round(
    SCORE_FIELDS.reduce((sum, field) => sum + dimensions[field], 0) / SCORE_FIELDS.length
  );
  return {
    totalScore: clampScore(value?.totalScore, average),
    dimensions,
    summary: cleanText(value?.summary, 500),
    understood: stringList(value?.understood),
    unclear: stringList(value?.unclear),
    unfamiliar: stringList(value?.unfamiliar),
    teachBetter: cleanText(value?.teachBetter, 1200),
    followUpQuestion: cleanText(value?.followUpQuestion, 500),
    evidence: stringList(value?.evidence)
  };
}

export function buildFeynmanMessages({
  grade,
  subject,
  topic,
  explanation,
  passages = [],
  sourceMode = passages.length > 0 ? 'textbook' : 'general'
}) {
  const usesTextbook = sourceMode === 'textbook' && passages.length > 0;
  const textbookContext = passages
    .map(
      (passage) =>
        `[${cleanText(passage.filename, 160) || '教材'} 第 ${passage.page} 页]\n${passage.text}`
    )
    .join('\n\n')
    .slice(0, 32_000);

  const groundingRule = usesTextbook
    ? '本次已检索到相关教材。你必须严格分“孩子原话”和“教材事实”，严格依据教材片段核对正确性；不得用教材外知识替孩子补全答案。evidence 只写教材文件名、页码和极短依据。'
    : '本次没有在该年级、该学科的教材库中可靠命中相关内容。请使用可靠的通用知识和小学阶段教学常识评估，并在 summary 中明确写“本次未命中教材，按通用知识评估”。不得声称核对过教材，evidence 写“通用知识依据”及简短知识点。';

  return [
    {
      role: 'system',
      content: `你是一名小学${cleanText(grade, 20) || '对应年级'}学生，正在听另一位孩子当老师讲课。你的任务是先像学生一样理解，再评估孩子有没有讲清楚，并提出一个真正能暴露理解缺口的追问。

${groundingRule}

只输出 JSON，格式必须是：
{"totalScore":0,"dimensions":{"accuracy":0,"completeness":0,"clarity":0,"teaching":0},"summary":"","understood":[],"unclear":[],"unfamiliar":[],"teachBetter":"","followUpQuestion":"","evidence":[]}

评分维度均为 0-100：accuracy=是否符合教材，completeness=关键知识是否完整，clarity=表达是否清楚，teaching=是否能用例子和因果关系教会别人。unclear 写没有讲明白或可能讲错的地方；unfamiliar 写能看出还不熟练的地方；teachBetter 用孩子能照着改讲的一小段话；evidence 只引用教材页码和极短依据。语气具体、友善，不贴标签。`
    },
    {
      role: 'user',
      content: `学科：${cleanText(subject, 30)}\n知识点：${cleanText(topic, 120)}\n\n孩子的讲解：\n${cleanText(explanation, 8000)}\n\n${
        usesTextbook
          ? `本次检索到的教材片段：\n${textbookContext}\n\n请逐项核对孩子讲解与教材是否一致。`
          : '本次没有检索到可靠的教材片段，请按通用知识评估并明确说明依据。'
      }\n\n请完成 JSON 评估。`
    }
  ];
}

function parseJsonContent(content) {
  const text = cleanText(content, 20_000).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) throw new Error('AI 没有返回评估内容。');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('AI 返回的评估格式无法解析。');
  }
}

export async function evaluateWithDeepSeek({
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-v4-flash',
  input,
  fetchImpl = fetch
}) {
  if (!String(apiKey ?? '').trim()) {
    const error = new Error('DeepSeek API 尚未配置。');
    error.code = 'AI_NOT_CONFIGURED';
    throw error;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const messages = buildFeynmanMessages(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          max_tokens: 2200,
          stream: false
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = new Error(`DeepSeek API 调用失败（HTTP ${response.status}）。`);
        error.code = 'AI_UPSTREAM_ERROR';
        throw error;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (!cleanText(content, 20_000) && attempt === 0) continue;
      const evaluation = normalizeFeynmanEvaluation(parseJsonContent(content));
      return {
        evaluation,
        model: cleanText(payload?.model || model, 100),
        usage: {
          promptTokens: Number(payload?.usage?.prompt_tokens || 0),
          completionTokens: Number(payload?.usage?.completion_tokens || 0),
          totalTokens: Number(payload?.usage?.total_tokens || 0)
        }
      };
    }
    throw new Error('AI 没有返回评估内容。');
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('AI 评估超时，请稍后重试。');
      timeoutError.code = 'AI_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
