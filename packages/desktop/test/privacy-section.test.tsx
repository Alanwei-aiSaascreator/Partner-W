// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

/**
 * 用 zh.json 的**真实文案**渲染并断言：写 `t('privacy.xxx')` 回显会在键没落地时
 * 两边一起退化成键名 ⇒ 空对空的假绿。
 */
function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import PrivacySection from '../src/renderer/layouts/Settings/sections/PrivacySection';
import { describePrivacyError } from '@clawwork/core';
import { toast } from 'sonner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY_MS = 86_400_000;

/**
 * ⚠️ mock 的是 `privacy:state` 的**真实形状**：main 已经跑过 `normalizePrivacyState`
 *    ⇒ camelCase + `cancellable` 真布尔。喂 snake_case 等于测一条不存在的路径。
 */
function exportRow(overrides: Record<string, unknown> = {}) {
  return { id: 'e1', status: 'ready', requestedAt: '2026-09-17T00:00:00.000Z', snapshotBytes: 2048, ...overrides };
}

function deletionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    status: 'pending',
    requestedAt: '2026-09-17T00:00:00.000Z',
    scheduledFor: new Date(Date.now() + 7 * DAY_MS).toISOString(),
    cancellable: true,
    ...overrides,
  };
}

function stateMock(): ReturnType<typeof vi.fn> {
  return window.clawwork.privacyState as unknown as ReturnType<typeof vi.fn>;
}

function mockState(result: { export?: unknown; deletion?: unknown }): void {
  stateMock().mockResolvedValue({ ok: true, result });
}

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<PrivacySection />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 按文案找按钮 —— 不依赖 Button 是否把 data-action 透传到 DOM。 */
function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((element) => element.textContent?.includes(text));
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found as HTMLButtonElement;
}

function action(scope: ParentNode, name: string): HTMLButtonElement | null {
  return scope.querySelector(`button[data-action="${name}"]`);
}

function field(scope: ParentNode, name: string): HTMLElement | null {
  return scope.querySelector(`[data-field="${name}"]`);
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error('要点的元素不存在');
  await act(async () => {
    element.click();
  });
}

/** 走完「申请删除 → 勾选 → 输确认词 → 确认」这条二次确认链。 */
async function confirmDeletion(container: HTMLElement): Promise<void> {
  await click(action(container, 'privacy-delete'));
  const ack = document.querySelector('[data-field="privacy-ack"]') as HTMLInputElement;
  const word = document.querySelector('[data-field="privacy-word"]') as HTMLInputElement;
  await click(ack);
  await act(async () => setInput(word, translate('privacy.deletionConfirmWord')));
  await click(document.querySelector('button[data-action="privacy-confirm-delete"]') as HTMLButtonElement);
}

describe('PrivacySection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      clawwork: {
        privacyState: vi.fn(async () => ({ ok: true, result: { export: null, deletion: null } })),
        privacyRequestExport: vi.fn(async () => ({ ok: true, result: null })),
        privacyRequestDeletion: vi.fn(async () => ({ ok: true, result: null })),
        privacyCancelDeletion: vi.fn(async () => ({ ok: true, result: null })),
        privacyDownloadExport: vi.fn(async () => ({
          ok: true,
          result: { path: 'D:/exports/rongying-mofang-export-20260918.json', truncated: false, notes: [] },
        })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('没有工单时两个申请按钮都可点，且不显示冷却期', async () => {
    const view = await render();
    expect(buttonByText(view.container, translate('privacy.requestExport')).disabled).toBe(false);
    expect(buttonByText(view.container, translate('privacy.requestDeletion')).disabled).toBe(false);
    expect(field(view.container, 'deletion-cooldown')).toBeNull();
    view.unmount();
  });

  it('导出已就绪 ⇒ 换成下载按钮，点它走到 privacy:download-export', async () => {
    mockState({ export: exportRow(), deletion: null });
    const view = await render();
    expect(action(view.container, 'privacy-export')).toBeNull();
    await click(action(view.container, 'privacy-download'));
    expect(window.clawwork.privacyDownloadExport).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('导出已下载过（completed）⇒ 仍给下载按钮（设计 §5.3：ready / completed 可下载）', async () => {
    mockState({ export: exportRow({ status: 'completed' }), deletion: null });
    const view = await render();
    expect(action(view.container, 'privacy-download')).not.toBeNull();
    expect(action(view.container, 'privacy-export')).toBeNull();
    view.unmount();
  });

  it('导出处理中 ⇒ 说明还在准备，且不出现下载按钮', async () => {
    mockState({ export: exportRow({ status: 'pending' }), deletion: null });
    const view = await render();
    expect(field(view.container, 'export-pending')?.textContent).toBe(translate('privacy.exportPending'));
    expect(action(view.container, 'privacy-download')).toBeNull();
    view.unmount();
  });

  it('★ 导出状态未知 ⇒ 显式分支 + 可刷新，绝不落回"申请导出"的默认渲染', async () => {
    mockState({ export: exportRow({ status: 'unknown' }), deletion: null });
    const view = await render();
    expect(field(view.container, 'export-unknown')?.textContent).toBe(translate('privacy.statusUnknown'));
    expect(action(view.container, 'privacy-export')).toBeNull();
    expect(action(view.container, 'privacy-download')).toBeNull();

    mockState({ export: exportRow(), deletion: null });
    await click(action(view.container, 'privacy-retry-export'));
    expect(action(view.container, 'privacy-download')).not.toBeNull();
    view.unmount();
  });

  it('★ 删除状态未知 ⇒ 既不渲染"申请删除"也不渲染"撤回"（不敢猜有没有在跑的工单）', async () => {
    mockState({ export: null, deletion: deletionRow({ status: 'unknown' }) });
    const view = await render();
    expect(field(view.container, 'deletion-unknown')?.textContent).toBe(translate('privacy.statusUnknown'));
    expect(action(view.container, 'privacy-delete')).toBeNull();
    expect(action(view.container, 'privacy-cancel')).toBeNull();
    view.unmount();
  });

  it('冷却期内 ⇒ 显示剩余天数与撤回按钮，撤回带的是这条工单的 id', async () => {
    mockState({ export: null, deletion: deletionRow() });
    const view = await render();
    expect(field(view.container, 'deletion-cooldown')?.textContent).toBe(
      translate('privacy.cooldownLeft', { days: 7 }),
    );
    await click(action(view.container, 'privacy-cancel'));
    expect(window.clawwork.privacyCancelDeletion).toHaveBeenCalledWith({ id: 'd1' });
    view.unmount();
  });

  it('★ 冷却期读不出（非法日期 / 缺失）⇒ 降级文案，绝不说成"冷却期已结束"', async () => {
    mockState({ export: null, deletion: deletionRow({ scheduledFor: '不是时间' }) });
    const first = await render();
    expect(field(first.container, 'deletion-cooldown')?.textContent).toBe(translate('privacy.cooldownUnknown'));
    expect(field(first.container, 'deletion-cooldown')?.textContent).not.toContain(translate('privacy.deletionDue'));
    first.unmount();

    mockState({ export: null, deletion: deletionRow({ scheduledFor: null }) });
    const second = await render();
    expect(field(second.container, 'deletion-cooldown')?.textContent).toBe(translate('privacy.cooldownUnknown'));
    second.unmount();
  });

  it('冷却期已过且不可撤回 ⇒ "等待处理"，不给撤回按钮', async () => {
    mockState({
      export: null,
      deletion: deletionRow({ scheduledFor: new Date(Date.now() - DAY_MS).toISOString(), cancellable: false }),
    });
    const view = await render();
    expect(field(view.container, 'deletion-cooldown')?.textContent).toBe(translate('privacy.deletionDue'));
    expect(action(view.container, 'privacy-cancel')).toBeNull();
    view.unmount();
  });

  it('已撤回（cancelled）⇒ 卡片回到可申请态', async () => {
    mockState({ export: null, deletion: deletionRow({ status: 'cancelled', cancellable: false }) });
    const view = await render();
    expect(action(view.container, 'privacy-delete')).not.toBeNull();
    expect(action(view.container, 'privacy-cancel')).toBeNull();
    expect(view.container.textContent).toContain(translate('privacy.deletionHint'));
    view.unmount();
  });

  it('★ 二次确认：勾选 + 确认词都齐了才允许提交，后果必须写在弹层里', async () => {
    const view = await render();
    await click(action(view.container, 'privacy-delete'));
    expect(window.clawwork.privacyRequestDeletion).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(translate('privacy.deletionConsequences'));
    expect(document.body.textContent).toContain(translate('privacy.deletionAcknowledge'));

    const confirm = document.querySelector('button[data-action="privacy-confirm-delete"]') as HTMLButtonElement;
    const ack = document.querySelector('[data-field="privacy-ack"]') as HTMLInputElement;
    const word = document.querySelector('[data-field="privacy-word"]') as HTMLInputElement;
    const confirmWord = translate('privacy.deletionConfirmWord');

    expect(confirm.disabled).toBe(true);
    await click(ack);
    expect(confirm.disabled).toBe(true);
    await click(ack);
    await act(async () => setInput(word, confirmWord));
    expect(confirm.disabled).toBe(true);
    await click(ack);
    await act(async () => setInput(word, confirmWord.slice(0, -1)));
    expect(confirm.disabled).toBe(true);

    await act(async () => setInput(word, confirmWord));
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(window.clawwork.privacyRequestDeletion).toHaveBeenCalledWith({
      reason: translate('privacy.deletionReason'),
    });
    expect(window.clawwork.privacyRequestDeletion).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('提交删除后关掉弹层，并按服务端新状态切到冷却期', async () => {
    stateMock()
      .mockResolvedValueOnce({ ok: true, result: { export: null, deletion: null } })
      .mockResolvedValue({ ok: true, result: { export: null, deletion: deletionRow() } });
    const view = await render();
    await confirmDeletion(view.container);
    expect(document.querySelector('[data-field="privacy-word"]')).toBeNull();
    expect(field(view.container, 'deletion-cooldown')?.textContent).toBe(
      translate('privacy.cooldownLeft', { days: 7 }),
    );
    view.unmount();
  });

  it('★ 导出被截断 ⇒ 警告 + 卡片里留下"不是完整历史"的说明', async () => {
    mockState({ export: exportRow({ status: 'completed' }), deletion: null });
    (window.clawwork.privacyDownloadExport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: {
        path: 'D:/exports/export.json',
        truncated: true,
        notes: ['本地消息共 500001 条，超过上限 500000 条：本次只导出计数与索引'],
      },
    });
    const view = await render();
    await click(action(view.container, 'privacy-download'));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('不完整'), expect.anything());
    expect(toast.success).not.toHaveBeenCalled();
    expect(field(view.container, 'export-truncated')?.textContent).toBe(translate('privacy.downloadTruncatedHint'));
    expect(field(view.container, 'export-notes')?.textContent).toContain('本地消息共 500001 条');
    view.unmount();
  });

  it('没截断但有说明（脱敏 / 降级）⇒ 说明照样留给用户', async () => {
    mockState({ export: exportRow(), deletion: null });
    (window.clawwork.privacyDownloadExport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: {
        path: 'D:/exports/export.json',
        truncated: false,
        notes: ['设置里按脱敏规则剔除了敏感字段：token、gateways'],
      },
    });
    const view = await render();
    await click(action(view.container, 'privacy-download'));
    // ⚠️ `toast.success` 是 sonner 的原样透传（只有 error/warning 会被 `@/lib/toast`
    //    补上第二个参数）⇒ 这里**不能**写 expect.anything()。
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已保存'));
    expect(field(view.container, 'export-truncated')).toBeNull();
    expect(field(view.container, 'export-notes')?.textContent).toContain('脱敏');
    view.unmount();
  });

  it('没截断也没有说明 ⇒ 成功提示，不留任何附加行', async () => {
    mockState({ export: exportRow(), deletion: null });
    const view = await render();
    await click(action(view.container, 'privacy-download'));
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('已保存'));
    expect(field(view.container, 'export-truncated')).toBeNull();
    expect(field(view.container, 'export-notes')).toBeNull();
    view.unmount();
  });

  it('用户在保存对话框点取消（cancelled）⇒ 界面安静收场，不弹错误', async () => {
    mockState({ export: exportRow(), deletion: null });
    (window.clawwork.privacyDownloadExport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      errorCode: 'cancelled',
    });
    const view = await render();
    await click(action(view.container, 'privacy-download'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(field(view.container, 'export-truncated')).toBeNull();
    view.unmount();
  });

  it('下载回 ok 但没带 result ⇒ 报"读不到"，绝不假装下载成功', async () => {
    mockState({ export: exportRow(), deletion: null });
    (window.clawwork.privacyDownloadExport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const view = await render();
    await click(action(view.container, 'privacy-download'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(describePrivacyError('unknown'), expect.anything());
    view.unmount();
  });

  it('导出失败 ⇒ 中文原因（core 码表），不出现机器码', async () => {
    (window.clawwork.privacyRequestExport as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      errorCode: 'export_too_large',
    });
    const view = await render();
    await click(action(view.container, 'privacy-export'));
    expect(toast.error).toHaveBeenCalledWith('数据量较大，已转人工处理，我们会尽快联系你', expect.anything());
    expect(document.body.textContent).not.toContain('export_too_large');
    view.unmount();
  });

  it('删除被拒（多成员团队 owner）⇒ 中文原因，工单不落地', async () => {
    (window.clawwork.privacyRequestDeletion as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      errorCode: 'owner_transfer_required',
    });
    const view = await render();
    await confirmDeletion(view.container);
    expect(toast.error).toHaveBeenCalledWith('你是团队的创建者，请先移交或解散团队再删除账号', expect.anything());
    view.unmount();
  });

  it('★ 读不到工单状态 ⇒ 明说读不到（暂时≠没有），并给重试', async () => {
    stateMock().mockResolvedValue({ ok: false, errorCode: 'network' });
    const view = await render();
    expect(field(view.container, 'privacy-load-error')?.textContent).toContain('网络连接失败，请检查网络后重试');
    mockState({ export: exportRow(), deletion: null });
    await click(action(view.container, 'privacy-retry-state'));
    expect(field(view.container, 'privacy-load-error')).toBeNull();
    expect(action(view.container, 'privacy-download')).not.toBeNull();
    view.unmount();
  });
});
