// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTMLGEN_SECTION_KINDS, HTMLGEN_TEMPLATES, type HtmlgenFailure } from '@clawwork/shared';

/**
 * 「网页没生成」这条提示的**整条界面链**（2026-09-27）。
 *
 * ## 为什么挂真组件，而不是只测那个纯函数
 *
 * 这一族的 bug 长得是"handler 写了、页面没反应"（本项目栽过一次：16 条测试全绿
 * 而用户说"点了没反应"）。所以这里真的**挂一个宿主组件**、把 IPC 事件推给它、
 * 再断言 toast 真的带着正确文案出现了。
 *
 * ## 为什么生产代码里是 `switch` 而不是「码 → key」的映射表
 *
 * （这条说明**故意放在测试里**，同 `use-docgen-failure-toast.test.tsx`。）
 * 映射表要写成 `t(KEYS[failure.code])` 或 `` t(`htmlgen.${code}`) `` —— 两种写法
 * **都逃得过 i18n 门禁**：计算出来的 key 不在「代码里的字面量 key」集合里，
 * 于是"这个键没人用过"与"这个键根本不存在"两个方向同时失明。
 * 而 `switch` 有**穷尽性**：`HtmlgenFailure` 加了新成员，生产代码编译期就报错。
 *
 * ⚠️ 版式名与小节类型名是**两个闭集**（`brief` / `metrics` 是英文短词，直接拼进中文句子
 *    用户看不懂），所以它们各自也是一个穷尽 `switch` —— 这里逐条钉住两个闭集**每个成员
 *    都有对应的 key**，加第六种版式时这条会红，而不是在界面上渲染出一个裸键。
 */

const mocks = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn(), plain: vi.fn() }));

vi.mock('@/lib/toast', () => ({
  toast: Object.assign(mocks.plain, { warning: mocks.warning, error: mocks.error, success: mocks.success }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 参数渲染出来（不是丢掉），这样断言能同时钉住"选了哪个 key"和"带了哪几个值"
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { htmlgenFailureMessage, htmlgenFailureToastBody } from '../src/renderer/lib/htmlgen-failure-copy';
import { useHtmlgenFailureToast } from '../src/renderer/hooks/useHtmlgenFailureToast';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}(${JSON.stringify(options)})` : key;

const BLOCK_INVALID: HtmlgenFailure = { code: 'htmlgen-block-invalid' };
const UNKNOWN_TEMPLATE: HtmlgenFailure = { code: 'htmlgen-unknown-template', template: 'dashboard' };
const TOO_THIN: HtmlgenFailure = { code: 'htmlgen-content-too-thin', template: 'data', needs: ['metrics', 'table'] };
const TOO_LARGE: HtmlgenFailure = { code: 'htmlgen-output-too-large', template: 'brief', maxBytes: 3 * 1024 * 1024 };

describe('htmlgenFailureMessage —— 每种原因说**具体**的话，不说"生成失败"了事', () => {
  it('内容没通过校验 ⇒ 让助手照文档重写一次', () => {
    expect(htmlgenFailureMessage(BLOCK_INVALID, t)).toBe('htmlgen.blockInvalid');
  });

  it('⭐ 未知版式 ⇒ 回显助手写的那串，并列出可用的（照技能文档改一次就好）', () => {
    expect(htmlgenFailureMessage(UNKNOWN_TEMPLATE, t)).toBe(
      'htmlgen.unknownTemplate({"template":"dashboard","allowed":"brief / proposal / research / plan / data"})',
    );
  });

  it('⭐ 协议外的字段 ⇒ 说清是**哪个字段**、以及"助手只能给内容"（这是安全失败）', () => {
    expect(htmlgenFailureMessage({ code: 'htmlgen-unsupported-field', field: 'sections[1].style' }, t)).toBe(
      'htmlgen.unsupportedField({"field":"sections[1].style"})',
    );
  });

  it('⭐ 内容太空 ⇒ 版式名与"它要的那类内容"都翻成人话（不是 `data` / `metrics`）', () => {
    expect(htmlgenFailureMessage(TOO_THIN, t)).toBe(
      'htmlgen.contentTooThin({"template":"htmlgen.template.data","needs":"htmlgen.section.metrics / htmlgen.section.table"})',
    );
  });

  it('太大 ⇒ 带上**真的**上限（文案里那句"控制在 N MB 以内"不能是编的）', () => {
    expect(htmlgenFailureMessage(TOO_LARGE, t)).toBe('htmlgen.outputTooLarge({"maxMb":3})');
  });

  it('我们自己的意外 ⇒ 老实说"没能生成"，不编原因', () => {
    expect(htmlgenFailureMessage({ code: 'htmlgen-render-failed', template: 'plan' }, t)).toBe('htmlgen.renderFailed');
  });
});

describe('htmlgenFailureToastBody —— 一次只讲第一处，其余只报数', () => {
  it('只有一条 ⇒ 就是它本身', () => {
    expect(htmlgenFailureToastBody([BLOCK_INVALID], t)).toBe('htmlgen.blockInvalid');
  });

  it('多条 ⇒ 第一处 + "另有 N 份"（N 不含第一处）', () => {
    expect(htmlgenFailureToastBody([BLOCK_INVALID, UNKNOWN_TEMPLATE, TOO_THIN], t)).toBe(
      'htmlgen.blockInvalid\nhtmlgen.moreFailures({"rest":2})',
    );
  });

  it('空列表 ⇒ 空串（调用方据此不弹 toast）', () => {
    expect(htmlgenFailureToastBody([], t)).toBe('');
  });
});

/**
 * ⚠️ 两个**闭集**（版式名、小节类型名）与失败码一样会长大。
 * 这里对每个成员各跑一遍消息函数，断言它**没有退回裸键** ——
 * 漏一个成员时，那个 key 会原样出现在 toast 上，而用户看到的是 `htmlgen.template.chart`。
 */
describe('闭集完整性：版式与小节类型每个成员都有自己的文案', () => {
  it('每个版式都有 key（少一个就是界面上的裸键）', () => {
    for (const template of HTMLGEN_TEMPLATES) {
      const message = htmlgenFailureMessage({ code: 'htmlgen-content-too-thin', template, needs: [] }, t);
      // ⚠️ 判据是**参数里带的是翻译键**，不是"消息里出现了这个子串" ——
      //    外层 key（`htmlgen.contentTooThin`）本来就在消息里，
      //    写成 toContain 的话这条会**恒真**（第一版就是这么错的，它红了才发现）。
      expect(message, template).toContain(`"template":"htmlgen.template.${template}"`);
    }
  });

  it('每种小节类型都有 key', () => {
    const message = htmlgenFailureMessage(
      { code: 'htmlgen-content-too-thin', template: 'brief', needs: [...HTMLGEN_SECTION_KINDS] },
      t,
    );
    for (const kind of HTMLGEN_SECTION_KINDS) {
      expect(message, kind).toContain(`htmlgen.section.${kind}`);
    }
  });
});

describe('真实语言包：这些 key 九种语言都得有（缺一个就是界面上的裸键）', () => {
  const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh-TW', 'zh'];
  const KEYS = [
    'failedTitle',
    'blockInvalid',
    'unknownTemplate',
    'unsupportedField',
    'contentTooThin',
    'outputTooLarge',
    'renderFailed',
    'moreFailures',
  ];

  for (const lang of LOCALES) {
    it(`${lang}.json 齐备，且没有空串`, () => {
      const file = join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales', `${lang}.json`);
      const htmlgen = (JSON.parse(readFileSync(file, 'utf8')) as { htmlgen?: Record<string, unknown> }).htmlgen;
      expect(htmlgen, `${lang}.json 里没有 htmlgen 段`).toBeTruthy();
      for (const key of KEYS) {
        expect(htmlgen?.[key], `${lang}.htmlgen.${key}`).toBeTruthy();
      }
      const template = htmlgen?.['template'] as Record<string, string> | undefined;
      const section = htmlgen?.['section'] as Record<string, string> | undefined;
      for (const id of HTMLGEN_TEMPLATES) {
        expect(template?.[id], `${lang}.htmlgen.template.${id}`).toBeTruthy();
      }
      for (const kind of HTMLGEN_SECTION_KINDS) {
        expect(section?.[kind], `${lang}.htmlgen.section.${kind}`).toBeTruthy();
      }
    });
  }

  it('负对照：不存在的 key 读出来是 undefined（否则上面的断言可能恒真）', () => {
    const file = join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales', 'zh.json');
    const htmlgen = (JSON.parse(readFileSync(file, 'utf8')) as { htmlgen?: Record<string, unknown> }).htmlgen;
    expect(htmlgen?.['这段 key 压根不存在']).toBeUndefined();
  });
});

describe('useHtmlgenFailureToast —— 挂上去之后，事件真的会说话', () => {
  let push: ((failures: HtmlgenFailure[]) => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    push = null;
    unsubscribe.mockClear();
    mocks.error.mockClear();
    mocks.plain.mockClear();
    (window as unknown as { clawwork: unknown }).clawwork = {
      // ⚠️ 夹具必须**如实兑现退订**（真的 preload 会 `removeListener`）：
      //    写成"返回一个假的退订、回调照旧能推"就会养出一类假绿 ——
      //    hook 忘了 return cleanup 也照样绿，而那正是这条要抓的。
      onHtmlgenFailed: (callback: (failures: HtmlgenFailure[]) => void) => {
        push = callback;
        return () => {
          unsubscribe();
          push = null;
        };
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { clawwork?: unknown }).clawwork;
  });

  function Probe(): ReactElement | null {
    useHtmlgenFailureToast();
    return null;
  }

  function mount(): { unmount: () => void } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(<Probe />));
    return {
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it('⭐ 挂载 + 推一条失败 ⇒ toast 带标题和正文出现', () => {
    mount();
    expect(push, '挂载后应当已经订阅上').toBeTypeOf('function');
    act(() => push!([BLOCK_INVALID]));
    expect(mocks.error).toHaveBeenCalledWith('htmlgen.failedTitle', {
      description: 'htmlgen.blockInvalid',
    });
  });

  it('空列表不弹（主进程说不推空列表，这里也不拿它当"发生了什么事"）', () => {
    mount();
    act(() => push!([]));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('卸载后不再说话（订阅真的被退掉了）', () => {
    const { unmount } = mount();
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
    mocks.error.mockClear();
    act(() => push?.([BLOCK_INVALID]));
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
