// @vitest-environment jsdom

import { createRoot, type Root } from 'react-dom/client';
import { act, createElement, type ComponentType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveToolEntry, EffectiveToolsLoadState } from '@clawwork/shared';
import ToolsCatalog from '../src/renderer/components/ToolsCatalog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { reason?: string; count?: number }) =>
      `${key}:${options?.reason ?? options?.count ?? ''}`,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(ui: ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

type EffectiveProps = {
  groups: [];
  state: EffectiveToolsLoadState;
  onToolSelect?: (tool: EffectiveToolEntry) => void;
};

const EffectiveCatalog = ToolsCatalog as unknown as ComponentType<EffectiveProps>;

describe('ToolsCatalog effective inventory states', () => {
  it('shows the exact RPC failure instead of a selectable static tool list', () => {
    const container = render(
      createElement(EffectiveCatalog, {
        groups: [],
        state: { status: 'error', error: 'unknown session key' },
      }),
    );

    const trigger = container.querySelector('[data-testid="effective-tools-error"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('title')).toContain('unknown session key');
  });

  it('renders tools from a ready effective inventory', () => {
    const container = render(
      createElement(EffectiveCatalog, {
        groups: [],
        state: {
          status: 'ready',
          inventory: {
            agentId: 'main',
            profile: 'coding',
            groups: [
              {
                id: 'core',
                label: 'Core',
                source: 'core',
                tools: [{ id: 'exec', label: 'Exec', description: 'Run', rawDescription: 'Run', source: 'core' }],
              },
            ],
          },
        },
      }),
    );

    expect(container.querySelector('[title="rightPanel.toolCount:1"]')).not.toBeNull();
  });

  it('surfaces effective inventory notices on the tool trigger', () => {
    const container = render(
      createElement(EffectiveCatalog, {
        groups: [],
        state: {
          status: 'ready',
          inventory: {
            agentId: 'main',
            profile: 'coding',
            groups: [],
            notices: [{ id: 'mcp-not-yet-connected', severity: 'warning', message: 'MCP is not connected yet' }],
          },
        },
      }),
    );

    expect(container.querySelector('button')?.getAttribute('title')).toContain('MCP is not connected yet');
  });
});
