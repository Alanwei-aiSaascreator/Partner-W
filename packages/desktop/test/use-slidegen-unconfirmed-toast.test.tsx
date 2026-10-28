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
it('图12：原始诊断码与英文解析器原文不进 toast，只出产品化文案', () => {
  // 2026-10-06 商业验收：`[dsl-close-mismatch @34] expected </Text> but found </Slide>`
  // 是内部诊断码 + 解析器原文，不许出现在用户可见的 toast 里（原始对象改走 console）。
  const failure: SlidegenFailure = {
    code: 'slidegen-unparsable',
    diagnostic: { code: 'dsl-close-mismatch', offset: 34, detail: 'expected </Text> but found </Slide>' },
  };
  expect(copy.slidegenFailureToastBody([failure], t)).toBe('slidegen.fail.unparsable');

  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let receive: ((failures: SlidegenFailure[]) => void) | undefined;
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onSlidegenFailed: (callback: typeof receive) => {
        receive = callback;
        return () => {};
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
    act(() => receive?.([failure]));
    const lastCall = mocks.error.mock.calls.at(-1) as [string, { description: string }] | undefined;
    const description = lastCall?.[1]?.description ?? '';
    expect(lastCall?.[0]).toBe('slidegen.failedTitle');
    expect(description).toBe('slidegen.fail.unparsable');
    expect(description).not.toContain('dsl-close-mismatch');
    expect(description).not.toContain('expected </Text>');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
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
