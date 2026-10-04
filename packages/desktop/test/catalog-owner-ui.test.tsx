// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJob } from '@clawwork/shared';
import { useUiStore } from '../src/renderer/stores/uiStore';
import SkillsSection from '../src/renderer/layouts/Settings/sections/SkillsSection';
import AgentDraftCard from '../src/renderer/layouts/TeamsPanel/AgentDraftCard';
import CronJobDialog from '../src/renderer/layouts/CronPanel/CronJobDialog';
import { toast } from '../src/renderer/lib/toast';

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const catalog = {
  defaultId: 'office',
  mainKey: 'main',
  scope: 'per-sender',
  agents: [{ id: 'video' }, { id: 'office' }],
};
const getSkillsStatus = vi.fn();
const listModels = vi.fn();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  getSkillsStatus
    .mockReset()
    .mockResolvedValue({ ok: true, result: { workspaceDir: '/qa', managedSkillsDir: '/qa/skills', skills: [] } });
  listModels.mockReset().mockResolvedValue({ ok: true, result: { models: [{ id: 'model-new' }] } });
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      getSkillsStatus,
      listModels,
      listAgents: vi.fn().mockResolvedValue({ ok: true, result: catalog }),
      getAgentFile: vi.fn().mockResolvedValue({ ok: true, result: { content: '' } }),
    },
  });
  useUiStore.setState({
    gatewayStatusMap: { 'gw-1': 'connected' },
    gatewayInfoMap: {},
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': catalog },
    skillsStatusByGateway: {},
    modelCatalogByGateway: {},
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('catalog owner UI boundaries', () => {
  it('waits for an initial agent roster without a false error or ownerless skill request', async () => {
    useUiStore.setState({ agentCatalogByGateway: {} });
    await act(async () => root.render(<SkillsSection />));
    expect(toast.error).not.toHaveBeenCalled();
    expect(getSkillsStatus).not.toHaveBeenCalled();
    await act(async () => useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog } }));
    expect(getSkillsStatus).toHaveBeenCalledWith('gw-1', 'office');
  });

  it('keeps a loaded ambiguous roster failure explicit and retryable without guessing an owner', async () => {
    useUiStore.setState({ agentCatalogByGateway: { 'gw-1': { ...catalog, defaultId: '' } } });
    await act(async () => root.render(<SkillsSection />));
    expect(toast.error).toHaveBeenCalled();
    expect(getSkillsStatus).not.toHaveBeenCalled();
    vi.mocked(toast.error).mockClear();
    const refresh = Array.from(container.querySelectorAll('button')).find((button) =>
      button.querySelector('.lucide-refresh-cw'),
    );
    expect(refresh?.disabled).toBe(false);
    await act(async () => refresh?.click());
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(getSkillsStatus).not.toHaveBeenCalled();
  });

  it('requests settings skills for the valid management owner', async () => {
    await act(async () => root.render(<SkillsSection />));
    expect(getSkillsStatus).toHaveBeenCalledWith('gw-1', 'office');
  });

  it('clears a previous owner loading state when the next owner already has a skill cache', async () => {
    getSkillsStatus.mockImplementation(() => new Promise(() => {}));
    await act(async () => root.render(<SkillsSection />));
    expect(container.querySelector('button[disabled]')).not.toBeNull();
    await act(async () =>
      useUiStore.setState({
        agentCatalogByGateway: { 'gw-1': { ...catalog, defaultId: 'video' } },
        skillsStatusByGateway: {
          'gw-1': { agentId: 'video', workspaceDir: '/qa', managedSkillsDir: '/qa', skills: [] },
        },
      }),
    );
    expect(container.querySelector('button[disabled]')).toBeNull();
    expect(getSkillsStatus).toHaveBeenCalledTimes(1);
  });

  it('does not reuse another owner skill cache in an existing-agent draft', async () => {
    useUiStore.setState({
      skillsStatusByGateway: {
        'gw-1': { agentId: 'office', workspaceDir: '/qa', managedSkillsDir: '/qa', skills: [] },
      },
    });
    await act(async () =>
      root.render(
        <AgentDraftCard
          agent={{
            uid: 'draft',
            existingAgentId: 'video',
            name: 'Video',
            description: '',
            role: 'worker',
            model: '',
            agentMd: '',
            soulMd: '',
            skills: [],
          }}
          index={0}
          isFirst
          canRemove={false}
          gatewayId="gw-1"
          availableExisting={catalog.agents}
          onUpdate={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(getSkillsStatus).toHaveBeenCalledWith('gw-1', 'video');
  });

  it('requests Cron models for its explicit agent rather than a default owner', async () => {
    const job = {
      id: 'job',
      name: 'Test',
      enabled: true,
      agentId: 'video',
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'agentTurn', message: 'Test' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      state: {},
    } as CronJob;
    await act(async () =>
      root.render(<CronJobDialog open onOpenChange={() => {}} gatewayId="gw-1" editingJob={job} onSaved={() => {}} />),
    );
    expect(listModels).toHaveBeenLastCalledWith('gw-1', 'video');
    expect(listModels.mock.calls.every((args) => args[1] === 'video')).toBe(true);
  });

  it('does not reuse a same-named agent skill report from another gateway', async () => {
    useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog, 'gw-2': catalog } });
    const draw = (gatewayId: string) => (
      <AgentDraftCard
        agent={{
          uid: 'draft',
          existingAgentId: 'video',
          name: 'Video',
          description: '',
          role: 'worker',
          model: '',
          agentMd: '',
          soulMd: '',
          skills: [],
        }}
        index={0}
        isFirst
        canRemove={false}
        gatewayId={gatewayId}
        availableExisting={catalog.agents}
        onUpdate={() => {}}
        onRemove={() => {}}
      />
    );
    await act(async () => root.render(draw('gw-1')));
    await act(async () => root.render(draw('gw-2')));
    expect(getSkillsStatus).toHaveBeenLastCalledWith('gw-2', 'video');
  });

  it('discards a previous Cron owner response after switching agents', async () => {
    const oldResponses: Array<(value: { ok: boolean; result: { models: Array<{ id: string }> } }) => void> = [];
    listModels.mockImplementation((_gatewayId, owner) =>
      owner === 'office'
        ? new Promise((resolve) => oldResponses.push(resolve))
        : Promise.resolve({ ok: true, result: { models: [{ id: 'model-new' }] } }),
    );
    const job = {
      id: 'job',
      name: 'Test',
      enabled: true,
      agentId: 'office',
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'agentTurn', message: 'Test' },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      state: {},
    } as CronJob;
    const draw = (value: CronJob) => (
      <CronJobDialog open onOpenChange={() => {}} gatewayId="gw-1" editingJob={value} onSaved={() => {}} />
    );
    await act(async () => root.render(draw(job)));
    await act(async () => root.render(draw({ ...job, agentId: 'video' })));
    await act(async () => {
      for (const resolve of oldResponses) resolve({ ok: true, result: { models: [{ id: 'model-old' }] } });
    });
    expect(container.textContent).toContain('model-new');
    expect(container.textContent).not.toContain('model-old');
  });
});
