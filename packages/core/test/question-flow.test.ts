import { describe, expect, it } from 'vitest';
import {
  autofillSelection,
  buildQuestionResolveParams,
  buildQuestionCancelParams,
  describeQuestionFailure,
  isQuestionExpired,
  parseQuestionRequest,
  resolveQuestionSelection,
  type QuestionRequest,
  type QuestionSelectionResult,
} from '../src/services/question-flow';

/**
 * 真实样本：2026-09-17 05:12:05 客户端收到的 `question.requested` 事件
 * （取自 `%APPDATA%/@clawwork/desktop/logs/debug-2026-09-17.ndjson`），
 * 只截短了部分文案。用户在这条问题挂起期间发的每一条消息都被网关当作
 * 「答案」吃掉，直到 05:21:01 用户点了中止才恢复。
 */
const REAL_PAYLOAD = {
  id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
  questions: [
    {
      questionId: 'subject',
      header: '科目',
      question: '人教版一年级第一节课，你是指哪个科目？',
      options: [
        { label: '语文 —— 第一课《天地人》（识字）', description: '部编版一年级上册语文第一课' },
        { label: '数学 —— 第一课《数一数》（准备课）', description: '一年级上册数学第一课' },
        { label: '英语 —— Starter/第一单元', description: '一年级起点英语第一课' },
      ],
      isOther: true,
    },
    {
      questionId: 'doc_type',
      header: '文档类型',
      question: '你需要什么类型的文档？',
      options: [
        { label: '教案（教学设计）', description: '供老师使用的完整教学设计方案' },
        { label: '课文讲解 / 家长辅导材料', description: '供家长辅导孩子用的材料' },
        { label: '学生练习 / 作业纸', description: '配合课堂使用的练习' },
      ],
      isOther: true,
    },
  ],
  agentId: 'partner-w-content',
  sessionKey: 'agent:partner-w-content:clawwork:abc:task:7efb7719',
  runId: '4214a221-f56a-4ca2-889c-90bae13dc9d6',
  createdAtMs: 1789621925220,
  expiresAtMs: 1789622825220,
  status: 'pending',
};

/**
 * 取出「作答不完整」那一支并**收窄类型**。
 * `expect(x.ok).toBe(false)` 只是运行期断言，TS 不会因此收窄联合类型 ——
 * 直接访问 `x.missing` 连 `typecheck:tests` 都过不了。
 */
function expectIncomplete(result: QuestionSelectionResult): Extract<QuestionSelectionResult, { ok: false }> {
  if (result.ok) throw new Error('期望这次作答被判为不完整，但它通过了');
  return result;
}

function request(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  const parsed = parseQuestionRequest(REAL_PAYLOAD);
  if (!parsed) throw new Error('fixture failed to parse');
  return { ...parsed, ...overrides };
}

describe('parseQuestionRequest', () => {
  it('parses the real gateway payload', () => {
    const parsed = parseQuestionRequest(REAL_PAYLOAD);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('ask_b331b9ae631f740e1cecf8b24115aaf8');
    expect(parsed?.questions).toHaveLength(2);
    expect(parsed?.questions[1]?.questionId).toBe('doc_type');
    expect(parsed?.questions[1]?.header).toBe('文档类型');
    expect(parsed?.expiresAtMs).toBe(1789622825220);
  });

  it('drops questions without an id, a header or any option', () => {
    const parsed = parseQuestionRequest({
      id: 'ask_x',
      questions: [
        { questionId: '', header: '科目', question: 'q', options: [] },
        { questionId: 'ok', header: '', question: 'q', options: [{ label: 'A' }] },
        { questionId: 'good', header: '科目', question: 'q', options: [{ label: 'A' }] },
      ],
      createdAtMs: 1,
      expiresAtMs: 2,
    });
    expect(parsed?.questions.map((q) => q.questionId)).toEqual(['good']);
  });

  it('returns null for payloads that are not question requests', () => {
    expect(parseQuestionRequest(undefined)).toBeNull();
    expect(parseQuestionRequest({})).toBeNull();
    expect(parseQuestionRequest({ id: 'ask_x' })).toBeNull();
    expect(parseQuestionRequest({ id: 'ask_x', questions: 'nope' })).toBeNull();
    // 一个问题都不合法时整条请求作废，避免渲染出空卡片
    expect(parseQuestionRequest({ id: 'ask_x', questions: [{ questionId: '', header: '', options: [] }] })).toBeNull();
  });
});

describe('resolveQuestionSelection', () => {
  it('accepts a selection that answers every question', () => {
    const result = resolveQuestionSelection(request().questions, {
      subject: ['语文 —— 第一课《天地人》（识字）'],
      doc_type: ['教案（教学设计）'],
    });
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      answers: {
        subject: ['语文 —— 第一课《天地人》（识字）'],
        doc_type: ['教案（教学设计）'],
      },
    });
  });

  it('reports the missing questions by their user-facing header, not the internal id', () => {
    const result = resolveQuestionSelection(request().questions, {
      subject: ['语文 —— 第一课《天地人》（识字）'],
    });
    const incomplete = expectIncomplete(result);
    expect(incomplete.missing).toEqual(['文档类型']);
    expect(JSON.stringify(result)).not.toContain('doc_type');
  });

  it('treats whitespace-only and empty selections as unanswered', () => {
    const result = resolveQuestionSelection(request().questions, {
      subject: ['   '],
      doc_type: [],
    });
    expect(expectIncomplete(result).missing).toEqual(['科目', '文档类型']);
  });

  it('trims answers and drops empty entries inside a multi-value answer', () => {
    const result = resolveQuestionSelection(
      [{ questionId: 'subject', header: '科目', question: 'q', options: [{ label: 'A' }], multiSelect: true }],
      { subject: [' A ', ''] },
    );
    expect(result).toMatchObject({ ok: true, answers: { subject: ['A'] } });
  });

  it('rejects more than one answer for a single-select question', () => {
    const result = resolveQuestionSelection(request().questions, {
      subject: ['语文 —— 第一课《天地人》（识字）', '数学 —— 第一课《数一数》（准备课）'],
      doc_type: ['教案（教学设计）'],
    });
    const incomplete = expectIncomplete(result);
    expect(incomplete.missing).toEqual([]);
    expect(incomplete.errorHeader).toBe('科目');
    expect(incomplete.reason).toBe('single-select');
  });
});

describe('buildQuestionResolveParams', () => {
  it('produces the exact closed-schema payload the gateway accepts', () => {
    const params = buildQuestionResolveParams(
      request(),
      {
        subject: ['语文 —— 第一课《天地人》（识字）'],
        doc_type: ['教案（教学设计）'],
      },
      'user',
    );
    expect(params).toEqual({
      id: 'ask_b331b9ae631f740e1cecf8b24115aaf8',
      answers: {
        answers: {
          subject: ['语文 —— 第一课《天地人》（识字）'],
          doc_type: ['教案（教学设计）'],
        },
      },
      resolvedBy: 'user',
    });
    // closedObject：多余字段会被网关拒绝
    expect(Object.keys(params).sort()).toEqual(['answers', 'id', 'resolvedBy']);
  });

  it('builds the cancel payload', () => {
    expect(buildQuestionCancelParams('ask_1', 'user')).toEqual({ id: 'ask_1', cancel: true, resolvedBy: 'user' });
  });
});

describe('describeQuestionFailure', () => {
  it('turns the raw gateway error into Chinese without leaking the field id', () => {
    const message = describeQuestionFailure(
      "GatewayClientRequestError: question 'doc_type' requires an answer",
      request().questions,
      '发送失败',
    );
    expect(message).toBe('请先选择「文档类型」，再继续。');
    expect(message).not.toContain('doc_type');
    expect(message).not.toContain('GatewayClientRequestError');
  });

  it('names every unanswered question in question order', () => {
    const message = describeQuestionFailure("question 'subject' requires an answer", request().questions, '发送失败');
    expect(message).toBe('请先选择「科目」，再继续。');
  });

  it('falls back to a generic Chinese hint when the id is unknown', () => {
    const message = describeQuestionFailure("question 'mystery_field' requires an answer", [], '发送失败');
    expect(message).toBe('还有必答的问题没有选择，请在问题卡片里选完再发送。');
    expect(message).not.toContain('mystery_field');
  });

  it('translates the other answer-validation failures', () => {
    const questions = request().questions;
    expect(describeQuestionFailure("question 'subject' contains an empty answer", questions, 'f')).toBe(
      '「科目」的答案不能为空，请重新选择。',
    );
    expect(describeQuestionFailure("question 'subject' does not allow multiple answers", questions, 'f')).toBe(
      '「科目」只能选择一个答案。',
    );
    expect(describeQuestionFailure("question 'subject' contains an unknown option", questions, 'f')).toBe(
      '「科目」的选项已失效，请重新选择。',
    );
    expect(describeQuestionFailure("question 'ask_1' was not found", questions, 'f')).toBe(
      '这个问题已经结束，请重新发送消息。',
    );
    expect(describeQuestionFailure("question 'ask_1' is already answered", questions, 'f')).toBe(
      '这个问题已经回答过了，请重新发送消息。',
    );
  });

  it('returns null for errors that are not about questions', () => {
    expect(
      describeQuestionFailure('The selected model was not found by the provider.', request().questions, 'f'),
    ).toBeNull();
    expect(describeQuestionFailure('', request().questions, 'f')).toBeNull();
    expect(describeQuestionFailure(undefined, request().questions, 'f')).toBeNull();
  });
});

describe('autofillSelection', () => {
  it('preselects an option the user already named in the task text', () => {
    const selection = autofillSelection(
      request().questions,
      '帮我写一个小学一年级人教版的第一节课的word，要教案（教学设计）',
    );
    expect(selection).toEqual({ doc_type: ['教案（教学设计）'] });
  });

  it('matches the option headline when the user only typed that part', () => {
    // 真实案例：用户写「人教版语文《天地人》的完整教案 Word」，
    // 而选项全称是「语文 —— 第一课《天地人》（识字）」。只认全称等于不补全。
    const selection = autofillSelection(request().questions, '帮我写一个小学一年级人教版语文《天地人》的完整教案 Word');
    expect(selection).toEqual({
      subject: ['语文 —— 第一课《天地人》（识字）'],
      doc_type: ['教案（教学设计）'],
    });
  });

  it('matches option labels case-insensitively after trimming', () => {
    const selection = autofillSelection(
      [{ questionId: 'lang', header: '语言', question: 'q', options: [{ label: 'Word' }] }],
      '给我一个 word 文件',
    );
    expect(selection).toEqual({ lang: ['Word'] });
  });

  it('does not guess when nothing matches or when two options match', () => {
    expect(autofillSelection(request().questions, '随便写点什么')).toEqual({});
    // 「教案」与「教案（详细）」**都**是文案的子串 ⇒ 有歧义，不替用户做决定
    expect(
      autofillSelection(
        [{ questionId: 't', header: 'T', question: 'q', options: [{ label: '教案' }, { label: '教案（详细）' }] }],
        '要教案（详细）的',
      ),
    ).toEqual({});
  });

  it('picks the option when the user typed its exact label and nothing else matches', () => {
    expect(
      autofillSelection(
        [{ questionId: 't', header: 'T', question: 'q', options: [{ label: '教案' }, { label: '学生练习 / 作业纸' }] }],
        '要教案',
      ),
    ).toEqual({ t: ['教案'] });
  });

  it('never autofills multi-select questions', () => {
    expect(
      autofillSelection(
        [{ questionId: 't', header: 'T', question: 'q', options: [{ label: '教案' }], multiSelect: true }],
        '要教案',
      ),
    ).toEqual({});
  });
});

describe('isQuestionExpired', () => {
  it('compares against the gateway expiry with a small clock skew allowance', () => {
    const q = request();
    expect(isQuestionExpired(q, q.expiresAtMs - 5_000)).toBe(false);
    expect(isQuestionExpired(q, q.expiresAtMs + 1)).toBe(true);
  });
});
