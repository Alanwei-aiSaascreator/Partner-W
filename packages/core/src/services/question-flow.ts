/**
 * 网关「结构化提问」链路（openclaw `ask_user` → `question.requested`）。
 *
 * 为什么要有这个模块：网关 2026.9.3 起支持 agent 调用 `ask_user` 工具向用户提
 * 1–3 个结构化问题，客户端必须回 `question.resolve` 才能让 agent 继续。桌面端
 * **此前完全没有实现这条链路**，于是问题一直 pending，而网关会把同一 session 里
 * 用户发的**任何**新消息当成「答案」去解析（plain-text claim）：单行文本只能填
 * 上第一题，其余全空 ⇒ 网关抛 `question 'doc_type' requires an answer`，会话
 * 在 15 分钟内对用户彻底静默。见 docs/status/2026-09-15-demo-bug-fix-log.md。
 *
 * ⚠️ 网关侧 schema 全部是 `closedObject`（`src-CxpZ9eYs.mjs` 的
 * `QuestionResolveParamsSchema`），**多一个字段都会被拒**；答案形状是**两层
 * answers**：`{ answers: { [questionId]: string[] } }`，值必须是字符串数组，
 * 且 label 必须与选项逐字相同（网关只 trim，不做模糊匹配）。
 *
 * 本模块只放**纯逻辑**（无 IO、无 React），方便按 TDD 钉住这些契约。
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  /** snake_case 答案键，例如 `doc_type`。**只用于提交，不要展示给用户**。 */
  questionId: string;
  /** 短标签（≤12 字符），展示给用户的就是它。 */
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  /** 网关永远自动附加「其他」自由输入，agent 不会自己写 Other 选项。 */
  isOther?: boolean;
}

export interface QuestionRequest {
  id: string;
  questions: PendingQuestion[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  createdAtMs: number;
  expiresAtMs: number;
  status?: string;
}

export type QuestionSelection = Record<string, string[]>;

export type QuestionSelectionResult =
  | { ok: true; answers: Record<string, string[]> }
  | { ok: false; missing: string[]; errorHeader?: string; reason?: 'single-select' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseQuestion(raw: unknown): PendingQuestion | null {
  if (!isRecord(raw)) return null;
  const questionId = nonEmptyString(raw.questionId);
  const header = nonEmptyString(raw.header);
  const question = nonEmptyString(raw.question);
  const rawOptions = Array.isArray(raw.options) ? raw.options : [];
  const options: QuestionOption[] = [];
  for (const option of rawOptions) {
    if (!isRecord(option)) continue;
    const label = nonEmptyString(option.label);
    if (!label) continue;
    const description = nonEmptyString(option.description);
    options.push(description ? { label, description } : { label });
  }
  // 没有选项的问题渲染出来只能是空白卡片，直接丢掉；
  // 没有 header 的问题会退化成把内部字段名展示给用户，也不能要。
  if (!questionId || !header || !question || options.length === 0) return null;
  return {
    questionId,
    header,
    question,
    options,
    ...(raw.multiSelect === true ? { multiSelect: true } : {}),
    ...(raw.isOther === true ? { isOther: true } : {}),
  };
}

/**
 * 解析 `question.requested` 事件负载。认不出来一律返回 `null`（fail-soft）——
 * 宁可少渲染一张卡片，也不能把半个问题渲染出来让用户提交残缺答案。
 */
export function parseQuestionRequest(payload: unknown): QuestionRequest | null {
  if (!isRecord(payload)) return null;
  const id = nonEmptyString(payload.id);
  if (!id || !Array.isArray(payload.questions)) return null;
  const questions: PendingQuestion[] = [];
  for (const raw of payload.questions) {
    const parsed = parseQuestion(raw);
    if (parsed) questions.push(parsed);
  }
  if (questions.length === 0) return null;
  const agentId = nonEmptyString(payload.agentId);
  const sessionKey = nonEmptyString(payload.sessionKey);
  const runId = nonEmptyString(payload.runId);
  const status = nonEmptyString(payload.status);
  return {
    id,
    questions,
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    createdAtMs: typeof payload.createdAtMs === 'number' ? payload.createdAtMs : 0,
    expiresAtMs: typeof payload.expiresAtMs === 'number' ? payload.expiresAtMs : 0,
    ...(status ? { status } : {}),
  };
}

function canonicalValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * 校验一次作答：**所有问题都必须有答案**（网关那边少一个就整条 resolve 失败）。
 * 失败时返回的是 `header`（用户看得懂的名字），不是 `questionId`。
 */
export function resolveQuestionSelection(
  questions: PendingQuestion[],
  selection: QuestionSelection,
): QuestionSelectionResult {
  const answers: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const question of questions) {
    const values = canonicalValues(selection[question.questionId]);
    if (values.length === 0) {
      missing.push(question.header);
      continue;
    }
    if (!question.multiSelect && values.length > 1) {
      return { ok: false, missing: [], errorHeader: question.header, reason: 'single-select' };
    }
    answers[question.questionId] = values;
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, answers };
}

/** 组装 `question.resolve` 的作答参数。选择不完整时抛错（调用方应先校验）。 */
export function buildQuestionResolveParams(
  request: QuestionRequest,
  selection: QuestionSelection,
  resolvedBy: string,
): { id: string; answers: { answers: Record<string, string[]> }; resolvedBy: string } {
  const result = resolveQuestionSelection(request.questions, selection);
  if (!result.ok) {
    const why =
      result.reason === 'single-select' ? `只能选一个：${result.errorHeader}` : `未作答：${result.missing.join('、')}`;
    throw new Error(`question.resolve 参数不完整（${why}）`);
  }
  return { id: request.id, answers: { answers: result.answers }, resolvedBy };
}

/** 组装「取消 / 跳过」参数：agent 会拿到 `status: "no_answer"` 并自行决定怎么办。 */
export function buildQuestionCancelParams(
  id: string,
  resolvedBy: string,
): { id: string; cancel: true; resolvedBy: string } {
  return { id, cancel: true, resolvedBy };
}

function headerFor(questions: PendingQuestion[], questionId: string): string | null {
  return questions.find((question) => question.questionId === questionId)?.header ?? null;
}

const GENERIC_REQUIRES_ANSWER = '还有必答的问题没有选择，请在问题卡片里选完再发送。';

/**
 * 把网关的问答校验失败翻成中文。
 *
 * ⚠️ 硬要求（见 bug log）：**绝不能把 `doc_type` 这类内部字段名透给用户**。
 * 所以命中的 id 一律换成问题卡片上的 `header`，认不出 id 时给通用中文，
 * 不认识的错误返回 `null` 让调用方回退到原有的错误文案。
 */
export function describeQuestionFailure(
  raw: string | undefined,
  questions: PendingQuestion[],
  fallback: string,
): string | null {
  if (!raw) return null;
  const match = /question '([^']+)' ([^']+)/.exec(raw);
  if (!match) return null;
  const [, questionId, rawReason] = match;
  const reason = (rawReason ?? '').trim();
  const header = headerFor(questions, questionId ?? '');

  if (reason.startsWith('requires an answer')) {
    return header ? `请先选择「${header}」，再继续。` : GENERIC_REQUIRES_ANSWER;
  }
  if (reason.startsWith('contains an empty answer')) {
    return header ? `「${header}」的答案不能为空，请重新选择。` : '有问题的答案为空，请重新选择。';
  }
  if (reason.startsWith('does not allow multiple answers')) {
    return header ? `「${header}」只能选择一个答案。` : '有一题只能选择一个答案。';
  }
  if (reason.startsWith('contains an unknown option')) {
    return header ? `「${header}」的选项已失效，请重新选择。` : '有问题的选项已失效，请重新选择。';
  }
  if (reason.startsWith('is not part of this request')) {
    return '提交的答案和当前问题对不上，请重新回答。';
  }
  if (reason.startsWith('was not found')) {
    return '这个问题已经结束，请重新发送消息。';
  }
  if (reason.startsWith('is already')) {
    return '这个问题已经回答过了，请重新发送消息。';
  }
  return fallback;
}

/** 选项主标题：全称往往是「语文 —— 第一课《天地人》（识字）」这种，用户只会写前半截。 */
function optionHeadline(label: string): string {
  const [head] = label.split(/\s*(?:——|–|—|-{2,}|\/|｜|\||（|\()\s*/u);
  return (head ?? '').trim();
}

/**
 * 用户已经在原任务里说过的信息，就不再问第二遍。
 *
 * 命中规则（**刻意保守**，宁可漏补也不要替用户做错选择）：
 * - 文案里出现选项**全称**，或出现**主标题**（「语文」「教案」这种），算命中；
 * - 只有**唯一一个**选项命中时才预选 —— 同时命中两个（「教案」与「教案（详细）」）
 *   就当作没看出来；
 * - 多选问题一律不猜。
 */
export function autofillSelection(questions: PendingQuestion[], userText: string): QuestionSelection {
  const haystack = userText.trim().toLowerCase();
  if (!haystack) return {};
  const selection: QuestionSelection = {};
  for (const question of questions) {
    if (question.multiSelect) continue;
    const matched = question.options.filter((option) => {
      const label = option.label.trim().toLowerCase();
      if (haystack.includes(label)) return true;
      const headline = optionHeadline(label);
      return headline.length >= 2 && haystack.includes(headline);
    });
    if (matched.length === 1 && matched[0]) selection[question.questionId] = [matched[0].label];
  }
  return selection;
}

/** 网关到点会自己把问题置为 expired；本地只用来决定要不要继续展示卡片。 */
export function isQuestionExpired(request: Pick<QuestionRequest, 'expiresAtMs'>, now: number): boolean {
  if (!request.expiresAtMs) return false;
  return now > request.expiresAtMs;
}
