// @vitest-environment jsdom
// 回归：meeting.description 曾被渲染两次 —— 对话框头 DialogDescription 一次、面板 <p> 再一次。
// 对话框头才是这句话的归属（aria-describedby），面板不得重复渲染。
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Team } from '@clawwork/shared';
import zh from '../src/renderer/i18n/locales/zh.json';

function lookup(locale: unknown, key: string): string {
  let node: unknown = locale;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : key;
}
const translate = (key: string) => lookup(zh, key);

const ui = vi.hoisted(() => ({
  gatewayStatusMap: { gw: 'connected' },
  agentCatalogByGateway: {
    gw: {
      agents: [
        { id: 'a', name: 'A', model: { primary: 'm' } },
        { id: 'b', name: 'B', model: { primary: 'kimi-k3' } },
      ],
    },
  },
  modelCatalogByGateway: {
    gw: [
      { id: 'm', provider: 'clawrouter' },
      { id: 'kimi-k3', provider: 'clawrouter' },
    ],
  },
  setMainView: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/platform', () => ({
  useUiStore: Object.assign((selector: (state: unknown) => unknown) => selector(ui), { getState: () => ui }),
  useTaskStore: Object.assign((selector: (state: { tasks: unknown[] }) => unknown) => selector({ tasks: [] }), {
    getState: () => ({ tasks: [] }),
  }),
}));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: {
    start: vi.fn(async () => 'meeting'),
    load: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getGeneration: () => 0,
  },
  useTeamMeetingStore: (selector: (state: unknown) => unknown) =>
    selector({ records: [], errors: {}, error: null, loaded: true, loading: false }),
}));
vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
import TeamMeetingEntry from '../src/renderer/features/team-meeting/TeamMeetingEntry';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const team = { id: 'team', name: 'Team', gatewayId: 'gw', agents: [{ agentId: 'a' }, { agentId: 'b' }] } as Team;
const description = lookup(zh, 'meeting.description');
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
describe('meeting dialog description', () => {
  it('renders the dialog description exactly once with the panel open', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<TeamMeetingEntry team={team} />));
    await act(async () => host.querySelector('button')!.click());
    const text = document.body.textContent ?? '';
    const occurrences = text.split(description).length - 1;
    expect(occurrences, `"${description}" 应恰好出现一次`).toBe(1);
  });
});
