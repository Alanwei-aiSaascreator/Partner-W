// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Team, TeamMeetingRecord } from '@clawwork/shared';
import TeamMeetingPanel from '../src/renderer/features/team-meeting/TeamMeetingPanel';
import { buildMeetingPlan } from '../src/renderer/features/team-meeting/plan';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const members = ['a', 'b', 'c'].map((agentId) => ({ agentId, name: `Member ${agentId}`, model: 'provider/model' }));
async function mount(overrides: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const actions = { onStart: vi.fn(async () => {}), onStop: vi.fn(), onOpenTask: vi.fn() };
  await act(async () =>
    root.render(
      <TeamMeetingPanel
        members={members}
        models={['provider/model']}
        records={[]}
        connected
        {...actions}
        {...overrides}
      />,
    ),
  );
  return actions;
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
function button(key: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent?.includes(key))!;
}
async function enterQuestion(value: string) {
  const input = host.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('team meeting panel', () => {
  it.each(
    (['interrupted', 'stopped'] as const).flatMap((status) =>
      (['unconfirmed', 'requested'] as const).map((abortStatus) => ({ status, abortStatus })),
    ),
  )('allows an explicit stop for $status when abort is $abortStatus', async ({ status, abortStatus }) => {
    const actions = await mount({
      records: [{ id: 'recovered', question: 'q', status, abortStatus, turns: [] }],
    });
    expect(host.textContent).toContain(`meeting.abort.${abortStatus}`);
    expect(button('meeting.stop')).toBeDefined();
    await enterQuestion('next meeting');
    expect(button('meeting.start').disabled).toBe(true);
    await act(async () => button('meeting.start').click());
    expect(actions.onStart).not.toHaveBeenCalled();
    await act(async () => button('meeting.stop').click());
    expect(actions.onStop).toHaveBeenCalledWith('recovered');
  });
  it.each(['confirmed', 'not-running'])('does not offer repeat stop once abort is %s', async (abortStatus) => {
    await mount({ records: [{ id: 'settled', question: 'q', status: 'stopped', abortStatus, turns: [] }] });
    expect(button('meeting.stop')).toBeUndefined();
  });
  it.each(['confirmed', 'not-running'] as const)(
    'unlocks the start control when explicit retry reports %s',
    async (abortStatus) => {
      let id = 0;
      const team: Team = {
        id: 'team',
        name: 'Team',
        emoji: '',
        description: '',
        gatewayId: 'gateway',
        source: 'local',
        version: '1',
        agents: members.map(({ agentId }) => ({ agentId, role: 'expert', isManager: false, skills: [] })),
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      };
      const record = buildMeetingPlan({
        team,
        members,
        question: 'q',
        title: 'm',
        deviceId: 'device',
        uuid: () => `record-${++id}`,
      }).record;
      record.status = 'stopped';
      record.abortStatus = 'unconfirmed';
      for (const turn of record.turns) turn.status = 'stopped';
      const actions = await mount({ records: [record] });
      await enterQuestion('next meeting');
      expect(button('meeting.start').disabled).toBe(true);
      await act(async () =>
        root.render(
          <TeamMeetingPanel
            members={members}
            models={['provider/model']}
            records={[{ ...record, abortStatus }]}
            connected
            {...actions}
          />,
        ),
      );
      expect(button('meeting.start').disabled).toBe(false);
      expect(actions.onStart).not.toHaveBeenCalled();
      await act(async () => button('meeting.start').click());
      expect(actions.onStart).toHaveBeenCalledOnce();
    },
  );
  it('allows a new meeting after an inactive failed run has not-running cancellation evidence', async () => {
    const actions = await mount({
      records: [{ id: 'failed', question: 'q', status: 'failed', abortStatus: 'not-running', turns: [] }],
    });
    await enterQuestion('new meeting');
    expect(button('meeting.start').disabled).toBe(false);
    expect(button('meeting.stop')).toBeUndefined();
    await act(async () => button('meeting.start').click());
    expect(actions.onStart).toHaveBeenCalledOnce();
  });
  it('never sends on mount, shows extra-cost warning, and requires a question', async () => {
    const onDirtyChange = vi.fn();
    const actions = await mount({ onDirtyChange });
    expect(actions.onStart).not.toHaveBeenCalled();
    expect(host.textContent).toContain('meeting.costWarning');
    expect(button('meeting.start').disabled).toBe(true);
    await enterQuestion('Please discuss the proposal');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await act(async () => button('meeting.start').click());
    expect(actions.onStart).toHaveBeenCalledWith('Please discuss the proposal', members);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('requires at least two available members and an online gateway', async () => {
    await mount({ members: members.slice(0, 1), connected: false });
    await enterQuestion('q');
    expect(button('meeting.start').disabled).toBe(true);
    expect(host.textContent).toContain('meeting.unavailable');
  });
  it('shows failure without claiming creation succeeded', async () => {
    await mount({
      onStart: vi.fn(async () => {
        throw new Error('Database unavailable');
      }),
    });
    await enterQuestion('q');
    await act(async () => button('meeting.start').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Database unavailable');
    expect(button('meeting.start').disabled).toBe(false);
  });
  it('rejects unavailable model defaults without silently replacing them', async () => {
    await mount({ models: ['provider/other'] });
    await enterQuestion('q');
    expect(button('meeting.start').disabled).toBe(true);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('provider/model');
  });
  it('requires explicit reselection when a selected member disappears', async () => {
    const actions = await mount();
    await enterQuestion('q');
    await act(async () =>
      root.render(
        <TeamMeetingPanel
          members={members.slice(0, 2)}
          models={['provider/model']}
          records={[]}
          connected
          {...actions}
        />,
      ),
    );
    expect(button('meeting.start').disabled).toBe(true);
    expect(host.textContent).toContain('meeting.selectionChanged');
    await act(async () => button('meeting.reselect').click());
    expect(button('meeting.start').disabled).toBe(false);
  });
  it('shows real speaker stages, stop control and task links for an active record', async () => {
    const record = {
      id: 'meeting',
      question: 'Topic',
      status: 'running',
      turns: [
        { id: 't1', stage: 'proposal', agentName: 'Member a', status: 'running', taskId: 'task-a' },
        { id: 't2', stage: 'review', agentName: 'Member b', status: 'pending', taskId: 'task-b' },
        { id: 't3', stage: 'summary', agentName: 'Member c', status: 'pending', taskId: 'task-c' },
      ],
    } as TeamMeetingRecord;
    const actions = await mount({ records: [record] });
    expect(host.textContent).toContain('Member a');
    expect(button('meeting.start').disabled).toBe(true);
    await act(async () => button('meeting.stop').click());
    expect(actions.onStop).toHaveBeenCalledWith('meeting');
    await act(async () => button('meeting.stage.proposal').click());
    expect(actions.onOpenTask).toHaveBeenCalledWith('task-a');
  });
});
