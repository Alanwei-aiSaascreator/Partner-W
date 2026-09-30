// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateTeamMeetingInput, Team } from '@clawwork/shared';
const mocks = vi.hoisted(() => ({
  start: vi.fn(async (_input: CreateTeamMeetingInput) => 'meeting'),
  load: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  generation: 0,
  startError: null as unknown,
  setActiveTask: vi.fn(),
  setMainView: vi.fn(),
  ui: {
    gatewayStatusMap: { gw: 'connected' },
    agentCatalogByGateway: {
      gw: {
        agents: [
          { id: 'a', name: 'A', model: { primary: 'm' } },
          { id: 'b', name: 'B', model: { primary: 'm' } },
        ],
      },
    },
    modelCatalogByGateway: { gw: [{ id: 'm', provider: 'clawrouter' }] },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/platform', () => ({
  useUiStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ ...mocks.ui, setMainView: mocks.setMainView }),
    { getState: () => mocks.ui },
  ),
  useTaskStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ setActiveTask: mocks.setActiveTask }),
    { getState: () => ({ tasks: [{ id: 'existing-task' }] }) },
  ),
}));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  teamMeetingController: {
    start: mocks.start,
    load: mocks.load,
    stop: mocks.stop,
    getGeneration: () => mocks.generation,
  },
  useTeamMeetingStore: (selector: (state: unknown) => unknown) =>
    selector({ records: [], errors: {}, error: null, loaded: true, loading: false }),
}));
vi.mock('../src/renderer/features/team-meeting/TeamMeetingPanel', () => ({
  default: (props: {
    onStart: (question: string, members: unknown[]) => Promise<void>;
    members: unknown[];
    onDirtyChange: (dirty: boolean) => void;
    onOpenTask: (id: string) => void;
  }) => (
    <>
      <button
        onClick={() =>
          void props.onStart('Question', props.members).catch((error: unknown) => {
            mocks.startError = error;
          })
        }
      >
        send-test
      </button>
      <button onClick={() => props.onDirtyChange(true)}>dirty-test</button>
      <button onClick={() => props.onOpenTask('existing-task')}>navigate-test</button>
    </>
  ),
}));
import TeamMeetingEntry from '../src/renderer/features/team-meeting/TeamMeetingEntry';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const team = { id: 'team', name: 'Team', gatewayId: 'gw', agents: [{ agentId: 'a' }, { agentId: 'b' }] } as Team;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.generation = 0;
  mocks.startError = null;
  Object.assign(window, { clawwork: { getDeviceId: vi.fn(async () => 'device') } });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
});
describe('meeting entry', () => {
  it.each(['workspace-reset', 'unmount', 'team-change'])(
    'does not submit an old question after %s while device identity is pending',
    async (change) => {
      let resolveDevice!: (id: string) => void;
      window.clawwork.getDeviceId = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveDevice = resolve;
          }),
      );
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root!.render(<TeamMeetingEntry team={team} />));
      await act(async () => host.querySelector('button')!.click());
      const send = [...document.querySelectorAll('button')].find((button) => button.textContent === 'send-test')!;
      await act(async () => send.click());
      expect(mocks.start).not.toHaveBeenCalled();
      if (change === 'workspace-reset') mocks.generation++;
      else if (change === 'unmount') {
        await act(async () => root!.unmount());
        root = undefined;
      } else await act(async () => root!.render(<TeamMeetingEntry team={{ ...team, id: 'other-team' }} />));
      await act(async () => resolveDevice('device'));
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.startError).toBeInstanceOf(Error);
    },
  );
  it('requires confirmation before task navigation discards an unsent meeting question', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<TeamMeetingEntry team={team} />));
    await act(async () => host.querySelector('button')!.click());
    const find = (name: string) =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === name)!;
    await act(async () => find('dirty-test').click());
    await act(async () => find('navigate-test').click());
    expect(mocks.setActiveTask).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('teams.detail.unsavedTitle');
    await act(async () => find('common.confirm').click());
    expect(mocks.setActiveTask).toHaveBeenCalledWith('existing-task');
  });
  it('loads on opening and creates three real task sessions through the controller', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<TeamMeetingEntry team={team} />));
    expect(mocks.start).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(mocks.load).toHaveBeenCalled();
    const send = [...document.querySelectorAll('button')].find((button) => button.textContent === 'send-test')!;
    await act(async () => send.click());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    const plan = mocks.start.mock.calls[0][0];
    expect(plan.tasks).toHaveLength(3);
    expect(plan.record.turns.map((turn: { agentId: string }) => turn.agentId)).toEqual(['a', 'b', 'a']);
    expect(plan.tasks.every((task) => task.model === 'clawrouter/m')).toBe(true);
  });
});
