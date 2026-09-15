# Legal Consent Enforcement Implementation Plan

**Status:** Approved and preserved, but intentionally deferred until the pre-production launch gate. Do not start this plan while the current priority is USB product core development.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a versioned, auditable 18+ terms/privacy acceptance flow that gates OTP login, activation, and Relay model access without deleting local work.

**Architecture:** Supabase owns document versions, short-lived anonymous consent tickets, immutable user acceptances, and enforcement time. Electron main owns all legal RPC calls and session rollback; the renderer only displays server metadata and submits typed acceptance intent. Relay rechecks acceptance on every key lookup so older clients cannot bypass enforcement after `enforce_at`.

**Tech Stack:** PostgreSQL/Supabase RPC and RLS, TypeScript, Electron IPC/preload, React, Vitest, Node test runner, Vite website.

---

## Repository boundaries

- Desktop repository: `D:/Desktop/new project/mofang-compass/mofang-compass-desktop`
- Backend repository: `D:/Desktop/new project/mofang-compass`
- The backend repository already contains unrelated user changes in `scripts/gen-licenses.mjs`, `mofang/`, and `open-source-agent-references/`. Never stage or modify them.
- Backend commits must name only files created or modified by the current task.

## File map

### Backend repository

- Create `supabase/migrations/20260915000034_legal_consent.sql`: tables, RLS, RPCs, grants, seed metadata, and activation enforcement.
- Create `scripts/tests/legal_consent.sql`: database behavior and ACL regression tests.
- Modify `services/relay/src/relay-key.ts`: represent legal denial separately from an invalid key.
- Modify `services/relay/src/index.ts`: load current consent with key identity and return a stable 403 error.
- Modify `services/relay/test/relay-key.test.ts`: pure legal verdict coverage.
- Create `services/relay/test/legal-consent.test.ts`: request-level denial behavior.

### Desktop repository

- Modify `packages/shared/src/types.ts`: shared legal document, ticket, acceptance, and status contracts.
- Create `packages/desktop/src/main/commercial/legal.ts`: Supabase legal RPC adapter and device hash.
- Create `packages/desktop/test/commercial-legal.test.ts`: main-process adapter tests.
- Modify `packages/desktop/src/main/commercial/auth.ts`: structured OTP request and session rollback helper.
- Modify `packages/desktop/src/main/ipc/commercial-handlers.ts`: ticket-before-SMS and acceptance-before-bootstrap orchestration.
- Modify `packages/desktop/test/commercial-handlers.test.ts`: orchestration regressions.
- Modify `packages/desktop/src/preload/index.ts` and `packages/desktop/src/preload/clawwork.d.ts`: typed IPC boundary.
- Create `packages/desktop/src/renderer/legal/current-legal-copy.ts`: bundled Chinese legal copy and version constants.
- Create `packages/desktop/src/renderer/components/LegalDocumentDialog.tsx`: in-app offline reader.
- Modify `packages/desktop/src/renderer/layouts/Login/index.tsx`: load metadata, create ticket, and submit it with OTP.
- Modify `packages/desktop/test/login-screen.test.tsx`: login legal flow tests.
- Create `packages/desktop/src/renderer/layouts/LegalConsentGate/index.tsx`: signed-in version-upgrade gate.
- Modify `packages/desktop/src/renderer/App.tsx`: legal status state machine before onboarding.
- Create `packages/desktop/test/legal-consent-gate.test.tsx`: gate UI tests.
- Modify `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`: display versions and accepted time.
- Modify `packages/desktop/src/renderer/i18n/locales/*.json`: labels and stable error copy; remove URL ownership from translations.
- Create `website/public/terms.html` and `website/public/product-privacy.html`: public Chinese legal pages.
- Modify `docs/status/2026-09-15-commercial-scale-readiness.md`: record implementation and rollout state.

## Task 1: Shared legal contracts

**Files:**

- Modify: `packages/shared/src/types.ts`
- Create: `packages/shared/test/legal-consent.test.ts`

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from 'vitest';
import type { LegalDocuments, LegalStatus } from '../src/types';

describe('legal consent contracts', () => {
  it('keeps terms and privacy as two explicit documents', () => {
    const documents: LegalDocuments = {
      terms: {
        kind: 'terms',
        version: '2026-09-15',
        url: 'https://www.rongyinghudong.com/terms.html',
        contentSha256: 'a'.repeat(64),
        minimumAge: 18,
        effectiveAt: '2026-09-15T00:00:00Z',
        enforceAt: '2026-09-20T00:00:00Z',
        changeSummary: '首次发布',
      },
      privacy: {
        kind: 'privacy',
        version: '2026-09-15',
        url: 'https://www.rongyinghudong.com/product-privacy.html',
        contentSha256: 'b'.repeat(64),
        minimumAge: 18,
        effectiveAt: '2026-09-15T00:00:00Z',
        enforceAt: '2026-09-20T00:00:00Z',
        changeSummary: '首次发布',
      },
    };
    const status: LegalStatus = { accepted: false, acceptedAt: null, documents };
    expect(status.documents.terms.kind).toBe('terms');
    expect(status.documents.privacy.kind).toBe('privacy');
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/shared test -- legal-consent.test.ts`

Expected: FAIL because `LegalDocuments` and `LegalStatus` are not exported.

- [ ] **Step 3: Add the minimal shared types**

```ts
export type LegalDocumentKind = 'terms' | 'privacy';
export interface LegalDocumentMetadata {
  kind: LegalDocumentKind;
  version: string;
  url: string;
  contentSha256: string;
  minimumAge: 18;
  effectiveAt: string;
  enforceAt: string;
  changeSummary: string;
}
export interface LegalDocuments {
  terms: LegalDocumentMetadata;
  privacy: LegalDocumentMetadata;
}
export interface LegalStatus {
  accepted: boolean;
  acceptedAt: string | null;
  documents: LegalDocuments;
}
export interface LegalAcceptanceInput {
  termsVersion: string;
  privacyVersion: string;
  minimumAgeConfirmed: 18;
}
export interface LegalConsentTicket {
  id: string;
  expiresAt: string;
}
export interface SendOtpInput {
  target: string;
  acceptance: LegalAcceptanceInput;
}
export interface VerifyOtpInput {
  target: string;
  token: string;
  consentTicketId: string;
}
```

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @clawwork/shared test -- legal-consent.test.ts`

Expected: 1 test passed.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/shared/src/types.ts packages/shared/test/legal-consent.test.ts
git commit -m "feat(legal): define consent contracts"
```

## Task 2: Supabase legal records and RPCs

**Files:**

- Create: `../supabase/migrations/20260915000034_legal_consent.sql`
- Create: `../scripts/tests/legal_consent.sql`

- [ ] **Step 1: Write failing SQL behavior tests**

Create a transaction-wrapped test that asserts table/RPC existence, anonymous table denial, an authenticated ticket consumption, idempotency, old-version rejection, and expiry rejection. Use the existing `scripts/tests/*.sql` assertion style and include these essential calls:

```sql
begin;
select set_config('request.jwt.claim.role', 'anon', true);
select public.current_legal_documents();
select public.begin_legal_acceptance('2026-09-15', '2026-09-15', 18, repeat('a', 64), '0.0.17');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select public.accept_current_legal_documents(:'ticket_id', null, null, null, null, null, 'otp-login');
select public.current_legal_status();
rollback;
```

- [ ] **Step 2: Run and confirm RED**

Run from backend repository: `bash scripts/test-db.sh`

Expected: `legal_consent.sql` FAILS because the tables and RPCs do not exist.

- [ ] **Step 3: Implement schema and RPCs**

The migration must create:

```sql
create table public.legal_document_versions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms', 'privacy')),
  version text not null check (btrim(version) <> ''),
  effective_at timestamptz not null,
  enforce_at timestamptz not null check (enforce_at >= effective_at),
  document_url text not null check (document_url like 'https://%'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  minimum_age integer not null default 18 check (minimum_age = 18),
  change_summary text not null check (btrim(change_summary) <> ''),
  created_at timestamptz not null default now(),
  unique (kind, version),
  unique (kind, effective_at)
);
create table public.legal_acceptance_attempts (
  id uuid primary key default gen_random_uuid(),
  terms_version text not null,
  privacy_version text not null,
  minimum_age_confirmed integer not null check (minimum_age_confirmed = 18),
  device_fingerprint_hash text not null check (device_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  app_version text not null check (btrim(app_version) <> ''),
  source text not null default 'otp-login' check (source = 'otp-login'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  consumed_at timestamptz
);
create table public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now(),
  minimum_age_confirmed integer not null check (minimum_age_confirmed = 18),
  device_fingerprint_hash text not null check (device_fingerprint_hash ~ '^[0-9a-f]{64}$'),
  app_version text not null check (btrim(app_version) <> ''),
  source text not null check (source in ('otp-login', 'version-upgrade')),
  unique (user_id, terms_version, privacy_version)
);
alter table public.legal_document_versions enable row level security;
alter table public.legal_acceptance_attempts enable row level security;
alter table public.legal_acceptances enable row level security;
```

Implement `current_legal_documents`, `begin_legal_acceptance`, `current_legal_status`, and `accept_current_legal_documents` as `SECURITY DEFINER` functions with `set search_path = public, extensions`. Revoke all table writes from `anon`/`authenticated`, grant only the named functions, and use `auth.uid()` plus database `now()` rather than client identity/time.

Seed one terms and one privacy row using the two production URLs. Set `effective_at` to migration time and `enforce_at` to `2026-09-30T00:00:00+08:00`, giving time to publish the compatible client. Store the exact page hashes calculated in Task 8 before production deployment; local development uses those same committed hashes.

- [ ] **Step 4: Add activation enforcement**

At the beginning of the latest `activate_license` body, add a call equivalent to:

```sql
if public.legal_enforcement_active() and not public.has_current_legal_acceptance(v_user_id) then
  raise exception 'legal acceptance required' using errcode = 'P0001';
end if;
```

Keep the current account-bound activation and Relay key behavior unchanged after this guard.

- [ ] **Step 5: Run database tests and ACL snapshot**

Run: `bash scripts/test-db.sh`

Expected: all SQL files PASS. Then run the repository ACL behavior check and verify anonymous users cannot select either private table.

- [ ] **Step 6: Commit only legal backend files**

```powershell
git -C .. add -- supabase/migrations/20260915000034_legal_consent.sql scripts/tests/legal_consent.sql
git -C .. commit -m "feat(legal): persist versioned user consent"
```

## Task 3: Electron legal RPC adapter

**Files:**

- Create: `packages/desktop/src/main/commercial/legal.ts`
- Create: `packages/desktop/test/commercial-legal.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Test `readLegalDocuments`, `readLegalStatus`, `beginLegalAcceptance`, and `acceptLegalDocuments`. Assert snake_case RPC data becomes shared camelCase types, invalid/missing rows fail closed, and the raw device fingerprint never leaves the module.

```ts
expect(client.rpc).toHaveBeenCalledWith(
  'begin_legal_acceptance',
  expect.objectContaining({
    p_device_fingerprint_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    p_minimum_age_confirmed: 18,
  }),
);
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop test -- commercial-legal.test.ts`

Expected: FAIL because `commercial/legal.ts` does not exist.

- [ ] **Step 3: Implement the adapter**

Use `getCommercialClient()`, `deviceFingerprint()`, `createHash('sha256')`, and `app.getVersion()`. Return `IpcResult` with stable codes: `legal_documents_unavailable`, `legal_ticket_failed`, `legal_status_unavailable`, `legal_acceptance_failed`, and `legal_acceptance_required`. Do not log document bodies, tickets, raw device IDs, or Supabase tokens.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @clawwork/desktop test -- commercial-legal.test.ts`

Expected: all adapter tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/main/commercial/legal.ts packages/desktop/test/commercial-legal.test.ts
git commit -m "feat(legal): add commercial consent adapter"
```

## Task 4: OTP and IPC orchestration

**Files:**

- Modify: `packages/desktop/src/main/commercial/auth.ts`
- Modify: `packages/desktop/src/main/ipc/commercial-handlers.ts`
- Modify: `packages/desktop/test/commercial-handlers.test.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`

- [ ] **Step 1: Add failing orchestration tests**

Cover this strict order:

```ts
expect(mocks.beginLegalAcceptance.mock.invocationCallOrder[0]).toBeLessThan(
  mocks.sendLoginOtp.mock.invocationCallOrder[0],
);
expect(mocks.acceptLegalDocuments.mock.invocationCallOrder[0]).toBeLessThan(
  mocks.requestCommercialAccessCleanup.mock.invocationCallOrder[0],
);
```

Also assert ticket failure skips SMS; acceptance failure calls `signOutCommercial`, skips cleanup/bootstrap, and returns `legal_acceptance_failed`.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop test -- commercial-handlers.test.ts`

Expected: FAIL because the current IPC accepts positional strings and has no legal adapter.

- [ ] **Step 3: Implement structured handlers**

`commercial:send-otp` accepts `SendOtpInput`, begins consent first, then calls OTP and returns `{ target, channel, consentTicket }`. `commercial:verify-otp` accepts `VerifyOtpInput`, verifies OTP, consumes the ticket, signs out on acceptance failure, and only then performs account cleanup plus `notifyCommercialSignedIn()`.

Register `commercial:legal-documents`, `commercial:legal-status`, and `commercial:legal-accept`. Update preload methods and declarations to use shared types.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @clawwork/desktop test -- commercial-handlers.test.ts commercial-legal.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/main/commercial/auth.ts packages/desktop/src/main/ipc/commercial-handlers.ts packages/desktop/test/commercial-handlers.test.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts
git commit -m "feat(auth): bind legal consent to otp login"
```

## Task 5: Login legal experience and offline copy

**Files:**

- Create: `packages/desktop/src/renderer/legal/current-legal-copy.ts`
- Create: `packages/desktop/src/renderer/components/LegalDocumentDialog.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Login/index.tsx`
- Modify: `packages/desktop/test/login-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] **Step 1: Write failing UI tests**

Test loading/failed/retry metadata states, separate URLs, unchecked blocking, ticket creation before SMS, ticket reuse during resend, ticket submission during verify, and in-app copy opening.

```ts
expect(sendOtp).toHaveBeenCalledWith({
  target: '+8613800138000',
  acceptance: { termsVersion: '2026-09-15', privacyVersion: '2026-09-15', minimumAgeConfirmed: 18 },
});
expect(verifyOtp).toHaveBeenCalledWith({ target: '+8613800138000', token: '123456', consentTicketId: 'ticket-1' });
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop test -- login-screen.test.tsx`

Expected: FAIL on the new structured calls and legal document UI.

- [ ] **Step 3: Implement minimal UI**

Load server metadata on mount. Disable send until metadata is ready, phone is valid, and the 18+ checkbox is checked. Replace translated URLs with metadata URLs. Store the returned ticket and expiry. Add a retry button for metadata failure and `LegalDocumentDialog` for the bundled Chinese copy. Keep the existing light layout and mascot behavior.

- [ ] **Step 4: Run UI, i18n, and type checks**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- login-screen.test.tsx
pnpm check:i18n
pnpm typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/renderer/legal/current-legal-copy.ts packages/desktop/src/renderer/components/LegalDocumentDialog.tsx packages/desktop/src/renderer/layouts/Login/index.tsx packages/desktop/test/login-screen.test.tsx packages/desktop/src/renderer/i18n/locales
git commit -m "feat(login): require versioned legal consent"
```

## Task 6: Signed-in upgrade gate and account display

**Files:**

- Create: `packages/desktop/src/renderer/layouts/LegalConsentGate/index.tsx`
- Create: `packages/desktop/test/legal-consent-gate.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`
- Modify: `packages/desktop/test/settings-ui-regressions.test.tsx`

- [ ] **Step 1: Write failing gate tests**

Assert existing accepted users proceed, outdated users see the update gate before onboarding, acceptance restores the original workspace, refusal offers sign-out, and network failure offers retry without deleting tasks.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop test -- legal-consent-gate.test.tsx settings-ui-regressions.test.tsx`

Expected: FAIL because the gate and account legal rows do not exist.

- [ ] **Step 3: Implement the state machine**

Add `legalState: 'checking' | 'required' | 'ok' | 'offline'` after authenticated session resolution and before onboarding. Render `LegalConsentGate` for required/offline states. On success set `legalState` to `ok`; on sign-out reload through the existing auth gate. Add account rows for terms version, privacy version, accepted time, and document links.

- [ ] **Step 4: Run and confirm GREEN**

Run: `pnpm --filter @clawwork/desktop test -- legal-consent-gate.test.tsx settings-ui-regressions.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/renderer/layouts/LegalConsentGate/index.tsx packages/desktop/test/legal-consent-gate.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx packages/desktop/test/settings-ui-regressions.test.tsx
git commit -m "feat(legal): gate outdated signed-in sessions"
```

## Task 7: Relay enforcement

**Files:**

- Modify: `../services/relay/src/relay-key.ts`
- Modify: `../services/relay/src/index.ts`
- Modify: `../services/relay/test/relay-key.test.ts`
- Create: `../services/relay/test/legal-consent.test.ts`

- [ ] **Step 1: Write failing Relay tests**

Represent lookup as a discriminated result:

```ts
type RelayKeyResolution =
  | { ok: true; identity: ResolvedRelayKey }
  | { ok: false; reason: 'invalid_key' | 'legal_acceptance_required' };
```

Assert legal denial returns HTTP 403 with `{ error: { code: 'legal_acceptance_required' } }`, while invalid keys remain 401. Assert upstream fetch and billing RPC are not called on denial.

- [ ] **Step 2: Run and confirm RED**

Run from `../services/relay`: `npm test -- --test-name-pattern="legal acceptance"`

Expected: FAIL because lookup currently collapses every denial to `null`.

- [ ] **Step 3: Implement lookup enforcement**

After resolving the billing user, call the service-role RPC `has_current_legal_acceptance(userId)`. Return `legal_acceptance_required` only when enforcement is active and the user lacks current acceptance. Keep quota evaluation after legal acceptance so legal and balance errors remain distinct.

- [ ] **Step 4: Run Relay verification**

Run:

```powershell
npm --prefix ../services/relay test
npm --prefix ../services/relay run typecheck
```

Expected: all Relay tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit only Relay files**

```powershell
git -C .. add -- services/relay/src/relay-key.ts services/relay/src/index.ts services/relay/test/relay-key.test.ts services/relay/test/legal-consent.test.ts
git -C .. commit -m "feat(relay): enforce current legal consent"
```

## Task 8: Public legal pages

**Files:**

- Create: `website/public/terms.html`
- Create: `website/public/product-privacy.html`
- Create: `website/src/legal-pages.test.ts`
- Modify: `website/package.json`

- [ ] **Step 1: Write failing static page test**

Read both files and assert each contains the operator, version, effective date, contact information, unique title, and no placeholder markers. Assert privacy names SMS, Supabase, payment, model processing, prompts, user-selected files, storage, and cross-border disclosure.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/website test`

Before running, add `"test": "vitest run"` to `website/package.json` scripts and `"vitest": "^3.2.7"` to its dev dependencies. Expected: FAIL because the public pages do not exist.

- [ ] **Step 3: Create the two accessible pages**

Use standalone semantic HTML with the existing warm light palette, responsive reading width, a table of contents, print styles, version `2026-09-15`, operator “深圳市荣盈互动科技有限公司”, `contact@royin.net`, `400-989-7768`, and the existing Shenzhen address. Include every minimum section from design §4.2. Do not claim end-to-end encryption or mainland-only storage while hosted Supabase remains in use.

- [ ] **Step 4: Calculate and align hashes**

Calculate SHA-256 for both final HTML files, update the migration seed and bundled copy constants with those exact hashes, then rerun database, website, and Desktop focused tests.

- [ ] **Step 5: Build website and commit**

Run: `pnpm --filter @clawwork/website build`

Expected: build exits 0 and output includes `terms.html` and `product-privacy.html`.

```powershell
git add -- website/public/terms.html website/public/product-privacy.html website/src/legal-pages.test.ts website/package.json
git commit -m "feat(legal): publish product terms and privacy pages"
```

Amend the backend migration commit only if it has not been deployed; otherwise create a new migration that updates hashes. Never rewrite a deployed migration.

## Task 9: Full verification, rollout record, and packaging gate

**Files:**

- Modify: `docs/status/2026-09-15-commercial-scale-readiness.md`
- Modify: `docs/status/2026-09-15-basic-demo-progress.md`

- [ ] **Step 1: Run backend verification**

From backend repository run database tests with local Supabase, Relay tests, Relay typecheck, SMS tests, and payment tests. Expected: every command exits 0.

- [ ] **Step 2: Run Desktop repository verification**

```powershell
pnpm check:architecture
pnpm check:i18n
pnpm typecheck
pnpm typecheck:tests
pnpm test
pnpm build
```

Expected: all exit 0; Desktop remains 920 or more passing tests and total test count increases with the new suites.

- [ ] **Step 3: Perform local behavior rehearsal**

Exercise: metadata failure/retry, unchecked block, new OTP ticket, successful acceptance, failed acceptance rollback, existing accepted login, version-upgrade gate, sign-out, activation denial, Relay denial, and accepted Relay success. Confirm no test requires production credentials.

- [ ] **Step 4: Update status memory**

Record exact test counts, database migration version, document versions/hashes, enforcement date, commit IDs, deployment status, and remaining legal-review/package tasks. Do not mark production enforcement complete before the migration and pages are actually deployed.

- [ ] **Step 5: Commit status docs**

```powershell
git add -- docs/status/2026-09-15-commercial-scale-readiness.md docs/status/2026-09-15-basic-demo-progress.md
git commit -m "docs(legal): record consent rollout readiness"
```

## Execution checkpoints

- Checkpoint A after Tasks 1–4: database and main-process flow is testable without UI.
- Checkpoint B after Tasks 5–6: complete Desktop experience works against local Supabase.
- Checkpoint C after Tasks 7–8: server enforcement and public pages are aligned.
- Checkpoint D after Task 9: ready for deployment review; production remains off until explicit deployment authorization.
