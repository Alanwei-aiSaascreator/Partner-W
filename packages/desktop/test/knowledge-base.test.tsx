// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 资料库面板。
 *
 * ## 钉的是两件**很容易混起来**的事
 *
 * ① **`not-ready` ≠ "还没有资料"**：运行时是工作区就绪之后**异步**建的（要读 90MB
 *    嵌入模型），界面可能在那之前就问上来。要是两者都显示成"还没有资料"，
 *    用户会以为**自己加的东西丢了** —— 而其实只是还没准备好。
 * ② **没有引擎 ≠ 出错**：模型没打进包 / 被杀软拦都会让引擎起不来，这时是**合法降级**
 *    成关键词检索。用提示条说明，**不能**弹报错、更不能让搜索不可用。
 *
 * ⚠️ 这两条都属于"不报错、只是体验变差"，线上没人会报 bug，所以只能靠测试钉。
 */
// ⚠️ `t` 必须是**稳定引用**：组件里有 `useCallback([t])` + `useEffect([refresh, t])`，
//    桩每次渲染返回新的函数 ⇒ 依赖每次都变 ⇒ 无限重渲（实测：5 条用例全 35 秒超时）。
//    真实的 i18next 只在切语言时才换 `t`，所以这不是组件的问题，是桩写得不像。
const stableT = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: stableT }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactElement }) => children,
  motion: { div: 'div', span: 'span' },
}));
vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATS = { sources: 0, chunks: 0, byState: {}, meta: { embeddingModel: null, dim: null, updatedAt: '' } };

/**
 * 桩里所有返回值都写成**同形的大白话**（`ok: true`、`status: 'indexed'`…），
 * 而真接口是字面量联合 —— 直接赋值会被 TS 推宽而报错。
 * 测试脚手架不值得为每个字段逐处 `as const`，整体转一次即可（这里没有类型价值可丢）。
 */
function stubClawwork(overrides: Partial<Record<string, unknown>>): void {
  const api = {
    kbStats: vi.fn(async () => ({ ok: true, stats: STATS, engine: null })),
    kbListSources: vi.fn(async () => ({ ok: true, sources: [] })),
    kbPickFiles: vi.fn(async () => ({ ok: true, paths: [] })),
    kbAddFile: vi.fn(async () => ({
      ok: true,
      outcome: { status: 'indexed', chunkCount: 1, embeddedCount: 1, pendingCount: 0 },
    })),
    kbRemoveSource: vi.fn(async () => ({ ok: true, removed: true })),
    kbSearch: vi.fn(async () => ({
      ok: true,
      outcome: { hits: [], mode: 'keyword', degraded: true, degradedReason: 'no-engine', candidateCount: 0 },
    })),
    kbIndexPending: vi.fn(async () => ({
      ok: true,
      report: { attempted: 0, embedded: 0, failed: 0, engineError: null },
    })),
    kbRebuild: vi.fn(async () => ({
      ok: true,
      report: { sources: 0, chunks: 0, attempted: 0, embedded: 0, failed: 0, engineError: null },
    })),
    ...overrides,
  };
  // 断言成 `never` 只是为了让 TS 闭嘴：这里**故意**只造用到的那几个方法，
  // 全接口 200 多个方法对测试没有价值。缺方法时的表现是"运行时 undefined"，
  // 而本文件每个用例都只碰自己 stub 过的那几个。
  (globalThis as unknown as { window: { clawwork: unknown } }).window.clawwork = api as never;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // ⚠️ `toast` 的桩是 `vi.mock` 工厂建的、**整个文件共享一份**，不像 `stubClawwork`
  //    那样每个用例现造。不清调用记录的话，上一个用例喊过的 `kb.rebuildDone`
  //    会留到这一个里，让 `not.toHaveBeenCalledWith` 变成假红（真踩过一次）。
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 渲染并等首屏那两问落地。 */
async function renderPanel(): Promise<void> {
  const { default: KnowledgeBase } = await import('../src/renderer/layouts/KnowledgeBase');
  await act(async () => {
    root.render(<KnowledgeBase />);
  });
  // 首屏是两次 await（kbStats + kbListSources），多刷一轮让 setState 落地
  await act(async () => {
    await Promise.resolve();
  });
}

/** Radix 的弹层走 portal 挂到 body ⇒ 断言要看 `document.body`，不是 container。 */
const bodyText = (): string => document.body.textContent ?? '';
/** 按文案找按钮。找不到时**直接抛**：静默返回 undefined 会让后面的断言变成假绿。 */
const findButton = (text: string): HTMLButtonElement => {
  const btn = [...document.body.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
  if (!btn) throw new Error(`找不到按钮：${text}`);
  return btn as HTMLButtonElement;
};
const clickByText = (text: string): void => {
  const btn = findButton(text);
  act(() => btn.click());
};

describe('新建笔记（T-c1）', () => {
  it('⭐ 点「新建笔记」弹出对话框（不是直接建一条空笔记）', async () => {
    stubClawwork({});
    await renderPanel();

    expect(bodyText()).not.toContain('kb.noteTitle');
    clickByText('kb.addNote');
    expect(bodyText()).toContain('kb.noteTitle');
  });

  it('⭐ 标题或正文为空 ⇒ **不提交**，并给出可读提示（不能静默什么都没发生）', async () => {
    const kbAddNote = vi.fn(async () => ({
      ok: true,
      outcome: { status: 'indexed', chunkCount: 1, embeddedCount: 1, pendingCount: 0 },
    }));
    stubClawwork({ kbAddNote });
    await renderPanel();
    clickByText('kb.addNote');

    // 什么都不填直接点「创建」
    clickByText('kb.noteCreate');

    expect(kbAddNote, '空笔记不该发出去').not.toHaveBeenCalled();
    // 提示必须出现 —— 静默失败会让用户以为按钮坏了
    expect(bodyText()).toContain('kb.noteNeedContent');
  });

  it('填好标题与正文 ⇒ 调 kbAddNote 带上参数，并关掉对话框', async () => {
    const kbAddNote = vi.fn(async () => ({
      ok: true,
      outcome: { status: 'indexed', chunkCount: 1, embeddedCount: 1, pendingCount: 0 },
    }));
    stubClawwork({ kbAddNote });
    await renderPanel();
    clickByText('kb.addNote');

    // ⚠️ 必须**限定在对话框里**查：`document.body` 还挂着面板自己的搜索框，
    //    按全局顺序取会因为"第一个 input 是搜索框"而抓错元素（测验改过一次）。
    const dialog = document.querySelector('[data-testid="kb-note-dialog"]');
    expect(dialog, '对话框应挂了 kb-note-dialog').not.toBeNull();
    const inputs = [...dialog!.querySelectorAll('input, textarea')] as (HTMLInputElement | HTMLTextAreaElement)[];
    expect(inputs.length, '对话框里应有标题与正文两个输入').toBe(2);
    // ⚠️ setter 要**按元素各自取**：标题是 `<input>`、正文是 `<textarea>`，
    //    拿 input 的 setter 去写 textarea 会抛 "not a valid instance"。
    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setValue(inputs[0], '会议纪要');
      setValue(inputs[1], '今天定了三件事。');
    });

    await act(async () => {
      clickByText('kb.noteCreate');
    });

    expect(kbAddNote).toHaveBeenCalledWith({ title: '会议纪要', text: '今天定了三件事。' });
    expect(bodyText(), '提交后对话框该关掉').not.toContain('kb.noteTitle');
  });
});

describe('重建索引（T-c1 第二条）', () => {
  /**
   * 重建按钮按 **testid** 找，不按文字：它的两种文案互为前缀
   *（`kb.rebuilding` 里就含 `kb.rebuild`），按文字找会在重建中抓错元素、把那句断言变成假绿。
   */
  const rebuildButton = (): HTMLButtonElement => {
    const el = document.querySelector('[data-testid="kb-rebuild"]');
    if (!el) throw new Error('找不到重建索引按钮（data-testid="kb-rebuild"）');
    return el as HTMLButtonElement;
  };
  const clickRebuild = async (): Promise<void> => {
    await act(async () => {
      rebuildButton().click();
    });
  };
  /** 拿到被桩掉的 toast，用来断言"到底说了哪句话"。 */
  async function toastMock(): Promise<Record<'success' | 'warning' | 'error', ReturnType<typeof vi.fn>>> {
    const mod = (await import('@/lib/toast')) as unknown as {
      toast: Record<'success' | 'warning' | 'error', ReturnType<typeof vi.fn>>;
    };
    return mod.toast;
  }
  const OK_REPORT = { sources: 1, chunks: 7, attempted: 7, embedded: 7, failed: 0, engineError: null };

  it('点「重建索引」⇒ 调 kbRebuild', async () => {
    const kbRebuild = vi.fn(async () => ({ ok: true as const, report: OK_REPORT }));
    stubClawwork({ kbRebuild });
    await renderPanel();

    await clickRebuild();

    expect(kbRebuild).toHaveBeenCalledTimes(1);
  });

  /**
   * ⭐ 这一条就是验收里的"重建期间有进行中的反馈"。
   *
   * 重建可能要嵌几百块（秒级到分钟级），期间界面**必须**看得出来在干活：
   * 按钮禁用（防连点 —— 连点两次会把第一遍刚写好的向量又删一遍）+ 文案变成"正在重建"。
   * 没有这个，用户看到的就是"点了没反应"，然后再点、再点。
   */
  it('⭐ 重建期间：按钮禁用 + 文案变成"正在重建"；做完恢复', async () => {
    let release!: () => void;
    const kbRebuild = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const, report: OK_REPORT });
        }),
    );
    stubClawwork({ kbRebuild });
    await renderPanel();

    await clickRebuild();

    // 还没 resolve
    expect(rebuildButton().disabled, '重建中必须禁用：连点会把刚写好的向量又删一遍').toBe(true);
    expect(bodyText()).toContain('kb.rebuilding');

    release();
    await act(async () => {
      await Promise.resolve();
    });

    expect(rebuildButton().disabled).toBe(false);
    expect(bodyText()).not.toContain('kb.rebuilding');
  });

  /**
   * ⭐ 服务说 `skipped: 'no-engine'` 时**不能**报"重建完成"。
   *
   * 那种情况是"一个字节都没动"（见 `service.ts` 里 `rebuild` 的注释：没引擎时重建
   * 只会把向量删了补不回来，所以直接拒绝）。把它显示成"完成"是最坏的一种撒谎。
   */
  it('⭐ 服务回 skipped=no-engine ⇒ 说"已跳过"，不能说"重建完成"', async () => {
    const kbRebuild = vi.fn(async () => ({
      ok: true as const,
      report: { ...OK_REPORT, sources: 0, chunks: 0, attempted: 0, embedded: 0, skipped: 'no-engine' as const },
    }));
    stubClawwork({ kbRebuild });
    await renderPanel();

    await clickRebuild();

    const toast = await toastMock();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('kb.rebuildSkipped'));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('kb.rebuildDone'));
  });

  it('重建完 ⇒ 重新拉一次统计（否则界面还显示重建前的切片数）', async () => {
    const kbStats = vi.fn(async () => ({ ok: true as const, stats: STATS, engine: null }));
    stubClawwork({ kbStats, kbRebuild: vi.fn(async () => ({ ok: true as const, report: OK_REPORT })) });
    await renderPanel();
    const before = kbStats.mock.calls.length;

    await clickRebuild();

    expect(kbStats.mock.calls.length, '重建改的是切片，不刷新统计界面就是旧的').toBeGreaterThan(before);
  });
});

describe('资料库面板', () => {
  it('⭐ 「还没就绪」显示成**准备中**，不是"还没有资料"（否则用户以为东西丢了）', async () => {
    stubClawwork({
      kbStats: vi.fn(async () => ({ ok: false, code: 'not-ready' })),
      kbListSources: vi.fn(async () => ({ ok: false, code: 'not-ready' })),
    });

    await renderPanel();

    expect(container.textContent).toContain('kb.notReady');
    expect(container.textContent, '"还没有资料" 会让用户以为加过的东西没了').not.toContain('kb.empty');
  });

  it('⭐ 没有嵌入引擎时**说明降级**，但界面照常可用（不出报错）', async () => {
    stubClawwork({}); // engine: null

    await renderPanel();

    expect(container.textContent).toContain('kb.degraded.noEngine');
    // 降级不等于出错：搜索框与"添加文件"都还在
    expect(container.querySelector('input')).not.toBeNull();
    expect(container.textContent).toContain('kb.addFile');
  });

  it('有引擎时说明是本机模型（离线、不上传）', async () => {
    stubClawwork({ kbStats: vi.fn(async () => ({ ok: true, stats: STATS, engine: 'bge-small-zh-v1.5' })) });

    await renderPanel();

    expect(container.textContent).toContain('kb.engineLocal');
    expect(container.textContent).not.toContain('kb.degraded.noEngine');
  });

  it('列出已加入的资料；待建索引的会标出来', async () => {
    stubClawwork({
      kbListSources: vi.fn(async () => ({
        ok: true,
        sources: [
          { id: 'a', kind: 'file', path: 'C:/x.md', title: '预算说明', bytes: 10, addedAt: '', chunks: 3, pending: 0 },
          { id: 'b', kind: 'file', path: 'C:/y.md', title: '排期', bytes: 10, addedAt: '', chunks: 5, pending: 2 },
        ],
      })),
    });

    await renderPanel();

    expect(container.textContent).toContain('预算说明');
    expect(container.textContent).toContain('排期');
    expect(container.textContent).toContain('kb.sourcePending');
  });

  it('搜出来的结果带出处与分数；降级时说明只用了关键词', async () => {
    stubClawwork({
      kbSearch: vi.fn(async () => ({
        ok: true as const,
        outcome: {
          mode: 'keyword' as const,
          degradedReason: 'no-engine' as const,
          hits: [
            {
              chunkId: 'c1',
              sourceId: 'a',
              ordinal: 0,
              text: '收入主要来自软件订阅',
              snippet: '收入主要来自软件订阅',
              sourceKind: 'file',
              sourceTitle: '预算说明',
              sourcePath: 'C:/x.md',
              score: 0.83,
            },
          ],
          degraded: true,
          candidateCount: 1,
        },
      })),
    });

    await renderPanel();

    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      // ⚠️ 直接 `input.value = x` **不会**触发 React 的 onChange —— React 自己维护了一个
      //    value tracker，看到"值没变"就跳过。必须走原型上的原生 setter 再派发 input 事件。
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setValue.call(input, '收入');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(container.textContent).toContain('预算说明');
    expect(container.textContent).toContain('0.83');
    expect(container.textContent).toContain('kb.degraded.noEngine');
  });
});
