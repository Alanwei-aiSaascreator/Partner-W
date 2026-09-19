// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToolCall } from '@clawwork/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ A2：工具卡片在**等人批准**时要**说一句**「等待批准」。
 *
 * 为什么不能只换图标：用户看到"一个不转圈的钟"未必知道**该谁动** ——
 * 这句话就是回答"为什么没进展 + 谁来批"。
 *
 * ⚠️ 文案走 `t()`、**不写死**：写死的话 `toolCall.awaitingApproval` 会变成 unused，
 * `check:i18n` 直接红（那条门禁就是靠"key 有没有被用到"来抓硬编码的）。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `«${key}»` }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function call(status: ToolCall['status']): ToolCall {
  return { id: 'call_1', name: 'exec', status, title: 'npm view x', startedAt: '2026-09-15T00:00:00.000Z' };
}

async function render(status: ToolCall['status']): Promise<void> {
  const { default: ToolCallCard } = await import('../src/renderer/components/ToolCallCard');
  act(() => root.render((<ToolCallCard toolCall={call(status)} />) as ReactElement));
}

const label = (): Element | null => container.querySelector('[data-testid="awaiting-approval-label"]');

describe('A2 · 工具卡片说「等待批准」', () => {
  it('⭐⭐ `awaitingApproval` ⇒ 卡片上**有**这句话', async () => {
    await render('awaitingApproval');

    expect(label(), '光换图标不够，得说一句').not.toBeNull();
    expect(label()!.textContent).toBe('«toolCall.awaitingApproval»');
  });

  it('⭐ `data-status` 也如实报出来（样式与调试都靠它）', async () => {
    await render('awaitingApproval');

    expect(container.querySelector('[data-testid="tool-call-card"]')?.getAttribute('data-status')).toBe(
      'awaitingApproval',
    );
  });

  it.each(['running', 'done', 'error'] as const)('对照：`%s` ⇒ **没有**这句话', async (status) => {
    await render(status);

    expect(label()).toBeNull();
  });

  it('⭐ 它**不**带"正在跑"的光效（不是 running）', async () => {
    await render('awaitingApproval');

    expect(container.querySelector('.glow-running'), '在等人 ≠ 在跑').toBeNull();
  });
});
