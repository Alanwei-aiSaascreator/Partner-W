import { describe, expect, it } from 'vitest';
import { describeGatewayError, translateGatewayError } from '../src/services/gateway-error-message.js';

describe('translateGatewayError —— 已知错误翻中文', () => {
  it('思考档位不支持（带 use 提示）', () => {
    // 原文来自 2026-09-11 实测网关日志
    const raw = 'thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/deepseek-r1）不支持「最低」档思考，只能用「关闭」。');
  });

  it('思考档位不支持（不带 use 提示）', () => {
    // ⚠️ 这里**刻意不再用 `adaptive` 举例**（2026-09-14）：客户端已经不再提供那个档位，
    //    用户遇不到它了。拿一个不可能出现的值当用例，这条翻译就成了空转。
    const raw = 'thinkingLevel "high" is not supported for clawrouter/some-off-only-model';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/some-off-only-model）不支持「高」档思考。');
  });

  it('档位 id 不认识时原样嵌入，不瞎猜', () => {
    const raw = 'thinkingLevel "xhigh" is not supported for clawrouter/some-model (use high)';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/some-model）不支持「极高」档思考，只能用「高」。');
  });

  it('选中了服务不了的模型', () => {
    const raw = 'The selected model was not found by the provider. Check the model id or choose a different model.';
    expect(translateGatewayError(raw)).toBe('该模型在当前服务上不存在。请换一个模型再试。');
  });

  it('结构化提问的答案没给全 —— 且不泄漏内部字段名', () => {
    // 2026-09-17 实机原文（`GatewayClientRequestError: ` 前缀是客户端包出来的）
    const raw = "GatewayClientRequestError: question 'doc_type' requires an answer";
    const translated = translateGatewayError(raw);
    expect(translated).toBe('还有必答的问题没有选择，请在问题卡片里选完再发送。');
    expect(translated).not.toContain('doc_type');
  });

  it('提问已经结束 / 已被回答', () => {
    expect(translateGatewayError("question 'ask_1' was not found")).toBe('这个问题已经结束，请重新发送消息。');
    expect(translateGatewayError("question 'ask_1' is already answered")).toBe(
      '这个问题已经回答过了，请重新发送消息。',
    );
  });
});

describe('translateGatewayError —— 认不出来要返回 null（由调用方回退原文）', () => {
  it('未知错误返回 null，不编文案', () => {
    expect(translateGatewayError('some brand new gateway wording')).toBeNull();
  });

  it('空 / undefined 返回 null', () => {
    expect(translateGatewayError('')).toBeNull();
    expect(translateGatewayError(undefined)).toBeNull();
  });
});

describe('describeGatewayError —— 界面用的统一入口', () => {
  it('已知错误给中文', () => {
    const raw = 'The selected model was not found by the provider.';
    expect(describeGatewayError(raw, '发送失败')).toBe('该模型在当前服务上不存在。请换一个模型再试。');
  });

  it('未知错误回退**网关原文**（而不是兜底文案）—— 原文比我们编的话准', () => {
    expect(describeGatewayError('ERR_UPSTREAM_QUOTA_EXCEEDED', '发送失败')).toBe('ERR_UPSTREAM_QUOTA_EXCEEDED');
  });

  it('连原文都没有才用兜底文案', () => {
    expect(describeGatewayError(undefined, '发送失败')).toBe('发送失败');
    expect(describeGatewayError('   ', '发送失败')).toBe('发送失败');
  });
});
