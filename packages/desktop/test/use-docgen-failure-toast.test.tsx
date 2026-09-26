// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocgenFailure } from '@clawwork/shared';

/**
 * 「有文件没生成」这条提示的**整条界面链**。
 *
 * ## 为什么挂真组件，而不是只测那个纯函数
 *
 * 这一族的 bug 长得是"handler 写了、页面没反应"（本项目栽过一次：16 条测试全绿
 * 而用户说"点了没反应"）。所以这里真的**挂一个宿主组件**、把 IPC 事件推给它、
 * 再断言 toast 真的带着正确文案出现了 —— 测的是"挂上之后世界会不会变"，
 * 不是"函数返回什么"。
 *
 * ## 为什么生产代码里是 `switch` 而不是「码 → key」的映射表
 *
 * （这条说明**故意放在测试里**：`src/renderer/**` 有"生产代码不写注释"的规矩。）
 *
 * 映射表要写成 `t(KEYS[failure.code])` 或 `` t(`docgen.${code}`) `` —— 两种写法
 * **都逃得过 i18n 门禁**：计算出来的 key 不在「代码里的字面量 key」集合里，
 * 于是"这个键没人用过"与"这个键根本不存在"两个方向同时失明；拼错的键也不报错，
 * 运行期只是把裸键名渲染到 toast 上。
 * 而 `switch` 有**穷尽性**：`DocgenFailure` 加了新成员，生产代码编译期就报错。
 * 下面每条 `expect(...).toBe('docgen.xxx({...})')` 同时钉住**选了哪个 key**与
 * **带了哪几个参数** —— 只断言"key 存在"是绑不住值的。
 */

const mocks = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn(), success: vi.fn(), plain: vi.fn() }));

vi.mock('@/lib/toast', () => ({
  toast: Object.assign(mocks.plain, { warning: mocks.warning, error: mocks.error, success: mocks.success }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 参数渲染出来（不是丢掉），这样断言能同时钉住"选了哪个 key"和"带了哪几个数"
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { docgenFailureMessage, docgenFailureToastBody } from '../src/renderer/lib/docgen-failure-copy';
import { useDocgenFailureToast } from '../src/renderer/hooks/useDocgenFailureToast';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}(${JSON.stringify(options)})` : key;

const PAGE_OVERFLOW: DocgenFailure = { code: 'presentation-page-overflow', format: 'pptx', page: 3 };
const TITLE_OVERFLOW: DocgenFailure = {
  code: 'presentation-page-title-overflow',
  format: 'pptx',
  page: 2,
  maxChars: 23,
};
const COVER_TITLE_OVERFLOW: DocgenFailure = {
  code: 'presentation-cover-title-overflow',
  format: 'pptx',
  maxChars: 36,
};
const COVER_SUBTITLE_OVERFLOW: DocgenFailure = {
  code: 'presentation-cover-subtitle-overflow',
  format: 'pptx',
  maxChars: 18,
};

describe('docgenFailureMessage —— 每种原因说**具体**的话，不说"生成失败"了事', () => {
  it('内容过多 ⇒ 说第几页', () => {
    expect(docgenFailureMessage(PAGE_OVERFLOW, t)).toBe('docgen.pageOverflow({"page":3})');
  });

  it('页标题过长 ⇒ 说第几页 + 能放几个字', () => {
    expect(docgenFailureMessage(TITLE_OVERFLOW, t)).toBe('docgen.pageTitleOverflow({"page":2,"maxChars":23})');
  });

  it('封面标题过长 ⇒ 带上能放几个字', () => {
    expect(docgenFailureMessage(COVER_TITLE_OVERFLOW, t)).toBe('docgen.coverTitleOverflow({"maxChars":36})');
  });

  it('封面副标题过长 ⇒ 走自己那条文案（不许和封面标题混成一句）', () => {
    expect(docgenFailureMessage(COVER_SUBTITLE_OVERFLOW, t)).toBe('docgen.coverSubtitleOverflow({"maxChars":18})');
  });

  it('封面标题里有换行 ⇒ 说清是封面标题、并说"写一行 / 拆页"', () => {
    expect(docgenFailureMessage({ code: 'presentation-cover-title-multiline', format: 'pptx' }, t)).toBe(
      'docgen.coverTitleMultiline',
    );
  });

  it('封面副标题里有换行 ⇒ 走自己那条（不与封面标题混成一句）', () => {
    expect(docgenFailureMessage({ code: 'presentation-cover-subtitle-multiline', format: 'pptx' }, t)).toBe(
      'docgen.coverSubtitleMultiline',
    );
  });

  it('页标题里有换行 ⇒ 说第几页', () => {
    expect(docgenFailureMessage({ code: 'presentation-slide-title-multiline', format: 'pptx', page: 2 }, t)).toBe(
      'docgen.slideTitleMultiline({"page":2})',
    );
  });

  it('要点里有换行 ⇒ 说第几页第几条（助手才知道改哪一条）', () => {
    expect(
      docgenFailureMessage({ code: 'presentation-slide-bullet-multiline', format: 'pptx', page: 3, bullet: 4 }, t),
    ).toBe('docgen.slideBulletMultiline({"page":3,"bullet":4})');
  });

  it('内容本身不合法 ⇒ 让用户重新出一份（而不是报一句内部错）', () => {
    expect(docgenFailureMessage({ code: 'request-invalid' }, t)).toBe('docgen.requestInvalid');
  });

  it('我们自己的意外 ⇒ 老实说"没能生成"，不编原因', () => {
    expect(docgenFailureMessage({ code: 'render-failed', format: 'docx' }, t)).toBe('docgen.renderFailed');
  });
});

describe('docgenFailureToastBody —— 一次只讲第一处，其余只报数', () => {
  it('只有一条 ⇒ 就是它本身', () => {
    expect(docgenFailureToastBody([PAGE_OVERFLOW], t)).toBe('docgen.pageOverflow({"page":3})');
  });

  it('多条 ⇒ 第一处 + "另有 N 份"（N 不含第一处）', () => {
    const body = docgenFailureToastBody([PAGE_OVERFLOW, TITLE_OVERFLOW, { code: 'request-invalid' }], t);
    expect(body).toBe('docgen.pageOverflow({"page":3})\ndocgen.moreFailures({"rest":2})');
  });

  it('空列表 ⇒ 空串（调用方据此不弹 toast）', () => {
    expect(docgenFailureToastBody([], t)).toBe('');
  });
});

describe('真实语言包：这些 key 九种语言都得有（缺一个就是界面上的裸键）', () => {
  const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh-TW', 'zh'];
  const KEYS = [
    'failedTitle',
    'pageOverflow',
    'pageTitleOverflow',
    'coverTitleOverflow',
    'coverSubtitleOverflow',
    'coverTitleMultiline',
    'coverSubtitleMultiline',
    'slideTitleMultiline',
    'slideBulletMultiline',
    'requestInvalid',
    'renderFailed',
    'moreFailures',
  ];

  for (const lang of LOCALES) {
    it(`${lang}.json 齐备，且没有空串`, () => {
      const file = join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales', `${lang}.json`);
      const docgen = (JSON.parse(readFileSync(file, 'utf8')) as { docgen?: Record<string, string> }).docgen;
      expect(docgen, `${lang}.json 里没有 docgen 段`).toBeTruthy();
      for (const key of KEYS) {
        expect(docgen?.[key], `${lang}.${key}`).toBeTruthy();
      }
    });
  }

  it('负对照：不存在的 key 读出来是 undefined（否则上面的断言可能恒真）', () => {
    const file = join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales', 'zh.json');
    const docgen = (JSON.parse(readFileSync(file, 'utf8')) as { docgen?: Record<string, string> }).docgen;
    expect(docgen?.['这段 key 压根不存在']).toBeUndefined();
  });
});

describe('useDocgenFailureToast —— 挂上去之后，事件真的会说话', () => {
  let push: ((failures: DocgenFailure[]) => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    push = null;
    unsubscribe.mockClear();
    mocks.error.mockClear();
    mocks.plain.mockClear();
    (window as unknown as { clawwork: unknown }).clawwork = {
      // ⚠️ 夹具必须**如实兑现退订**（真的 preload 会 `removeListener`，退订后回调不再被调用）。
      //    写成"返回一个假的退订、回调照旧能推"就会养出一类假绿：hook 忘了 return cleanup
      //    也照样绿 —— 而那正是这条测试要抓的东西。
      onDocgenFailed: (callback: (failures: DocgenFailure[]) => void) => {
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
    useDocgenFailureToast();
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
    act(() => push!([PAGE_OVERFLOW]));
    expect(mocks.error).toHaveBeenCalledWith('docgen.failedTitle', {
      description: 'docgen.pageOverflow({"page":3})',
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
    act(() => push?.([PAGE_OVERFLOW]));
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
