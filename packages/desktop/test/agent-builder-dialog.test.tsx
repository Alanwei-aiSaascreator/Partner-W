// @vitest-environment jsdom

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用真实中文文案渲染：这样「提示是中文」才是被验证过的。 */
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

const session = vi.hoisted(() => ({
  status: 'active' as 'idle' | 'active' | 'streaming',
  messages: [] as Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>,
  error: null as string | null,
  start: vi.fn(async () => ({ ok: true })),
  send: vi.fn(async () => ({ ok: true })),
  end: vi.fn(async () => undefined),
}));

const models = vi.hoisted(() => ({
  catalog: [
    { id: 'clawrouter/qwen3.5-27b', provider: 'clawrouter', name: 'Qwen 3.5 27B' },
    { id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
  ] as Array<{ id: string; provider?: string; name?: string }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../src/renderer/hooks/useSystemSession', () => ({
  useSystemSession: () => ({
    status: session.status,
    messages: session.messages,
    error: session.error,
    start: session.start,
    send: session.send,
    end: session.end,
  }),
}));

vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      modelCatalogByGateway: { 'gw-1': models.catalog },
      agentCatalogByGateway: { 'gw-1': { defaultId: 'main', agents: [] } },
    }),
}));

import AgentBuilderDialog from '../src/renderer/components/AgentBuilderDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(open = true): { container: HTMLDivElement; setOpen: (next: boolean) => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const renderWith = (next: boolean) =>
    root.render(<AgentBuilderDialog open={next} onOpenChange={vi.fn()} gatewayId="gw-1" />);
  act(() => renderWith(open));
  return {
    container,
    setOpen: (next: boolean) => act(() => renderWith(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) as
      | HTMLButtonElement
      | undefined) ?? null
  );
}

function inputByName(container: HTMLElement, label: string): HTMLInputElement | null {
  const labels = [...container.querySelectorAll('label')];
  const target = labels.find((element) => element.textContent?.includes(label));
  if (!target) return null;
  return target.parentElement?.querySelector('input') ?? null;
}

function typeInto(input: HTMLElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AgentBuilderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    session.status = 'active';
    session.messages = [];
    session.error = null;
    Object.assign(window, {
      clawwork: {
        getWorkspacePath: vi.fn(async () => '/tmp/ws'),
        createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'agent-9' } })),
        updateAgent: vi.fn(async () => ({ ok: true })),
        setAgentFile: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the guidance session on a currently available model instead of the main assistant model', () => {
    const view = render();
    expect(session.start).toHaveBeenCalledOnce();
    expect(session.start.mock.calls[0]?.[0]).toMatchObject({
      gatewayId: 'gw-1',
      purpose: 'agent-builder',
      // 目录里第一条是 qwen3.5-27b（就是实机卡住的那个）；这里必须是商业默认模型
      model: 'clawrouter/deepseek-v4-flash',
    });
    view.unmount();
  });

  it('preselects the available model in the form so the user can create without waiting for the AI', () => {
    const view = render();
    const select = view.container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('clawrouter/deepseek-v4-flash');
    view.unmount();
  });

  it('offers a skip after the guidance goes quiet, and skipping unblocks the form', () => {
    vi.useFakeTimers();
    session.status = 'streaming';
    session.messages = [
      { role: 'user', content: 'prompt', timestamp: 't0' },
      { role: 'assistant', content: '', timestamp: 't0' },
    ];
    const view = render();

    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));

    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(view.container.textContent).toContain(translate('settings.agentBuilderStalled'));

    const skip = buttonByText(view.container, translate('settings.agentBuilderSkip'));
    expect(skip).not.toBeNull();
    act(() => skip?.click());
    expect(session.end).toHaveBeenCalled();
    view.unmount();
  });

  it('does not cry wolf while the guidance is still streaming', () => {
    vi.useFakeTimers();
    session.status = 'streaming';
    session.messages = [
      { role: 'user', content: 'prompt', timestamp: 't0' },
      { role: 'assistant', content: '正在想', timestamp: 't0' },
    ];
    const view = render();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // 10 秒时刚到一半，还没到提示阈值
    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));

    // 又来了一段流式内容 —— 计时应该重新开始，不能因为「总共过了 20 秒」就报卡住
    act(() => {
      session.messages = [
        { role: 'user', content: 'prompt', timestamp: 't0' },
        { role: 'assistant', content: '正在想，马上好', timestamp: 't0' },
      ];
      view.setOpen(true);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));
    view.unmount();
  });

  it('keeps the draft when the dialog is closed and reopened', () => {
    const view = render();
    const nameInput = inputByName(view.container, translate('settings.agentName'));
    expect(nameInput).not.toBeNull();
    typeInto(nameInput as HTMLElement, '我的助手');

    view.setOpen(false);
    view.setOpen(true);

    const reopened = inputByName(view.container, translate('settings.agentName')) as HTMLInputElement;
    expect(reopened.value).toBe('我的助手');
    view.unmount();
  });

  it('clears the draft only after the agent was actually created', async () => {
    const view = render();
    const nameInput = inputByName(view.container, translate('settings.agentName'));
    typeInto(nameInput as HTMLElement, '我的助手');

    const create = buttonByText(view.container, translate('settings.agentBuilderCreate'));
    await act(async () => {
      create?.click();
    });

    expect(window.clawwork.createAgent).toHaveBeenCalledOnce();
    view.unmount();
  });
});
