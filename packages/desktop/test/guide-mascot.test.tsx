// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import GuideMascot from '../src/renderer/components/GuideMascot';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('GuideMascot', () => {
  it('moves the same two arm groups into the covering pose', () => {
    const { container, unmount } = render(<GuideMascot pose="covering" />);

    expect(container.querySelectorAll('[data-arm]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-arm][data-pose="covering"]')).toHaveLength(2);
    expect(container.querySelector('[data-floating-hand]')).toBeNull();

    unmount();
  });

  it('exposes the current pose without changing the arm count', () => {
    const { container, unmount } = render(<GuideMascot pose="idle" />);

    expect(container.querySelector('svg')?.getAttribute('data-pose')).toBe('idle');
    expect(container.querySelectorAll('[data-arm]')).toHaveLength(2);

    unmount();
  });

  it('uses a dedicated high-contrast color for both pupils', () => {
    const { container, unmount } = render(<GuideMascot pose="idle" />);
    const pupils = container.querySelectorAll('[data-mascot-pupil]');

    expect(pupils).toHaveLength(2);
    expect([...pupils].every((pupil) => pupil.getAttribute('fill') === 'var(--mascot-eye)')).toBe(true);

    unmount();
  });
});
