import { describe, expect, it, vi } from 'vitest';
import { createUiStore } from '../src/stores/ui-store.js';

function setup(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const store = createUiStore({
    updateSettings: vi.fn(),
    changeLanguage: vi.fn(),
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
    },
    getViewportWidth: () => 1266,
  });

  return { store, values };
}

describe('ui store assistant rail layout', () => {
  it('uses light mode for a profile without an explicit theme', () => {
    const { store } = setup();

    expect(store.getState().theme).toBe('light');
  });

  it('keeps an explicit dark theme selection', () => {
    const { store } = setup();

    store.getState().setTheme('dark');

    expect(store.getState().theme).toBe('dark');
  });

  it('starts the assistant rail at the approved 224px width', () => {
    const { store } = setup();

    expect(store.getState().leftNavWidth).toBe(224);
  });

  it('clamps a persisted legacy width into the 200px to 260px range', () => {
    const { store } = setup({ 'cw:leftNavWidth': '360' });

    expect(store.getState().leftNavWidth).toBe(260);
  });

  it('clamps assistant rail resize writes and persists the resolved width', () => {
    const { store, values } = setup();

    store.getState().setLeftNavWidth(120);
    expect(store.getState().leftNavWidth).toBe(200);
    expect(values.get('cw:leftNavWidth')).toBe('200');

    store.getState().setLeftNavWidth(360);
    expect(store.getState().leftNavWidth).toBe(260);
    expect(values.get('cw:leftNavWidth')).toBe('260');
  });
});
