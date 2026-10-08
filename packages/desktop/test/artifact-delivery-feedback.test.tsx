// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliveryFailure, ArtifactDeliverySettled, Message } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';
import { artifactFailureContext, stripInternalFailureCodes } from '../src/renderer/lib/artifact-delivery-feedback';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';
import en from '../src/renderer/i18n/locales/en.json';
import zh from '../src/renderer/i18n/locales/zh.json';
import zhTW from '../src/renderer/i18n/locales/zh-TW.json';
import de from '../src/renderer/i18n/locales/de.json';
import es from '../src/renderer/i18n/locales/es.json';
import fr from '../src/renderer/i18n/locales/fr.json';
import ja from '../src/renderer/i18n/locales/ja.json';
import ko from '../src/renderer/i18n/locales/ko.json';
import pt from '../src/renderer/i18n/locales/pt.json';

afterEach(() => vi.unstubAllGlobals());

describe('artifact delivery failure feedback', () => {
  it('records the preload delivery outcome and unregisters both event subscriptions on unmount', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    useArtifactDeliveryStore.setState({ settled: [] });
    let settled: ((event: ArtifactDeliverySettled) => void) | undefined;
    const cleanupSettled = vi.fn();
    const cleanupViolation = vi.fn();
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onArtifactDeliverySettled: (callback: typeof settled) => {
          settled = callback;
          return cleanupSettled;
        },
        onClaimViolation: () => cleanupViolation,
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    const event: ArtifactDeliverySettled = {
      taskId: 'task-1',
      sessionKey: 'session-1',
      messageId: 'persisted-1',
      status: 'failed',
    };
    act(() => settled!(event));
    expect(useArtifactDeliveryStore.getState().settled).toEqual([event]);
    act(() => settled!({ ...event, messageId: 'persisted-2', status: 'succeeded' }));
    expect(useArtifactDeliveryStore.getState().settled).toHaveLength(2);
    act(() => root.unmount());
    expect(cleanupSettled).toHaveBeenCalledTimes(1);
    expect(cleanupViolation).toHaveBeenCalledTimes(1);
    useArtifactDeliveryStore.setState({ settled: [] });
  });

  it('persists one visible productized system note without sending a model request', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    const sendMessage = vi.fn();
    vi.stubGlobal('clawwork', undefined);
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
        sendMessage,
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    const event: ArtifactDeliveryFailure = {
      taskId: 'task-1',
      sessionKey: 'session-1',
      messageId: 'assistant-1',
      missing: ['report.pptx'],
      slideFailures: [
        {
          code: 'slidegen-unparsable',
          diagnostic: {
            code: 'dsl-close-mismatch',
            offset: 34,
            detail: 'expected </Text> but found </Slide>',
          },
        },
      ],
    };
    act(() => {
      callback!(event);
      callback!(event);
    });
    const messages = store.getState().messagesByTask['task-1'];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'system', sessionKey: 'session-1' });
    // 图12（2026-10-06）：便签在聊天里原样上屏 ⇒ 只出产品化文案
    expect(messages[0].content).toContain('slidegen.fail.unparsable');
    // 内部诊断码 / 英文解析器原文一律不上用户面（原始对象改走 console）
    expect(messages[0].content).not.toContain('dsl-close-mismatch');
    expect(messages[0].content).not.toContain('expected </Text> but found </Slide>');
    expect(messages[0].content).not.toContain('@34');
    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(artifactFailureContext(messages, 'session-1')).toContain('slidegen.fail.unparsable');
    expect(artifactFailureContext(messages, 'session-1')).not.toContain('dsl-close-mismatch');
    expect(artifactFailureContext(messages, 'other-session')).toBe('');
    act(() => root.unmount());
  });

  it('图12：claim-violation 系统便签只含产品化文案，原始 JSON / 内部诊断码不上屏', () => {
    /**
     * 2026-10-06 商业验收（图12）：这条便签在聊天里是**原样上屏**的（ChatMessage 的
     * alert 框整段渲染），却被拼进了 `JSON.stringify(failure)` 与
     * `[diagnostic.code @offset] detail` —— 内部码与英文解析器原文直接摆给付费用户。
     * 原始对象改走 console，用户面只留产品化中文；下一轮模型上下文仍拿得到这条便签。
     */
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    act(() => {
      callback!({
        taskId: 'task-1',
        sessionKey: 'session-1',
        messageId: 'assistant-1',
        missing: ['report.pptx'],
        missingKinds: ['PPT/PPTX 演示文稿'],
        slideFailures: [
          {
            code: 'slidegen-unparsable',
            diagnostic: {
              code: 'dsl-close-mismatch',
              offset: 34,
              detail: 'expected </Text> but found </Slide>',
            },
          },
        ],
        docFailures: [{ code: 'request-invalid' }],
        htmlFailures: [{ code: 'htmlgen-unsupported-field', field: 'sections[0].style' }],
        mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }],
      });
    });
    const messages = store.getState().messagesByTask['task-1'] ?? [];
    const content = messages[0]?.content ?? '';
    // 产品化文案在（每一档都要有可行动的那句话）
    for (const productized of [
      'slidegen.fail.unparsable',
      'docgen.requestInvalid',
      'htmlgen.unsupportedField',
      'claimGuard.mediaUnavailableBody',
      'claimGuard.missingKindsBody',
    ]) {
      expect(content, `便签要有产品化文案 ${productized}`).toContain(productized);
    }
    // 原始内部信息一个都不许在 —— 这正是图12 的验收线
    for (const raw of [
      'dsl-close-mismatch',
      'expected </Text> but found </Slide>',
      'request-invalid',
      '"code"',
      '"reason"',
      '{',
    ]) {
      expect(content, `用户面不得出现 ${raw}`).not.toContain(raw);
    }
    // 产品化之后，下一轮模型上下文仍拿得到这条便签（它没被吞掉）
    expect(artifactFailureContext(messages, 'session-1')).toContain('slidegen.fail.unparsable');
    act(() => root.unmount());
  });

  const makeMessage = (role: Message['role'], content: string, id: string = role): Message => ({
    id,
    taskId: 'task-1',
    sessionKey: 'session-1',
    role,
    content,
    timestamp: '2026-09-29T00:00:00.000Z',
    artifacts: [],
    toolCalls: [],
  });

  it('keeps the latest failure note after a subsequent user turn, but never an assistant-authored lookalike', () => {
    const note = makeMessage('system', '[artifact-delivery-failed]\nmissing report.pptx');
    expect(artifactFailureContext([note], 'session-1')).toContain('report.pptx');
    /*
      ⚠️ 区1 体检 P3-2（有意反转）：便签是**去重**的（同因再失败不再追加，见 `useClaimGuardToast`）——
      扫到第一条 user 消息就 `break`，等于把唯一一份诊断丢在"当前轮"之外：
      模型侧拿不到它，只能凭记忆瞎猜。用户侧没有新红框是预期，但诊断不能被一起拿走。
    */
    expect(artifactFailureContext([note, makeMessage('user', 'continue')], 'session-1')).toContain('report.pptx');
    // 助手自述里抄一份同样的文本**不算**便签（只有系统便签才是判据）
    expect(artifactFailureContext([makeMessage('assistant', note.content)], 'session-1')).toBe('');
    // 别的会话的便签不进这个会话的上下文
    expect(artifactFailureContext([note], 'other-session')).toBe('');
  });

  it('⭐ 同 task 两轮失败（中间夹 user 消息）⇒ 第二轮上下文仍含最近一条便签', () => {
    const firstRound = makeMessage('system', '[artifact-delivery-failed]\n第 1 轮：missing report.pptx', 'note-1');
    const messages: Message[] = [
      firstRound,
      makeMessage('user', '再试一次', 'user-1'),
      makeMessage('assistant', '好的，我重新生成', 'assistant-1'),
      makeMessage('system', '[artifact-delivery-failed]\n第 2 轮：missing report.pptx', 'note-2'),
    ];

    const context = artifactFailureContext(messages, 'session-1');
    expect(context).toContain('第 2 轮');
    expect(context, '只带最近一条，旧的不再重放').not.toContain('第 1 轮');
  });

  it('去重后只剩旧便签（同因再失败不追加）⇒ 后续轮次照样拿得到它', () => {
    // 这一条模拟真机形态：第二轮的重复失败**不写新便签**（内容完全相同被去重），
    // 于是唯一那条便签落在两条 user 消息之前。
    const note = makeMessage('system', '[artifact-delivery-failed]\nmissing report.pptx', 'note-only');
    const messages: Message[] = [
      note,
      makeMessage('user', '继续', 'user-1'),
      makeMessage('assistant', '好的', 'assistant-1'),
      makeMessage('user', '还是没看到文件', 'user-2'),
    ];

    expect(artifactFailureContext(messages, 'session-1')).toContain('report.pptx');
  });

  /**
   * 区1 体检 P3-3：便签正文里的内部码（`[artifact.claim-guard.missing]`）是**给模型看的判据**，
   * 但它同时是聊天红框的可见文本 —— 只在**渲染层**剥掉方括号码，存和发一个字符都不动。
   */
  describe('stripInternalFailureCodes（内部码不上屏，模型上下文保留）', () => {
    it('剥掉行首的内部码，留下它后面的人话', () => {
      expect(
        stripInternalFailureCodes('[artifact.claim-guard.missing] 回复里提到了 a.pptx，工作区里没有这些文件。'),
      ).toBe('回复里提到了 a.pptx，工作区里没有这些文件。');
      expect(
        stripInternalFailureCodes('[artifact-delivery-failed]\n[artifact.claim-guard.missing-kinds] 成果没有登记。'),
      ).toBe('成果没有登记。');
    });

    it('句中的方括号 / 中文方括号 / 带空格的诊断标记不动', () => {
      expect(stripInternalFailureCodes('生成的【重要】说明')).toBe('生成的【重要】说明');
      expect(stripInternalFailureCodes('见 [report.pptx] 这一项')).toBe('见 [report.pptx] 这一项');
      expect(stripInternalFailureCodes('[dsl-close-mismatch @34] expected </Text>')).toBe(
        '[dsl-close-mismatch @34] expected </Text>',
      );
    });

    it('发往模型的内容不变：便签原文（含内部码）仍在诊断上下文里', () => {
      const note = makeMessage(
        'system',
        '[artifact-delivery-failed]\n[artifact.claim-guard.missing] 回复里提到了 a.pptx，工作区里没有这些文件。',
      );

      expect(stripInternalFailureCodes(note.content)).not.toContain('[artifact.claim-guard.missing]');
      expect(artifactFailureContext([note], 'session-1')).toContain('[artifact.claim-guard.missing]');
    });
  });

  it('says "not registered" for missing kinds instead of "not in the workspace"', () => {
    /**
     * 2026-10-04 真机：两份改稿都在盘上，界面却说「工作区里没有这些文件」——
     * 真形态是**没登记到成果列表**。missingKinds 走自己的话术，不下「不存在」的结论。
     */
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.toast.mockClear();
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    act(() => {
      callback!({
        taskId: 'task-1',
        sessionKey: 'session-1',
        messageId: 'assistant-1',
        missing: [],
        missingKinds: ['PPT/PPTX 演示文稿'],
      });
    });
    expect(mocks.toast).toHaveBeenCalledWith('claimGuard.missingKindsTitle', {
      description: 'claimGuard.missingKindsBody',
    });
    expect(mocks.toast).not.toHaveBeenCalledWith('claimGuard.missingTitle', expect.anything());
    const content = (store.getState().messagesByTask['task-1'] ?? []).map((message) => message.content).join('\n');
    expect(content).toContain('[artifact.claim-guard.missing-kinds]');
    expect(content).not.toContain('[artifact.claim-guard.missing] ');
    act(() => root.unmount());
  });

  it('keeps the physical-missing copy for claimed files that are not on disk', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.toast.mockClear();
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    act(() => {
      callback!({ taskId: 'task-1', sessionKey: 'session-1', messageId: 'assistant-1', missing: ['gone.pptx'] });
    });
    expect(mocks.toast).toHaveBeenCalledWith('claimGuard.missingTitle', { description: 'claimGuard.missingBody' });
    expect(mocks.toast).not.toHaveBeenCalledWith('claimGuard.missingKindsTitle', expect.anything());
    act(() => root.unmount());
  });

  it('all supported languages translate the claim guard copy', () => {
    const keys = [
      // ⭐ BUG-042-c：写出的文件不是有效文档（JSON 改名成 .docx 之类）的那两句。
      'invalidArtifactBody',
      'invalidArtifactTitle',
      'mediaUnavailableBody',
      'mediaUnavailableTitle',
      'missingBody',
      'missingKindsBody',
      'missingKindsTitle',
      'missingTitle',
    ];
    for (const locale of [en, zh, zhTW, de, es, fr, ja, ko, pt]) {
      expect(Object.keys(locale.claimGuard).sort()).toEqual(keys);
      expect(locale.claimGuard.missingKindsBody).toContain('{{names}}');
      // 文件名要进那句话里（插值丢了等于说不清是哪一份）
      expect(locale.claimGuard.invalidArtifactBody).toContain('{{names}}');
    }
  });

  it.each([
    { mediaFailures: [{ fileName: 'clip.mp4', reason: 'unavailable' }], expected: 'claimGuard.mediaUnavailableBody' },
    { docFailures: [{ code: 'request-invalid' }], expected: 'docgen.requestInvalid' },
    {
      htmlFailures: [{ code: 'htmlgen-unsupported-field', field: 'sections[0].style' }],
      expected: 'htmlgen.unsupportedField',
    },
  ])('persists productized non-slide diagnostics for the next user turn: $expected', (failure) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const persistMessage = vi.fn(async () => ({ ok: true }));
    const store = createMessageStore({ persistMessage });
    mocks.getState.mockImplementation(store.getState);
    let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        onClaimViolation: (cb: typeof callback) => {
          callback = cb;
          return () => {};
        },
      },
    });
    const root = createRoot(document.createElement('div'));
    function Harness() {
      useClaimGuardToast();
      return null;
    }
    act(() => root.render(<Harness />));
    act(() => {
      const event = {
        taskId: 'task-1',
        sessionKey: 'session-1',
        messageId: 'assistant-1',
        missing: [],
        ...failure,
      } as ArtifactDeliveryFailure;
      callback!(event);
      callback!(event);
    });
    const messages = store.getState().messagesByTask['task-1'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(persistMessage).toHaveBeenCalledTimes(1);
    // 图12：便签里只留产品化中文——`JSON.stringify(failure)` 原样对象不再上屏
    expect(messages[0].content).not.toContain('{');
    expect(messages[0].content).not.toContain('"code"');
    expect(artifactFailureContext(messages, 'session-1')).toContain(failure.expected);
    if ('mediaFailures' in failure) {
      act(() => {
        const laterFailure: ArtifactDeliveryFailure = {
          taskId: 'task-1',
          sessionKey: 'session-1',
          messageId: 'assistant-1',
          missing: [],
          docFailures: [{ code: 'request-invalid' }],
        };
        callback!(laterFailure);
        callback!(laterFailure);
      });
      const updated = store.getState().messagesByTask['task-1'] ?? [];
      expect(updated).toHaveLength(2);
      expect(persistMessage).toHaveBeenCalledTimes(2);
      expect(updated.map((message) => message.content).join('\n')).toContain('claimGuard.mediaUnavailableBody');
      expect(artifactFailureContext(updated, 'session-1')).toContain('docgen.requestInvalid');
    }
    act(() => root.unmount());
  });
});
