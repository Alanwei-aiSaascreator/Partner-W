// @vitest-environment jsdom

/**
 * C3：团队卡片上**先说**"需要安装"。
 *
 * 为什么要有这一条：判据（`decideTeamChatEntry`）早就有，但**只在点下去时才用** ——
 * 用户被带进会话，才发现助手不在本机，还得自己退回来。卡片上先说，就知道该先装。
 *
 * ⚠️ 卡片**不自己读 store**：`needsInstall` 是算好传进来的，所以这里能单独测它。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { Team } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import TeamCard from '../src/renderer/layouts/TeamsPanel/TeamCard';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const team = {
  id: 'team-1',
  name: '内容团队',
  emoji: '🧩',
  description: '',
  gatewayId: 'gw-1',
  agents: [{ agentId: 'partner-w-content', isManager: true }],
} as unknown as Team;

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const noop = () => undefined;

describe('TeamCard：需要安装的团队在卡片上就说', () => {
  it('⭐ needsInstall ⇒ 卡片上有那枚标记', () => {
    const { container, unmount } = render(
      <TeamCard team={team} needsInstall onSelect={noop} onStartChat={noop} onEdit={noop} onDelete={noop} />,
    );

    expect(container.querySelector('[data-testid="team-needs-install"]')).not.toBeNull();
    expect(container.textContent).toContain('teams.needsInstall');
    unmount();
  });

  it('对照：装着的时候**不许**出现那枚标记（否则每张卡都是警告）', () => {
    const { container, unmount } = render(
      <TeamCard team={team} onSelect={noop} onStartChat={noop} onEdit={noop} onDelete={noop} />,
    );

    expect(container.querySelector('[data-testid="team-needs-install"]')).toBeNull();
    expect(container.textContent).not.toContain('teams.needsInstall');
    unmount();
  });

  it('对照：标记不影响"开始对话"按钮还在（点了会当面说清楚）', () => {
    const { container, unmount } = render(
      <TeamCard team={team} needsInstall onSelect={noop} onStartChat={noop} onEdit={noop} onDelete={noop} />,
    );

    expect(container.textContent).toContain('teams.startChat');
    unmount();
  });
});
