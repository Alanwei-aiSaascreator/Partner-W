# Gateway Model Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading “no models available” cold-start state with clear AI service startup and model preparation feedback that updates automatically when the gateway catalog arrives.

**Architecture:** Preserve the gateway dispatcher's existing retry behavior and the existing distinction between an absent catalog (`undefined`, still loading) and an empty catalog (`[]`, retries exhausted). Add a pure renderer helper that combines gateway connection status, raw catalog presence, and the filtered commercial model count into one presentation state, then use that state in the composer model control. No gateway lifecycle, activation, or billing behavior changes.

**Tech Stack:** TypeScript, React 19, Zustand, Radix Dropdown Menu, Tailwind CSS, Lucide React, i18next, Vitest.

---

### Task 1: Define and verify model preparation states

**Files:**

- Create: `packages/desktop/src/renderer/components/ChatInput/model-availability.ts`
- Create: `packages/desktop/test/model-availability.test.ts`

- [x] **Step 1: Write the failing state-derivation tests**

Create `packages/desktop/test/model-availability.test.ts` with explicit cases for gateway startup, catalog loading, confirmed empty results, and a ready catalog:

```ts
import { describe, expect, it } from 'vitest';
import { deriveModelAvailability } from '../src/renderer/components/ChatInput/model-availability.js';

describe('deriveModelAvailability', () => {
  it('reports service startup before the gateway connects', () => {
    expect(
      deriveModelAvailability({ gatewayId: 'gw-1', gatewayStatus: 'connecting', rawCatalog: undefined, modelCount: 0 }),
    ).toBe('service-starting');
  });

  it('reports model preparation while a connected gateway is still fetching its catalog', () => {
    expect(
      deriveModelAvailability({ gatewayId: 'gw-1', gatewayStatus: 'connected', rawCatalog: undefined, modelCount: 0 }),
    ).toBe('models-loading');
  });

  it('reports empty only after the catalog has resolved without commercial models', () => {
    expect(
      deriveModelAvailability({ gatewayId: 'gw-1', gatewayStatus: 'connected', rawCatalog: [], modelCount: 0 }),
    ).toBe('empty');
  });

  it('reports ready when a commercial model is available', () => {
    expect(
      deriveModelAvailability({
        gatewayId: 'gw-1',
        gatewayStatus: 'connected',
        rawCatalog: [{} as never],
        modelCount: 1,
      }),
    ).toBe('ready');
  });
});
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- model-availability.test.ts
```

Expected: FAIL because `model-availability.ts` does not exist.

- [x] **Step 3: Implement the pure state helper**

Create `packages/desktop/src/renderer/components/ChatInput/model-availability.ts`:

```ts
import type { ModelCatalogEntry } from '@clawwork/shared';
import type { GatewayConnectionStatus } from '@clawwork/core';

export type ModelAvailability = 'service-starting' | 'models-loading' | 'empty' | 'ready';

interface ModelAvailabilityInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawCatalog: ModelCatalogEntry[] | undefined;
  modelCount: number;
}

export function deriveModelAvailability({
  gatewayId,
  gatewayStatus,
  rawCatalog,
  modelCount,
}: ModelAvailabilityInput): ModelAvailability {
  if (!gatewayId || gatewayStatus !== 'connected') return 'service-starting';
  if (rawCatalog === undefined) return 'models-loading';
  if (modelCount === 0) return 'empty';
  return 'ready';
}
```

- [x] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- model-availability.test.ts
```

Expected: PASS with four passing tests.

- [x] **Step 5: Commit the state model**

```powershell
git add packages/desktop/src/renderer/components/ChatInput/model-availability.ts packages/desktop/test/model-availability.test.ts
git commit -m "test(chat): define model preparation states"
```

### Task 2: Show progress in the composer model control

**Files:**

- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts:100-150,600-625`
- Modify: `packages/desktop/src/renderer/components/ChatInput/index.tsx:235-250,455-470,740-805`
- Modify: `packages/desktop/test/use-chat-send.test.tsx:20-75,80-115`

- [x] **Step 1: Extend the hook harness with observable availability output**

In `packages/desktop/test/use-chat-send.test.tsx`, add `gatewaysLoaded`, make the gateway status and raw catalog resettable in `beforeEach`, and render `chat.modelAvailability`:

```tsx
uiState: {
  gatewaysLoaded: true,
  gatewayStatusMap: { 'gw-1': 'connected' } as Record<string, 'connected' | 'connecting' | 'disconnected'>,
  modelCatalogByGateway: {} as Record<string, ModelCatalogEntry[]>,
  toolsCatalogByGateway: {},
},

<div data-testid="model-availability">{chat.modelAvailability}</div>
```

Add a test that verifies the live hook keeps `undefined` distinct from `[]`:

```tsx
it('keeps a missing connected catalog in the loading state instead of reporting empty', () => {
  const { container, unmount } = render(<Harness />);
  expect(container.querySelector('[data-testid="model-availability"]')?.textContent).toBe('models-loading');
  unmount();
});
```

- [x] **Step 2: Run the hook test and confirm it fails**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- use-chat-send.test.tsx
```

Expected: FAIL because `useChatSend` does not return `modelAvailability`.

- [x] **Step 3: Preserve the raw catalog and derive availability in `useChatSend`**

Import `deriveModelAvailability`, keep `rawModelCatalog` separate from the filtered catalog, read the current gateway status, and return the derived state:

```ts
const rawModelCatalog = taskGwId ? modelCatalogByGateway[taskGwId] : undefined;
const modelCatalog = useMemo(() => relayModelsFrom(rawModelCatalog ?? EMPTY_MODELS_CATALOG), [rawModelCatalog]);
const gatewayStatus = useUiStore((s) => (taskGwId ? s.gatewayStatusMap[taskGwId] : undefined));
const modelAvailability = deriveModelAvailability({
  gatewayId: taskGwId,
  gatewayStatus,
  rawCatalog: rawModelCatalog,
  modelCount: modelCatalog.length,
});
```

Add `modelAvailability` to the return object without changing send validation or retry behavior.

- [x] **Step 4: Render truthful trigger and menu states in `ChatInput`**

Destructure `modelAvailability`. Compute preparation copy and use it in the model trigger:

```ts
const modelIsPreparing = modelAvailability === 'service-starting' || modelAvailability === 'models-loading';
const composerModelLabel = modelIsPreparing
  ? t(modelAvailability === 'service-starting' ? 'chatInput.aiServiceStarting' : 'chatInput.modelsLoading')
  : (currentModelEntry?.name ?? modelLabel).replace(/^[^/]+\//, '');
```

For `modelIsPreparing`, render `<Loader2 className="animate-spin" size={14} />`, set `aria-busy="true"`, and suppress model reasoning/context badges until the catalog is ready. In the open menu, replace the single italic empty row with a two-line status block:

```tsx
{
  modelIsPreparing ? (
    <DropdownMenuItem disabled className="max-w-80 items-start gap-2 py-3 opacity-100">
      <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-[var(--accent)]" />
      <span className="flex flex-col gap-1">
        <span className="type-body font-medium text-[var(--text-primary)]">
          {t(modelAvailability === 'service-starting' ? 'chatInput.aiServiceStarting' : 'chatInput.modelsLoading')}
        </span>
        <span className="type-support whitespace-normal text-[var(--text-muted)]">
          {t(
            modelAvailability === 'service-starting'
              ? 'chatInput.aiServiceStartingDetail'
              : 'chatInput.modelsLoadingDetail',
          )}
        </span>
      </span>
    </DropdownMenuItem>
  ) : modelAvailability === 'empty' ? (
    <DropdownMenuItem disabled className="max-w-80 items-start py-3 opacity-100">
      <span className="flex flex-col gap-1">
        <span className="type-body font-medium text-[var(--text-primary)]">{t('chatInput.noModelsAvailable')}</span>
        <span className="type-support whitespace-normal text-[var(--text-muted)]">
          {t('chatInput.noModelsAvailableDetail')}
        </span>
      </span>
    </DropdownMenuItem>
  ) : null;
}
```

- [x] **Step 5: Run the focused state and hook tests**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- model-availability.test.ts use-chat-send.test.tsx
```

Expected: PASS.

- [x] **Step 6: Commit the composer behavior**

```powershell
git add packages/desktop/src/renderer/components/ChatInput/useChatSend.ts packages/desktop/src/renderer/components/ChatInput/index.tsx packages/desktop/test/use-chat-send.test.tsx
git commit -m "feat(chat): explain gateway model preparation"
```

### Task 3: Add customer-facing translations and verify the desktop

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json:73-90`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json:73-90`

- [x] **Step 1: Add matching keys to every locale**

Add these keys beside `noModelsAvailable` in all nine locale files:

```json
"aiServiceStarting": "正在启动 AI 服务…",
"aiServiceStartingDetail": "首次启动可能需要约 1 分钟，请稍候。",
"modelsLoading": "正在准备模型…",
"modelsLoadingDetail": "准备完成后会自动显示，无需重复操作。",
"noModelsAvailable": "暂时没有可用模型",
"noModelsAvailableDetail": "请检查网络，或稍后重新打开模型列表。"
```

Use natural equivalents in the other eight languages while preserving the same meaning and key set.

- [x] **Step 2: Verify locale parity and TypeScript compilation**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- model-availability.test.ts use-chat-send.test.tsx
pnpm --filter @clawwork/desktop build
```

Expected: focused tests PASS and the desktop build completes successfully.

- [x] **Step 3: Verify the visible cold-start flow in light and dark themes**

Run the app with `pnpm --filter @clawwork/desktop dev`, then verify both Windows-following light and dark appearances:

1. Before gateway connection, the model control shows a spinner and “正在启动 AI 服务…”.
2. After connection but before a catalog arrives, it shows “正在准备模型…”.
3. Opening the model menu explains that models will appear automatically and that startup can take about one minute.
4. When the catalog arrives, the spinner and preparation copy disappear without a reload and the normal model families appear.
5. A resolved empty catalog is the only state that shows “暂时没有可用模型”.

- [x] **Step 4: Run repository checks and record pre-existing failures separately**

Run:

```powershell
pnpm check
```

Expected: new focused tests and build pass. If the existing ignored probe files still cause the known lint failures, report those filenames and do not modify them as part of this UI fix.

- [x] **Step 5: Commit translations and verification record**

```powershell
git add packages/desktop/src/renderer/i18n/locales
git commit -m "feat(i18n): localize model preparation feedback"
```

- [x] **Step 6: Push the completed feature branch**

```powershell
git push origin feat/stage3b-demo-polish
```

## Execution record

- Focused renderer tests: 8 passed across `model-availability.test.ts` and `use-chat-send.test.tsx`.
- Desktop source and test TypeScript checks: passed.
- Desktop production build: passed. Vite still reports the existing `@theme` Lightning CSS warning.
- i18n parity and unused-key checks: passed for all desktop and PWA locales.
- Renderer copy contract: passed.
- Manual Windows cold-start rehearsal: verified `正在启动 AI 服务…` → `正在准备模型…` → populated model families without a reload. Verified light and dark themes, then restored `自动` (follow Windows).
- Repository-wide `pnpm check`: stops at 127 existing lint errors in ignored investigation probes (`_scan-probes.cjs`, `_sdk-cache-probe.cjs`, and `packages/desktop/_scratch/*probe*.mjs`).
- Existing UI contract baseline: 5 violations in `AgentSwitcher.tsx` and `Login/index.tsx`, outside this change.
- Full desktop suite: 835 passed and 13 existing Windows/path-fixture assertions failed across `file-reader.test.ts`, `inbox-resolve.test.ts`, `inbox-save.test.ts`, `media-resolve.test.ts`, and `workspace-init.test.ts`.
