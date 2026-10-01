// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SlidegenFailure } from '@clawwork/shared';
import * as copy from '../src/renderer/lib/slidegen-copy';
const mocks = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: mocks }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { useSlidegenToast } from '../src/renderer/hooks/useSlidegenToast';
const t = (key: string) => key;
const unknown = { code: 'slidegen-output-unconfirmed' as const };

it('uses uncertainty copy instead of claiming that no file was generated', () => {
  expect(copy.slidegenFailureToastBody([unknown], t)).toBe('slidegen.fail.outputUnconfirmed');
  expect(copy.slidegenFailureToastTitle).toBeTypeOf('function');
  expect(copy.slidegenFailureToastTitle([unknown], t)).toBe('slidegen.unconfirmedTitle');
  expect(copy.slidegenFailureToastTitle([{ code: 'slidegen-render-failed' }], t)).toBe('slidegen.failedTitle');
});
it('shows the actual uncertainty title when the IPC failure reaches a mounted hook', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let receive: ((failures: SlidegenFailure[]) => void) | undefined;
  const cleanup = vi.fn();
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onSlidegenFailed: (callback: typeof receive) => {
        receive = callback;
        return cleanup;
      },
    },
  });
  const root = createRoot(document.createElement('div'));
  function Harness() {
    useSlidegenToast();
    return null;
  }
  try {
    act(() => root.render(<Harness />));
    act(() => receive?.([unknown]));
    expect(mocks.error).toHaveBeenCalledWith('slidegen.unconfirmedTitle', {
      description: 'slidegen.fail.outputUnconfirmed',
    });
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(cleanup).toHaveBeenCalledOnce();
});
it('ships both uncertainty strings in every supported locale', () => {
  for (const locale of ['en', 'zh', 'zh-TW', 'de', 'es', 'fr', 'ja', 'ko', 'pt']) {
    const data = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, `../src/renderer/i18n/locales/${locale}.json`), 'utf8'),
    );
    expect(data.slidegen.fail.outputUnconfirmed).toBeTypeOf('string');
    expect(data.slidegen.unconfirmedTitle).toBeTypeOf('string');
  }
});
