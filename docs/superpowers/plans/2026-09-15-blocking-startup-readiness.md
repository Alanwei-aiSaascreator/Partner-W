# Blocking Startup Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prepare the gateway, commercial models, and six bundled assistants in parallel, then block entry to the main workspace until every capability is ready.

**Architecture:** Add an explicit forced agent-catalog refresh to the existing gateway dispatcher. A small tested coordinator serializes preset reconciliation per gateway, while a renderer hook combines that state with the existing gateway and model stores. `App` mounts preparation early and renders one blocking readiness screen after login and onboarding until the derived state is ready.

**Tech Stack:** TypeScript, React 19, Zustand, Electron renderer bridge, Tailwind CSS, Lucide React, i18next, Vitest.

---

## File map

- `packages/core/src/services/gateway-dispatcher.ts`: preserve cached catalog reads while adding an explicit force option.
- `packages/core/test/gateway-dispatcher.test.ts`: prove normal reads skip and forced reads replace a stale catalog.
- `packages/desktop/src/renderer/hooks/useGatewayDispatcherSetup.ts`: expose the core force option to renderer coordination.
- `packages/desktop/src/renderer/lib/preset-agent-bootstrap.ts`: own per-gateway in-flight deduplication, progress snapshots, forced refresh, install, and post-install reconciliation.
- `packages/desktop/test/preset-agent-bootstrap.test.ts`: verify ready warm starts, real progress, stale-catalog repair, retry, and concurrent deduplication.
- `packages/desktop/src/renderer/hooks/useStartupReadiness.ts`: start assistant preparation early and derive overall readiness from existing stores.
- `packages/desktop/src/renderer/lib/startup-readiness.ts`: keep gateway/model/assistant presentation-state derivation pure.
- `packages/desktop/test/startup-readiness.test.ts`: verify every blocking and ready state.
- `packages/desktop/src/renderer/layouts/StartupReadiness/index.tsx`: render the combined status panel and real assistant progress bar.
- `packages/desktop/test/startup-readiness-screen.test.tsx`: verify status copy, progress semantics, failure details, and retry.
- `packages/desktop/src/renderer/App.tsx`: mount readiness beside gateway bootstrap and gate the main shell.
- `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`: remove manual preset installation ownership.
- `packages/desktop/src/renderer/layouts/MainArea/PresetAgentPackControl.tsx`: remove the superseded welcome-screen control.
- `packages/desktop/test/welcome-screen.test.tsx`: prove the old manual setup action is gone.
- `packages/desktop/test/preset-agent-pack-control.test.tsx`: remove tests for the deleted control.
- `packages/desktop/src/renderer/i18n/locales/*.json`: add matching startup-readiness copy in all nine desktop locales.

### Task 1: Force-refresh a stale assistant catalog

**Files:**

- Modify: `packages/core/test/gateway-dispatcher.test.ts`
- Modify: `packages/core/src/services/gateway-dispatcher.ts`
- Modify: `packages/desktop/src/renderer/hooks/useGatewayDispatcherSetup.ts`

- [x] **Step 1: Write failing dispatcher tests**

Add a `fetchAgentsForGateway` suite that replaces `deps.gateway.listAgents` with a spy returning one preset assistant. Verify the cached call makes zero transport requests, then verify `{ force: true }` makes one request and calls `setAgentCatalogForGateway`:

```ts
describe('fetchAgentsForGateway', () => {
  it('keeps the cache for ordinary reads', async () => {
    const h = createHarness();
    h.deps.gateway.listAgents = vi.fn();
    await h.dispatcher.fetchAgentsForGateway('gw-1', { 'gw-1': { agents: [] } });
    expect(h.deps.gateway.listAgents).not.toHaveBeenCalled();
  });

  it('replaces a stale catalog when force is requested', async () => {
    const h = createHarness();
    const agents = [{ id: 'main' }, { id: 'partner-w-content' }];
    h.deps.gateway.listAgents = vi.fn(async () => ({ ok: true, result: { agents, defaultId: 'main' } }));
    await h.dispatcher.fetchAgentsForGateway('gw-1', { 'gw-1': { agents: [{ id: 'main' }] } }, { force: true });
    expect(h.deps.gateway.listAgents).toHaveBeenCalledWith('gw-1');
    expect(h.deps.setAgentCatalogForGateway).toHaveBeenCalledWith('gw-1', agents, 'main');
  });
});
```

- [x] **Step 2: Run the focused core test and confirm the new force call fails**

Run:

```powershell
pnpm --filter @clawwork/core test -- gateway-dispatcher.test.ts
```

Expected: the forced-refresh assertion fails because the third argument is ignored.

- [x] **Step 3: Add the explicit force option**

Change the core method to accept an optional options object and bypass only the cache guard:

```ts
interface FetchAgentsOptions {
  force?: boolean;
}

async function fetchAgentsForGateway(
  gatewayId: string,
  agentCatalogByGateway: Record<string, unknown>,
  options: FetchAgentsOptions = {},
): Promise<void> {
  if (!options.force && agentCatalogByGateway[gatewayId]) return;
```

Update the renderer wrapper without changing existing callers:

```ts
export async function fetchAgentsForGateway(gatewayId: string, options: { force?: boolean } = {}): Promise<void> {
  const agentCatalog = useUiStore.getState().agentCatalogByGateway;
  return getDispatcher().fetchAgentsForGateway(gatewayId, agentCatalog, options);
}
```

- [x] **Step 4: Run the focused core test and confirm both cache behaviors pass**

Run:

```powershell
pnpm --filter @clawwork/core test -- gateway-dispatcher.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit the catalog fix**

```powershell
git add packages/core/src/services/gateway-dispatcher.ts packages/core/test/gateway-dispatcher.test.ts packages/desktop/src/renderer/hooks/useGatewayDispatcherSetup.ts
git commit -m "fix(agents): refresh stale gateway catalogs"
```

### Task 2: Serialize and reconcile bundled assistant setup

**Files:**

- Create: `packages/desktop/src/renderer/lib/preset-agent-bootstrap.ts`
- Create: `packages/desktop/test/preset-agent-bootstrap.test.ts`

- [x] **Step 1: Write failing coordinator tests**

Define injected dependencies so tests never touch Electron globals:

```ts
interface PresetAgentBootstrapDeps {
  refreshAgents: () => Promise<void>;
  readAgentIds: () => string[];
  install: (
    currentAgentIds: string[],
    onProgress: (progress: PresetAgentInstallProgress) => void,
  ) => Promise<PresetAgentInstallResult>;
}
```

Test these observable cases:

1. forced refresh finds all six IDs and `install` is never called;
2. a stale `{main}` catalog becomes complete after install and post-refresh;
3. emitted snapshots move through `verifying` and `installing`, preserving the real `completed`, `total`, and `currentId` values;
4. two simultaneous `run('gw-1')` calls share one refresh/install operation;
5. a missing role after post-refresh produces `error` with exactly that `missingIds` entry;
6. calling `reset('gw-1')` after a failed run allows a new attempt.

- [x] **Step 2: Run the focused test and confirm the module is missing**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- preset-agent-bootstrap.test.ts
```

Expected: FAIL because `preset-agent-bootstrap.ts` does not exist.

- [x] **Step 3: Implement the coordinator**

Create a coordinator with `subscribe`, `getSnapshot`, `run`, and `reset`. Store snapshots, listeners, and in-flight promises in maps keyed by gateway ID. A run must:

```ts
emit(gatewayId, { phase: 'verifying', completed: 0, total: PRESET_AGENT_IDS.length, missingIds: [] });
await deps.refreshAgents();
const currentAgentIds = deps.readAgentIds();
const missingBefore = PRESET_AGENT_IDS.filter((id) => !currentAgentIds.includes(id));
if (missingBefore.length === 0) return emitReady(gatewayId);
emit(gatewayId, { phase: 'installing', completed: PRESET_AGENT_IDS.length - missingBefore.length, ... });
await deps.install(currentAgentIds, (progress) => emitProgress(gatewayId, progress));
await deps.refreshAgents();
const missingAfter = PRESET_AGENT_IDS.filter((id) => !deps.readAgentIds().includes(id));
return missingAfter.length === 0 ? emitReady(gatewayId) : emitError(gatewayId, missingAfter);
```

Return the existing in-flight promise before starting another run. Always clear only the in-flight entry in `finally`; retain the final snapshot so a Strict Mode remount receives current progress immediately.

- [x] **Step 4: Run the coordinator tests**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- preset-agent-bootstrap.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit the assistant bootstrap coordinator**

```powershell
git add packages/desktop/src/renderer/lib/preset-agent-bootstrap.ts packages/desktop/test/preset-agent-bootstrap.test.ts
git commit -m "feat(agents): reconcile bundled assistants at startup"
```

### Task 3: Derive one startup-readiness state

**Files:**

- Create: `packages/desktop/src/renderer/lib/startup-readiness.ts`
- Create: `packages/desktop/test/startup-readiness.test.ts`
- Create: `packages/desktop/src/renderer/hooks/useStartupReadiness.ts`

- [x] **Step 1: Write failing pure-state tests**

Use the existing `deriveModelAvailability` and test that the new helper returns:

- AI `starting` while no connected gateway exists;
- AI `loading-models` for a connected gateway with an undefined catalog;
- AI `error` only for a resolved catalog with zero relay models;
- assistants `waiting` before gateway connection;
- assistants `verifying`, `installing`, `ready`, or `error` from coordinator snapshots;
- overall `isReady: true` only when AI and assistants are both ready.

- [x] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- startup-readiness.test.ts
```

Expected: FAIL because the helper does not exist.

- [x] **Step 3: Implement the pure state and renderer hook**

Create string-literal state types and derive the usable model count with `relayModelsFrom(rawCatalog ?? [])`. The hook must use granular Zustand selectors, subscribe to the per-gateway assistant coordinator, and start a run only when the workspace is enabled and the selected gateway is connected.

The coordinator dependencies passed by the hook must use:

```ts
refreshAgents: () => fetchAgentsForGateway(gatewayId, { force: true }),
readAgentIds: () => useUiStore.getState().agentCatalogByGateway[gatewayId]?.agents.map((agent) => agent.id) ?? [],
install: async (currentAgentIds, onProgress) => {
  const workspaceRoot = await window.clawwork.getWorkspacePath();
  if (!workspaceRoot) throw new Error('workspace unavailable');
  return installPresetAgentPack({
    gatewayId,
    workspaceRoot,
    currentAgentIds,
    displayNames,
    api: {
      createAgent: window.clawwork.createAgent,
      updateAgent: window.clawwork.updateAgent,
      setAgentFile: window.clawwork.setAgentFile,
      deleteAgent: window.clawwork.deleteAgent,
    },
    onProgress,
  });
},
```

Expose `retry`. Assistant-only failures reset and rerun the coordinator. Gateway/model failures call `reinitializeGatewayBootstrap`; the connected-state effect starts assistant reconciliation once the gateway returns.

- [x] **Step 4: Run pure readiness and coordinator tests**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- startup-readiness.test.ts preset-agent-bootstrap.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit the startup hook**

```powershell
git add packages/desktop/src/renderer/lib/startup-readiness.ts packages/desktop/src/renderer/hooks/useStartupReadiness.ts packages/desktop/test/startup-readiness.test.ts
git commit -m "feat(startup): derive product readiness"
```

### Task 4: Replace the manual setup card with a blocking readiness screen

**Files:**

- Create: `packages/desktop/src/renderer/layouts/StartupReadiness/index.tsx`
- Create: `packages/desktop/test/startup-readiness-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/test/welcome-screen.test.tsx`
- Delete: `packages/desktop/src/renderer/layouts/MainArea/PresetAgentPackControl.tsx`
- Delete: `packages/desktop/test/preset-agent-pack-control.test.tsx`

- [x] **Step 1: Write failing readiness-screen tests**

Render the new screen with explicit props and assert:

- a starting state contains the AI startup key and `aria-busy="true"`;
- installation at `2 / 6` renders `aria-valuenow="2"`, `aria-valuemax="6"`, and the current localized role;
- a failure names each missing localized role and provides a button that invokes `onRetry`;
- a ready capability row uses text and an icon, rather than color alone.

Update `welcome-screen.test.tsx` to assert `presetAgents.install` is absent and remove installer, gateway refresh, and Electron mutation mocks.

- [x] **Step 2: Run the screen and welcome tests and confirm the new screen is missing**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- startup-readiness-screen.test.tsx welcome-screen.test.tsx
```

Expected: the startup-screen import fails.

- [x] **Step 3: Build the readiness screen**

Create a restrained centered layout using existing CSS variables. Render a product mark, one explanatory sentence, and two bordered rows. Use `LoaderCircle`, `Check`, `Bot`, `Boxes`, and `RefreshCw` from `lucide-react`. The assistant progress element must use the actual count:

```tsx
<div
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={readiness.assistants.total}
  aria-valuenow={readiness.assistants.completed}
>
  <div style={{ width: `${(completed / total) * 100}%` }} />
</div>
```

The dynamic area uses `aria-live="polite"`, and the screen root uses `aria-busy={!readiness.isReady}`.

- [x] **Step 4: Gate the shell and remove the old setup path**

Call `useStartupReadiness(ready)` unconditionally after gateway bootstrap. Keep login, workspace setup, and onboarding ahead of the readiness screen. Immediately before the current main-shell return, add:

```tsx
if (!startupReadiness.isReady) {
  return (
    <TooltipProvider>
      <StartupReadiness readiness={startupReadiness} onRetry={startupReadiness.retry} />
      <AppToaster themeMode={themeMode} />
    </TooltipProvider>
  );
}
```

Remove `installPresetAgentPack`, `fetchAgentsForGateway`, installation state, installation callbacks, and `PresetAgentPackControl` from `WelcomeScreen`. Delete the superseded component and its test.

- [x] **Step 5: Run the component tests**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- startup-readiness-screen.test.tsx welcome-screen.test.tsx startup-readiness.test.ts preset-agent-bootstrap.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit the blocking experience**

```powershell
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/layouts/StartupReadiness packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/test/welcome-screen.test.tsx
git add -u packages/desktop/src/renderer/layouts/MainArea/PresetAgentPackControl.tsx packages/desktop/test/preset-agent-pack-control.test.tsx
git commit -m "feat(startup): block workspace until assistants are ready"
```

### Task 5: Localize and verify the complete flow

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`

- [x] **Step 1: Add the same startup key structure to every locale**

Add a `startupReadiness` object beside `presetAgents`. The Simplified Chinese source is:

```json
{
  "title": "正在准备Partner-W",
  "description": "首次启动通常需要约 1 分钟，准备完成后会自动进入首页。",
  "keepOpen": "请保持应用开启，无需重复操作。",
  "aiTitle": "AI 服务",
  "aiStarting": "正在启动 AI 服务",
  "aiLoadingModels": "正在准备可用模型",
  "aiReady": "模型已准备好",
  "aiError": "暂时没有可用模型",
  "assistantsTitle": "常用助手",
  "assistantsWaiting": "等待 AI 服务启动",
  "assistantsVerifying": "正在检查内置助手",
  "assistantsInstalling": "正在配置 {{name}}",
  "assistantsReady": "6 个常用助手已就绪",
  "assistantsError": "这些助手尚未完成：{{names}}",
  "progress": "{{completed}} / {{total}}",
  "retry": "重新准备"
}
```

Translate the same keys naturally in the other eight locale files and preserve interpolation placeholders.

- [x] **Step 2: Run formatting, focused tests, TypeScript, and i18n checks**

Run:

```powershell
pnpm exec prettier --write packages/core/src/services/gateway-dispatcher.ts packages/core/test/gateway-dispatcher.test.ts packages/desktop/src/renderer/hooks/useGatewayDispatcherSetup.ts packages/desktop/src/renderer/lib/preset-agent-bootstrap.ts packages/desktop/src/renderer/lib/startup-readiness.ts packages/desktop/src/renderer/hooks/useStartupReadiness.ts packages/desktop/src/renderer/layouts/StartupReadiness/index.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx packages/desktop/test/preset-agent-bootstrap.test.ts packages/desktop/test/startup-readiness.test.ts packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/test/welcome-screen.test.tsx packages/desktop/src/renderer/i18n/locales/*.json
pnpm --filter @clawwork/core test -- gateway-dispatcher.test.ts
pnpm --filter @clawwork/desktop test -- preset-agent-bootstrap.test.ts startup-readiness.test.ts startup-readiness-screen.test.tsx welcome-screen.test.tsx
pnpm typecheck
pnpm typecheck:tests
pnpm check:i18n
pnpm check:renderer-copy
pnpm check:ui-contract
pnpm --filter @clawwork/desktop build
```

Expected: targeted tests, type checks, i18n, renderer-copy, UI contract, and build pass. Preserve the known LightningCSS `@theme` warning as a reported baseline if it remains.

- [x] **Step 3: Run the full core and desktop suites once**

Run:

```powershell
pnpm --filter @clawwork/core test
pnpm --filter @clawwork/desktop test
```

Expected: core remains green. Desktop adds no failures beyond the recorded 13 Windows/path-fixture failures in file reader, inbox resolve/save, media resolve, and workspace init tests.

- [x] **Step 4: Rehearse the Electron experience in both themes**

Run:

```powershell
pnpm --filter @clawwork/desktop dev
```

Verify:

1. the screen says the AI service and models are being prepared instead of “no models” during startup;
2. the assistant row is on the same screen and shows a real count and current role;
3. the shell opens only after model and six-assistant readiness;
4. a warm profile with all assistants performs no duplicate creation and opens after verification;
5. the persistent rail immediately shows Compass Assistant plus six built-ins;
6. the screen is legible in light and dark themes, then restore Follow Windows.

- [x] **Step 5: Commit locales and verification record**

```powershell
git add packages/desktop/src/renderer/i18n/locales docs/superpowers/plans/2026-09-15-blocking-startup-readiness.md
git commit -m "feat(i18n): localize startup readiness"
```

- [x] **Step 6: Push the feature branch**

```powershell
git push origin feat/stage3b-demo-polish
```

## Execution record — 2026-09-15

- Implemented and committed Tasks 1–5 on `feat/stage3b-demo-polish`; `main` remains unchanged.
- Focused verification: gateway dispatcher 26/26; startup readiness, bundled assistant bootstrap, readiness screen, and welcome screen 20/20.
- Static verification: production and test TypeScript checks, i18n parity/usage, renderer copy, UI contract, and production desktop build passed.
- Full suites: core 178/178 passed; desktop 849 passed with the same 13 recorded Windows path-fixture failures across file reader, inbox resolve/save, media resolve, and workspace init.
- Electron rehearsal: light and dark startup screens were legible; the workspace remained blocked while models loaded, then opened with Compass Assistant plus all six bundled assistants. Existing assistants were not recreated.
- Observed warm-profile startup times were approximately 37 seconds and 74 seconds. The slower run included an 8-second commercial-auth probe timeout before the gateway bootstrap. User copy remains “usually about 1 minute”; operational guidance should surface retry/network help after 90 seconds.
- Restored the application theme setting to `auto` after dark-mode verification.
- Existing build warnings remain: the mixed static/dynamic import for `device-identity.ts` and LightningCSS reporting unknown `@theme`.
- Follow-up verification repaired five platform-specific test fixtures (`file-reader`, `inbox-resolve`, `inbox-save`, `media-resolve`, and `workspace-init`) without changing production code. The Windows desktop suite is now 104/104 files and 862/862 tests passing.
