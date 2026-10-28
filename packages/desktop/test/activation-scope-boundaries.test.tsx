// @vitest-environment jsdom
/**
 * R2（2026-10-10 集中终审 §4）：**A 的激活成功 / overview 迟到于 B** ——
 * 切号（scopeKey A→B，整实例重挂）并 clearCache 之后，A 的迟到回包：
 *   ① 不许写内存/磁盘缓存；② 不许调用已卸载实例的准备重试；③ 不发辅助统计。
 *
 * 与主审 U2 裁判（ui-boundaries.test.tsx 的 stale-activation 例）同构的
 * **正式回归**：真实 EntryPreparation + 真实 ActivationSection + 真实
 * commercialStore + 真实 entry-license-gate，只桩 window.clawwork 与 toast。
 */
import React, { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EntryPreparation from '@/layouts/EntryPreparation';
import { useCommercialStore } from '@/stores/commercialStore';
import type { EntryPreparationFacts } from '@/lib/entry-preparation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const facts: EntryPreparationFacts = {
  scopeKey: 'A',
  currentScopeKey: 'A',
  accountUserId: 'A',
  entitlement: { userId: 'A', licenseId: 'old-card', orgId: 'org', status: 'active', expiresAt: null },
  runtime: { ok: true },
  startup: {
    gatewayId: 'local-runtime',
    relayPhase: 'blocked',
    relayFailure: { kind: 'entitlement-rejected', errorCode: 'license_expired' },
    ai: { phase: 'error' },
    assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
    workspaceAvailable: true,
    conversationReady: false,
    composerBlocked: false,
    isReady: false,
    hasError: true,
  },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  useCommercialStore.getState().clearCache();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('⭐ A 的激活/overview 迟到于 B：旧缓存、旧 retry、辅助统计一律不落', async () => {
  const work = deferred<unknown>();
  const api = {
    commercialLicenseActivate: vi.fn(async () => ({ ok: true })),
    commercialLicenseRecoverActivation: vi.fn(async () => ({ ok: true })),
    commercialAccountOverview: vi.fn(() => work.promise),
    commercialUsageReport: vi.fn(async () => 0),
  };
  Object.defineProperty(window, 'clawwork', { configurable: true, value: api });

  const retryA = vi.fn(async () => {});
  const retryB = vi.fn(async () => {});
  const element = (f: EntryPreparationFacts, retry: () => Promise<void>): ReactElement => (
    <EntryPreparation
      key={f.currentScopeKey}
      facts={f}
      onRetry={retry}
      onContinue={async () => {}}
      onChooseWorkspace={() => {}}
      onChangeAccount={async () => {}}
    />
  );

  act(() => root.render(element(facts, retryA)));
  act(() => container.querySelector<HTMLButtonElement>('[data-entry-activation]')!.click());
  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'REVIEW-SYNTHETIC-CARD');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(api.commercialLicenseActivate).toHaveBeenCalledTimes(1);
  expect(api.commercialAccountOverview).toHaveBeenCalledTimes(1); // load 挂起中

  // 切号：scopeKey A→B（整实例换 key 重挂）＋ 清缓存（epoch++）
  const next: EntryPreparationFacts = {
    ...facts,
    scopeKey: 'B',
    currentScopeKey: 'B',
    accountUserId: 'B',
    entitlement: { ...facts.entitlement!, userId: 'B' },
  };
  act(() => root.render(element(next, retryB)));
  useCommercialStore.getState().clearCache();

  // A 的 overview 此刻迟到返回
  await act(async () => {
    work.resolve({
      ok: true,
      result: {
        account: { userId: 'A', phone: null, email: null, nickname: null, avatar: null },
        org: null,
        license: null,
        device: { fingerprint: 'review', shortFingerprint: 'review' },
        fetchedAt: '2026-10-10T00:00:00Z',
      },
    });
  });

  // 旧代次弃置：缓存不写、旧 retry 不调、辅助统计不发、新 retry 也不被误触
  expect(retryA).not.toHaveBeenCalled();
  expect(retryB).not.toHaveBeenCalled();
  expect(api.commercialUsageReport).not.toHaveBeenCalled();
  expect(useCommercialStore.getState().overview).toBeNull();
  expect(window.localStorage.getItem('cw:commercial-overview')).toBeNull();
});
