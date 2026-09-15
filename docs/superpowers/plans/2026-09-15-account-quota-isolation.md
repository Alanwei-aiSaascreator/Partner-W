# Account Quota Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block commercial chat unless the current account has a verified positive quota, remove the previous account's relay credentials on sign-out/account switch, and correct the workspace permission copy.

**Architecture:** Keep authorization as a fail-closed pure decision in the renderer and keep credential isolation in the Electron main process. Relay cleanup is an idempotent gateway configuration operation, persisted with a small `relayCleanupPending` flag when the gateway is unavailable; login bootstrap must drain that cleanup before applying a current-account relay credential.

**Tech Stack:** TypeScript, React 19, Zustand, Electron IPC, gateway `config.get`/`config.set`, Vitest, i18next.

---

## File map

- `packages/desktop/src/renderer/lib/quota.ts`: pure, fail-closed quota and commercial-send decision.
- `packages/desktop/src/renderer/stores/commercialStore.ts`: current-account overview state; cache is display-only and cannot authorize sending.
- `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`: invoke the pure gate before any model request.
- `packages/desktop/src/main/commercial/relay-config.ts`: build and apply a full sanitized gateway config with relay credentials removed.
- `packages/desktop/src/main/commercial/relay-cleanup.ts`: coordinate immediate/deferred cleanup and clear the local licence key.
- `packages/desktop/src/main/commercial/relay-startup.ts`: drain pending cleanup before commercial bootstrap after login/startup.
- `packages/desktop/src/main/ipc/commercial-handlers.ts`: connect sign-out and successful sign-in to credential isolation.
- `packages/desktop/src/main/workspace/config.ts`: persist `relayCleanupPending` in commercial config.
- `packages/desktop/src/renderer/i18n/locales/*.json`: truthful workspace/computer-tool consent copy.
- `packages/desktop/test/quota.test.ts`, `commercial-store.test.ts`, `relay-config.test.ts`, `relay-cleanup.test.ts`, `commercial-handlers.test.ts`: regression coverage.

### Task 1: Make zero and unverifiable quota fail closed

**Files:**

- Modify: `packages/desktop/test/quota.test.ts`
- Modify: `packages/desktop/src/renderer/lib/quota.ts`

- [ ] **Step 1: Write the failing quota tests**

Replace the two unlimited assertions with explicit blocking assertions and add a pure current-state gate:

```ts
expect(evaluateQuota(0, 0).level).toBe('exhausted');
expect(evaluateQuota(Number.NaN, 0).level).toBe('unknown-exhausted');
expect(evaluateCommercialSendAccess('loading', null)).toEqual({ allowed: false, reason: 'verifying' });
expect(evaluateCommercialSendAccess('offline', cachedOverview)).toEqual({ allowed: false, reason: 'unavailable' });
expect(evaluateCommercialSendAccess('ready', overviewWithoutLicense)).toEqual({ allowed: false, reason: 'unlicensed' });
expect(evaluateCommercialSendAccess('ready', overviewWithPositiveBalance).allowed).toBe(true);
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @clawwork/desktop test -- quota.test.ts`

Expected: FAIL because zero is still `unlimited` and `evaluateCommercialSendAccess` is not exported.

- [ ] **Step 3: Implement the fail-closed decision**

Use these public shapes in `quota.ts`:

```ts
export type CommercialSnapshotStatus = 'idle' | 'loading' | 'ready' | 'offline';
export type CommercialBlockReason = 'verifying' | 'unavailable' | 'unlicensed' | 'exhausted';
export type CommercialSendAccess =
  | { allowed: true; verdict: QuotaVerdict }
  | { allowed: false; reason: CommercialBlockReason; verdict?: QuotaVerdict };

export function evaluateCommercialSendAccess(
  status: CommercialSnapshotStatus,
  overview: CommercialAccountOverview | null,
): CommercialSendAccess;
```

Rules: only `status === 'ready'`, a present account, an active licence, finite positive total quota, finite usage, and remaining quota may return `allowed: true`. `evaluateQuota` returns `exhausted` for finite totals `<= 0` and `unknown-exhausted` for non-finite totals.

- [ ] **Step 4: Verify the quota tests pass**

Run: `pnpm --filter @clawwork/desktop test -- quota.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/test/quota.test.ts packages/desktop/src/renderer/lib/quota.ts
git commit -m "fix(commercial): fail closed on missing quota"
```

### Task 2: Prevent cached or failed account reads from authorizing chat

**Files:**

- Modify: `packages/desktop/test/commercial-store.test.ts`
- Modify: `packages/desktop/src/renderer/stores/commercialStore.ts`
- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`

- [ ] **Step 1: Write failing store tests**

Add coverage showing a failed foreground load marks the state `offline`, and a failed refresh also marks authorization unavailable while retaining the last overview only for display:

```ts
await useCommercialStore.getState().refresh();
expect(useCommercialStore.getState().status).toBe('offline');
expect(useCommercialStore.getState().overview).toEqual(cachedOverview);
```

- [ ] **Step 2: Verify the store test fails**

Run: `pnpm --filter @clawwork/desktop test -- commercial-store.test.ts`

Expected: FAIL because refresh currently leaves status `ready` after a failed request.

- [ ] **Step 3: Implement current-snapshot authorization**

Export `PanelStatus`; make failed `load`/`refresh` set `status: 'offline'`; preserve cached overview only as visual fallback. In `useChatSend.ts`, replace direct `evaluateQuota(...)` with:

```ts
const { status, overview } = useCommercialStore.getState();
const access = evaluateCommercialSendAccess(status, overview);
if (!access.allowed) {
  setQuotaBlocked(true);
  return;
}
const verdict = access.verdict;
```

- [ ] **Step 4: Verify quota and store tests pass**

Run: `pnpm --filter @clawwork/desktop test -- quota.test.ts commercial-store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/test/commercial-store.test.ts packages/desktop/src/renderer/stores/commercialStore.ts packages/desktop/src/renderer/components/ChatInput/useChatSend.ts
git commit -m "fix(chat): require a verified current account quota"
```

### Task 3: Remove stale relay providers without losing unrelated gateway config

**Files:**

- Modify: `packages/desktop/test/relay-config.test.ts`
- Modify: `packages/desktop/src/main/commercial/relay-config.ts`

- [ ] **Step 1: Write failing relay sanitization tests**

Cover multiple provider names pointing at `RELAY_BASE_URL`, unrelated providers, `plugins.allow`, and a default model that references the removed provider:

```ts
const clean = buildRelayCleanConfig(snapshot);
expect(clean.models.providers).toEqual({ personal: personalProvider });
expect(clean.plugins.allow).toEqual(['personal-plugin']);
expect(clean.agents.defaults.model.primary).toBeUndefined();
```

Also prove a non-relay default model and all unrelated configuration survive unchanged.

- [ ] **Step 2: Verify the relay test fails**

Run: `pnpm --filter @clawwork/desktop test -- relay-config.test.ts`

Expected: FAIL because `buildRelayCleanConfig` and `removeRelayConfig` do not exist.

- [ ] **Step 3: Implement full-config sanitization and verified write**

Add:

```ts
export function buildRelayCleanConfig(snapshot: unknown): Record<string, unknown> | null;
export async function removeRelayConfig(deps: RemoveRelayConfigDeps): Promise<RemoveRelayResult>;
```

`buildRelayCleanConfig` deep-clones `snapshot.config`, deletes only providers identified by `relayProviderIds`, removes those names plus `RELAY_PROVIDER_ID` from an existing `plugins.allow`, and deletes `agents.defaults.model.primary` only when its provider prefix was removed. Return `null` when no relay residue exists. `removeRelayConfig` uses `config.set` with the snapshot hash, retries hash conflicts up to three times, then rereads and succeeds only when `relayProviderIds` is empty.

- [ ] **Step 4: Verify relay tests pass**

Run: `pnpm --filter @clawwork/desktop test -- relay-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/test/relay-config.test.ts packages/desktop/src/main/commercial/relay-config.ts
git commit -m "fix(commercial): remove stale relay credentials"
```

### Task 4: Wire immediate and deferred cleanup into account transitions

**Files:**

- Modify: `packages/desktop/src/main/workspace/config.ts`
- Create: `packages/desktop/src/main/commercial/relay-cleanup.ts`
- Create: `packages/desktop/test/relay-cleanup.test.ts`
- Modify: `packages/desktop/src/main/commercial/relay-startup.ts`
- Modify: `packages/desktop/src/main/ipc/commercial-handlers.ts`
- Modify: `packages/desktop/test/commercial-handlers.test.ts`

- [ ] **Step 1: Write failing cleanup coordinator tests**

Test these exact transitions:

```ts
expect(await requestCommercialAccessCleanup(depsWithoutGateway)).toMatchObject({ pending: true });
expect(readConfig().commercial?.licenseKey).toBeUndefined();
expect(readConfig().commercial?.relayCleanupPending).toBe(true);

expect(await drainPendingCommercialAccessCleanup(depsWithGateway)).toMatchObject({ cleaned: true });
expect(readConfig().commercial?.relayCleanupPending).toBe(false);
```

Add handler expectations that sign-out awaits cleanup and successful OTP/password login drains stale cleanup before scheduling relay bootstrap.

- [ ] **Step 2: Verify the cleanup tests fail**

Run: `pnpm --filter @clawwork/desktop test -- relay-cleanup.test.ts commercial-handlers.test.ts`

Expected: FAIL because the coordinator is not implemented or invoked.

- [ ] **Step 3: Implement persistent cleanup coordination**

Extend `CommercialConfig`:

```ts
relayCleanupPending?: boolean;
```

The coordinator must clear `licenseKey` immediately, set `relayCleanupPending: true` before touching the gateway, call `removeRelayConfig` when connected, and clear the marker only after verified removal. Logging must never include credentials. `drainPendingCommercialAccessCleanup` is idempotent and a no-op when the marker is false.

- [ ] **Step 4: Wire transitions securely**

On `commercial:sign-out`, request local cleanup even if remote sign-out fails, then clear the session. On successful login, await pending cleanup before calling `notifyCommercialSignedIn`; this prevents bootstrap from treating the old relay provider as `already-applied`. Startup bootstrap must drain pending cleanup before applying any relay provider.

- [ ] **Step 5: Verify cleanup, bootstrap, licence and handler tests pass**

Run: `pnpm --filter @clawwork/desktop test -- relay-cleanup.test.ts commercial-handlers.test.ts relay-bootstrap.test.ts license-activate.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/desktop/src/main/workspace/config.ts packages/desktop/src/main/commercial/relay-cleanup.ts packages/desktop/src/main/commercial/relay-startup.ts packages/desktop/src/main/ipc/commercial-handlers.ts packages/desktop/test/relay-cleanup.test.ts packages/desktop/test/commercial-handlers.test.ts
git commit -m "fix(auth): isolate relay access across accounts"
```

### Task 5: Correct the workspace and computer-tool permission copy

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`

- [ ] **Step 1: Update the canonical Chinese copy**

Set `fileBrowser.workspaceAccessDescription` to:

```text
助手默认查看当前工作区和你主动添加的文件。需要访问电脑其他位置、调用电脑工具或保存文件到指定位置时，会先说明操作内容并由你确认。
```

Use a faithful English translation in the fallback locales and Traditional Chinese in `zh-TW`.

- [ ] **Step 2: Verify locale parity and copy policy**

Run: `pnpm check:i18n && pnpm check:renderer-copy`

Expected: both commands exit 0.

- [ ] **Step 3: Commit**

```powershell
git add packages/desktop/src/renderer/i18n/locales
git commit -m "copy(onboarding): explain computer tool consent"
```

### Task 6: Full regression and production build

**Files:**

- Verify only.

- [ ] **Step 1: Run focused commercial regression tests**

Run: `pnpm --filter @clawwork/desktop test -- quota.test.ts commercial-store.test.ts relay-config.test.ts relay-cleanup.test.ts commercial-handlers.test.ts relay-bootstrap.test.ts license-activate.test.ts`

Expected: all selected tests pass.

- [ ] **Step 2: Run desktop tests and repository checks**

Run: `pnpm --filter @clawwork/desktop test && pnpm typecheck && pnpm typecheck:tests && pnpm check:i18n && pnpm check:architecture`

Expected: all commands exit 0.

- [ ] **Step 3: Build the desktop production bundle**

Run: `pnpm --filter @clawwork/desktop build`

Expected: Electron main, preload, and renderer builds complete successfully.

- [ ] **Step 4: Live Demo acceptance**

In the running Electron Demo, verify: a new account with “额度待开通” cannot send; positive quota can send; sign-out removes commercial models; the updated workspace copy renders; switching to a new unlicensed account cannot use the previous account's model.

- [ ] **Step 5: Record final status**

Update the progress report with test totals, build result, remaining live-environment checks, commit IDs, and rollback tag. Commit with:

```powershell
git add docs/status/2026-09-15-basic-demo-progress.md
git commit -m "docs(demo): record quota isolation verification"
```
