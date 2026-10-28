# Multi-organization License Bootstrap Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a portable profile with an existing license work on a new computer for a rightful multi-organization owner, and replace indefinite model preparation with a truthful, actionable authorization state.

**Architecture:** The backend treats an already-bound license organization as authoritative and verifies exact owner membership before returning its relay credential. The desktop carries a bounded error code through relay bootstrap, publishes a secret-free main-process snapshot through query/event IPC, and lets startup readiness override guessed catalog loading with the known authorization result.

**Tech Stack:** PostgreSQL/Supabase migrations and SQL regression tests; Electron main/preload IPC; TypeScript; React; Vitest; i18next.

---

## Repositories and starting state

- Backend: `D:\Desktop\new project\partner-w`
  - expected branch: `feat/p2-market-creator`
  - expected HEAD before work: `2db2238`
  - preserve these unrelated untracked paths: `Codex-接管-真实现状与开工指令.md`, `partner-w`, `open-source-agent-references/`
- Desktop: `D:\Desktop\new project\partner-w\partner-w-desktop\.worktrees\fix-local-credential-exposure`
  - expected branch: `fix/local-credential-exposure`
  - design commit: `2bfa6cec`
  - governing design: `docs/superpowers/specs/2026-09-21-multi-org-license-bootstrap-design.md`

Do not deploy a linked/production Supabase project, publish an update feed, build a release archive, rebind a production card, or use `git add -A`. Re-read `AGENTS.md` and every `docs/agent-rules/*.md` before editing. Re-run `git log -1 --oneline` immediately before every commit because another session may be active.

## File map

### Backend

- Create `scripts/tests/activate_license_multi_org.sql`: isolated transaction-level regression and security assertions.
- Create `supabase/migrations/20260921000056_activate_license_bound_org_owner.sql`: append-only replacement of the final effective RPC.
- Read, but do not edit, `supabase/migrations/20260912000023_billing_micros.sql`: source of the final effective `activate_license`, including micro-unit fields.

### Desktop

- Modify `packages/desktop/src/main/commercial/license.ts`: export the one activation-error classifier.
- Modify `packages/desktop/src/main/commercial/relay-bootstrap.ts`: accept structured relay-key results and preserve safe codes.
- Modify `packages/desktop/src/main/commercial/relay-startup.ts`: classify RPC failures, drive the single-flight runner, and publish public state.
- Modify `packages/desktop/src/main/ipc/commercial-handlers.ts`: state read, manual retry, sign-in reset, and sign-out reset.
- Modify `packages/desktop/src/preload/index.ts` and `packages/desktop/src/preload/clawwork.d.ts`: narrow read/subscribe/retry surface.
- Create `packages/shared/src/commercial-relay-state.ts` and export it from `packages/shared/src/index.ts`: shared secret-free DTO.
- Create `packages/shared/test/commercial-relay-state.test.ts`: lock the public DTO whitelist.
- Modify `packages/desktop/src/renderer/hooks/useStartupReadiness.ts`: subscribe/read without a race and coordinate retry.
- Modify `packages/desktop/src/renderer/lib/startup-readiness.ts`: known relay failure overrides inferred catalog loading.
- Modify `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`: actionable active-workspace error UI.
- Modify `packages/desktop/src/renderer/layouts/MainArea/index.tsx` and `packages/desktop/src/renderer/components/ChatInput/index.tsx`: activation navigation and no false spinner.
- Modify all `packages/desktop/src/renderer/i18n/locales/*.json`: localized bounded copy.
- Extend existing tests and create the focused tests named below.

---

### Task 1: Backend multi-organization regression

**Files:**

- Create: `D:\Desktop\new project\partner-w\scripts\tests\activate_license_multi_org.sql`
- Create: `D:\Desktop\new project\partner-w\supabase\migrations\20260921000056_activate_license_bound_org_owner.sql`

- [ ] **Step 1: Verify the backend preflight**

Run:

```powershell
Set-Location 'D:\Desktop\new project\partner-w'
git status --short
git branch --show-current
git log -1 --oneline
rg -n "create or replace function public\.activate_license" supabase/migrations -g '*.sql'
```

Expected: only the three known unrelated untracked paths; branch `feat/p2-market-creator`; HEAD `2db2238` unless an intentional concurrent commit landed; the last function definition is migration 23. If migration number 56 now exists, stop and choose the next unused sequential number before writing.

- [ ] **Step 2: Write the failing SQL test**

Use `begin`/`rollback`, a private fixed UUID range, a temporary `_r(label text, ok boolean)` table, and a final `where ok is not true` failure count. The test must create these exact cases:

1. User U owns A and B; A has earlier `joined_at` and is primary; a card with a pre-seeded relay key is already bound to B.
2. U activates that card on a new device. Record a named assertion instead of letting the file abort; the current implementation must report `P0001 / license already bound to another organization` and make the assertion false.
3. On the fixed implementation, assert returned relay key identity, unchanged `org_id = B`, a new device row, and unchanged `tokenQuotaMicros`/`tokenUsedMicros` keys and values.
4. A B member, B admin, and unrelated owner each receive exactly `P0001 / license already bound to another organization`; assert card organization, relay key, activation rows, and available device slots did not change.
5. An unbound card binds to earliest owner A even when `is_primary` points at a member/admin team.
6. A caller with only member/admin relationships receives exactly `P0002 / no organization for user`; assert no binding, relay key, or activation side effect.

Use this exception-capture shape for every expected rejection:

```sql
v_raised := false; v_message := ''; v_state := '';
begin
  perform public.activate_license(v_key, v_device);
exception when others then
  v_raised := true;
  v_message := sqlerrm;
  v_state := sqlstate;
end;
insert into _r values (v_label, v_raised and v_state = v_expected_state and v_message = v_expected_message);
```

Close the file with:

```sql
select label, ok from _r order by label;
do $$
declare v_bad int;
begin
  select count(*) into v_bad from _r where ok is not true;
  if v_bad > 0 then raise exception '% 条断言失败', v_bad; end if;
end;
$$;
rollback;
```

- [ ] **Step 3: Prove the named RED**

Run in a shell with Docker/Supabase available:

```bash
cd "D:/Desktop/new project/partner-w"
npx supabase status
npx supabase db reset --local
docker exec -i supabase_db_supabase psql -U postgres -d postgres -v ON_ERROR_STOP=1 --quiet < scripts/tests/activate_license_multi_org.sql
```

Expected: non-zero exit because the named rightful-owner/B assertion is false, while other fixture and rejection assertions print true. SQL syntax errors, missing fixtures, or a file that aborts before the named assertion do not count as RED.

- [ ] **Step 4: Add the append-only migration**

Copy the complete migration-23 version of `public.activate_license(text,text)` so its signature, `security definer`, `set search_path = public`, device eviction/revocation behavior, relay generation, and `tokenQuotaMicros`/`tokenUsedMicros` response remain byte-for-byte equivalent. Replace only organization selection with this logic after the locked license has passed existence/status/expiry validation:

```sql
if v_license.org_id is not null then
  if not exists (
    select 1
      from public.org_members om
     where om.org_id = v_license.org_id
       and om.user_id = v_user_id
       and om.role = 'owner'
  ) then
    raise exception 'license already bound to another organization' using errcode = 'P0001';
  end if;

  v_org_id := v_license.org_id;
else
  select om.org_id into v_org_id
    from public.org_members om
   where om.user_id = v_user_id
     and om.role = 'owner'
   order by om.joined_at asc, om.org_id asc
   limit 1;

  if v_org_id is null then
    raise exception 'no organization for user' using errcode = 'P0002';
  end if;

  update public.licenses
     set org_id = v_org_id
   where id = v_license.id;
end if;
```

The license lookup must happen before this block and retain `for update`. Do not call `primary_org_id()`, accept an organization parameter, or authorize admin/member.

- [ ] **Step 5: Prove GREEN and mutation sensitivity**

Run:

```bash
npx supabase migration up --local
docker exec -i supabase_db_supabase psql -U postgres -d postgres -v ON_ERROR_STOP=1 --quiet < scripts/tests/activate_license_multi_org.sql
```

Expected: every named assertion true and exit zero.

Use repository-external temporary copies for three mutations: restore earliest-owner-first comparison, remove/weaken exact-owner validation, and replace unbound selection with `primary_org_id()`. For each mutation, assert a unique replacement anchor, prove the intended named assertion false with other assertions still passing, then restore by replaying migration 56. A syntax failure is a mutation-script failure, not a successful kill.

- [ ] **Step 6: Run backend gates and commit**

```bash
npx supabase db reset --local
bash scripts/test-db.sh
npm run test:licenses
npm run typecheck
git diff --check
git add -- supabase/migrations/20260921000056_activate_license_bound_org_owner.sql scripts/tests/activate_license_multi_org.sql
git diff --cached --check
git commit -m "fix(license): honor existing organization binding"
```

Expected: all existing license, eviction, guard, and RPC ACL tests pass; only those two files enter the commit.

---

### Task 2: Preserve a structured relay entitlement failure

**Files:**

- Modify: `packages/desktop/src/main/commercial/license.ts`
- Modify: `packages/desktop/src/main/commercial/relay-bootstrap.ts`
- Modify: `packages/desktop/src/main/commercial/relay-startup.ts`
- Modify: `packages/desktop/test/license-activate.test.ts`
- Modify: `packages/desktop/test/relay-bootstrap.test.ts`
- Create: `packages/desktop/test/relay-startup.test.ts`

- [ ] **Step 1: Add failing tests**

Add named cases proving:

- `P0001 / license already bound to another organization` becomes a permanent `license_bound_elsewhere` result;
- a permanent rejection calls `activate_license` exactly once despite the four-minute retry window;
- a thrown network/timeout failure becomes retryable `transport`;
- an RPC success without `relayKey` is deterministic `activation_failed`, never ready/generic unlicensed;
- structured logs contain SQLSTATE and safe code but no license key, relay key, or raw backend message.

Run:

```powershell
pnpm exec vitest run packages/desktop/test/license-activate.test.ts packages/desktop/test/relay-bootstrap.test.ts packages/desktop/test/relay-startup.test.ts
```

Expected: the new named tests fail for missing structured results, not fixture/import errors.

- [ ] **Step 2: Export and reuse one classifier**

Export a bounded `ActivationErrorCode` and the existing `mapActivationError()` from `license.ts`. Both manual activation and relay startup must use that one function. Do not duplicate message matching.

Define in the relay bootstrap boundary:

```ts
export type RelayKeyFetchResult =
  | { ok: true; relayKey: string }
  | {
      ok: false;
      errorCode:
        | 'license_bound_elsewhere'
        | 'license_not_found'
        | 'license_inactive'
        | 'license_expired'
        | 'activation_limit_reached'
        | 'activation_failed'
        | 'transport';
      retryable: boolean;
    };
```

Change `fetchRelayKey` to return this union. Supabase/PostgREST deterministic errors use the classifier with `retryable:false`; thrown network/timeout failures use `transport` with `retryable:true`; a successful RPC without a non-empty relay key uses `activation_failed` with `retryable:false`.

- [ ] **Step 3: Preserve the safe code through bootstrap**

Add an entitlement/retryable status and `errorCode` to `RelayBootstrapResult`. `ensureRelayConfigured()` must return permanent errors immediately, and `bootstrapRelayWithRetry()` must retry only the already-approved transient paths. Logs may contain safe code and SQLSTATE, never raw message/key/token/detail.

- [ ] **Step 4: Prove the structured-result tests are mutation-sensitive**

In repository-external temporary copies, separately restore `fetchRelayKeyForLicense(): Promise<string | null>` and make permanent entitlement failures eligible for retry. Each mutation must use a unique anchor, fail its intended named test, leave at least one other assertion passing, and then be fully reverted. A compile/import/script failure is not a successful mutation kill.

- [ ] **Step 5: Run targeted GREEN and commit**

```powershell
pnpm exec vitest run packages/desktop/test/license-activate.test.ts packages/desktop/test/relay-bootstrap.test.ts packages/desktop/test/relay-startup.test.ts
git add -- packages/desktop/src/main/commercial/license.ts packages/desktop/src/main/commercial/relay-bootstrap.ts packages/desktop/src/main/commercial/relay-startup.ts packages/desktop/test/license-activate.test.ts packages/desktop/test/relay-bootstrap.test.ts packages/desktop/test/relay-startup.test.ts
git diff --cached --check
git commit -m "fix(desktop): preserve relay entitlement failures"
```

---

### Task 3: Publish a secret-free relay bootstrap state

**Files:**

- Create: `packages/shared/src/commercial-relay-state.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/desktop/src/main/commercial/relay-startup.ts`
- Modify: `packages/desktop/src/main/ipc/commercial-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Modify: `packages/desktop/test/commercial-handlers.test.ts`
- Create: `packages/desktop/test/commercial-preload-surface.test.ts`
- Modify: `packages/desktop/test/relay-startup.test.ts`

- [ ] **Step 1: Add failing public-surface tests**

Prove initial read recovers a pre-mount failure, events contain only whitelisted fields, manual retry acknowledges without waiting for the runner, interactive login clears a stale blocked state before rerun, sign-out clears it even when cleanup throws, and preload declarations match runtime methods with unsubscribe cleanup.

Use this only public DTO:

```ts
export type RelayBootstrapPublicState =
  | { phase: 'idle' | 'running' | 'ready'; updatedAt: number }
  | {
      phase: 'blocked';
      errorCode:
        | 'license_required'
        | 'license_bound_elsewhere'
        | 'license_not_found'
        | 'license_inactive'
        | 'license_expired'
        | 'activation_limit_reached'
        | 'activation_failed';
      updatedAt: number;
    }
  | {
      phase: 'retryable-error';
      errorCode: 'auth_unavailable' | 'transport' | 'runtime_not_ready' | 'relay_apply_failed';
      updatedAt: number;
    };
```

- [ ] **Step 2: Add read/event/retry IPC**

Use these exact channels and preload names:

```text
commercial:relay-bootstrap-state
commercial:relay-bootstrap-state-changed
commercial:relay-bootstrap-retry

commercialRelayBootstrapState()
onCommercialRelayBootstrapState(callback) -> unsubscribe
commercialRelayBootstrapRetry()
```

Add `'manual'` to `RelayBootstrapReason`, but reuse the existing single-flight scheduler. Retry returns an immediate `{ok:true}` acknowledgement after scheduling. New interactive login resets to `idle` before bootstrap; sign-out resets in `finally`. Never put `detail`, raw error/message, license key, relay key, or token on this DTO.

The public-state writer must make `updatedAt` strictly monotonic (`Math.max(Date.now(), previous.updatedAt + 1)`) so renderer reconciliation cannot tie when two transitions occur in the same millisecond.

- [ ] **Step 3: Prove the IPC surface tests are mutation-sensitive**

Temporarily remove the initial read, remove the event unsubscribe, and add a forbidden `detail` field in three separate repository-external mutations. Each mutation must fail its intended named test with other assertions still passing, then be fully restored.

- [ ] **Step 4: Run targeted GREEN and commit**

```powershell
pnpm exec vitest run packages/desktop/test/commercial-handlers.test.ts packages/desktop/test/commercial-preload-surface.test.ts packages/desktop/test/relay-startup.test.ts packages/shared/test/commercial-relay-state.test.ts
git add -- packages/shared/src/commercial-relay-state.ts packages/shared/src/index.ts packages/shared/test/commercial-relay-state.test.ts packages/desktop/src/main/commercial/relay-startup.ts packages/desktop/src/main/ipc/commercial-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/test/commercial-handlers.test.ts packages/desktop/test/commercial-preload-surface.test.ts packages/desktop/test/relay-startup.test.ts
git diff --cached --check
git commit -m "feat(desktop): expose relay bootstrap readiness"
```

---

### Task 4: Replace indefinite preparation with actionable UI

**Files:**

- Modify: `packages/desktop/src/renderer/hooks/useStartupReadiness.ts`
- Modify: `packages/desktop/src/renderer/lib/startup-readiness.ts`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`
- Modify: `packages/desktop/test/startup-readiness.test.ts`
- Modify: `packages/desktop/test/startup-readiness-screen.test.tsx`
- Create: `packages/desktop/test/relay-entitlement-flow.test.tsx`

- [ ] **Step 1: Add failing renderer tests**

Add named cases proving a permanent relay error overrides `loading-models`, does not block the composer, remains visible after fake timers pass 90 seconds, renders neither spinner nor pulsing progress, opens activation settings instead of retrying, and carries the backend organization error to localized active-workspace copy. Prove retryable transport schedules commercial bootstrap before catalog refresh and that an initial read cannot overwrite a newer event.

Run:

```powershell
pnpm exec vitest run packages/desktop/test/startup-readiness.test.ts packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/test/relay-entitlement-flow.test.tsx
```

- [ ] **Step 2: Wire the hook without a read/event race**

Subscribe before issuing the initial read. Reconcile snapshots by `updatedAt` so a late read cannot overwrite a newer event. Pass public relay state into `deriveStartupReadiness()`. `blocked` and `retryable-error` take precedence over inferred model loading; retain a safe AI error code and set `composerBlocked = false` once failure is known.

On retryable errors, call `commercialRelayBootstrapRetry()` first. Refresh gateway/catalog/assistants only after the public state changes to `ready`. Do not show a retry for deterministic entitlement failures.

- [ ] **Step 3: Render the active production surface truthfully**

In `StartupReadinessPanel`, calculate status text as known error before `takingLonger`. An error uses the warning icon and static error styling, with no loader or animated/pulsing progress. For `license_required` and permanent authorization errors, expose an activation action that calls:

```ts
setSettingsSection('activation');
setSettingsOpen(true);
```

Pass the safe error state to `ChatInput`; override its inferred model-loading copy with non-preparing localized error copy. Do not rely on the currently unmounted full-screen readiness component as the acceptance surface.

- [ ] **Step 4: Add localized copy and run UI gates**

Add keys for activation required, organization authorization mismatch, generic entitlement failure, retryable relay failure, open activation, and retry to all nine locale JSON files. Chinese and English must be native; follow the repository's existing fallback policy for remaining locales. No renderer string may be hard-coded.

```powershell
pnpm exec vitest run packages/desktop/test/startup-readiness.test.ts packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/test/relay-entitlement-flow.test.tsx
pnpm check:i18n
pnpm check:renderer-copy
pnpm check:ui-contract
```

- [ ] **Step 5: Prove the UI tests are mutation-sensitive**

In separate repository-external mutations, put `takingLonger` ahead of the real error and change permanent relay failure back to `composerBlocked = true`. The 90-second visibility test and composer test must fail by name while unrelated assertions still pass. Restore the source and re-run the targeted suite green.

- [ ] **Step 6: Commit the UI slice**

```powershell
git add -- packages/desktop/src/renderer/hooks/useStartupReadiness.ts packages/desktop/src/renderer/lib/startup-readiness.ts packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/src/renderer/components/ChatInput/index.tsx packages/desktop/src/renderer/i18n/locales packages/desktop/test/startup-readiness.test.ts packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/test/relay-entitlement-flow.test.tsx
git diff --cached --check
git commit -m "fix(desktop): show actionable relay startup failures"
```

---

### Task 5: Full verification and handoff

- [ ] **Step 1: Run every desktop gate**

```powershell
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm check:architecture
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm check:udisk-delivery
pnpm exec vitest run
git diff --check
git status --short
```

Expected: all commands exit zero and the desktop worktree is clean.

- [ ] **Step 2: Re-run backend verification**

```bash
cd "D:/Desktop/new project/partner-w"
npx supabase db reset --local
bash scripts/test-db.sh
npm run test:licenses
npm run typecheck
git diff --check
git status --short
```

Expected: gates pass and only the three pre-existing unrelated untracked paths remain.

- [ ] **Step 3: Report without deploying**

Report both repository commit hashes, the exact named RED failure, GREEN results, all three mutation kills, full-gate counts, and residual risks. Stop before `supabase db push`, production migration, package build/archive, update publication, or real-account mutation. Ask separately for deployment and U-disk acceptance authorization.

### Authorized rollout and acceptance (not part of implementation authority)

After explicit authorization, deploy backend migration first, then test the existing candidate because old clients with a stored portable license key should recover immediately. Only then rebuild the desktop candidate and perform a clean-machine U-disk test: runtime ready, login, relay bootstrap, expected commercial model list, one real chat round-trip, restart idempotency, and an unauthorized account showing the permanent error beyond 90 seconds without repeated activation RPCs.
