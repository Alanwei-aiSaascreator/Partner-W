# Demo main path — real activation rehearsal (E2E design)

- **Date**: 2026-09-14
- **Branch**: `feat/demo-main-path`
- **Status**: approved, not yet implemented

## Why this exists

Every packaged E2E so far provisions the commercial identity **out of band**:
`provisionProfile()` writes `commercial.licenseKey` straight into
`clawwork-config.json`. The app therefore starts already-licensed, and the whole
activation chain is never exercised:

```
ActivationSection.submit()
  → IPC commercial:license-activate
  → activateLicense()
      → RPC activate_license
      → configureRelay(relayKey)
          → applyRelayConfig() → gateway config.patch + read-back verify
```

`license.ts:196` is the load-bearing detail: the activation path **does not**
call `notifyCommercialSignedIn()`. If `configureRelay()` fails silently — the
one observed failure mode is `relay.config-no-gateway` when no gateway client
is connected — the user sees "activation succeeded" with zero models, and only
a client restart recovers (the startup bootstrap would then find the licence).
That is precisely the failure this rehearsal exists to rule out.

This is the only link on the demo main path that has never been verified
end to end.

## Goal

One packaged-mode Playwright spec that walks the demo main path through **real
UI only**:

```
fresh isolated profile (commercial configured, no session, no licence key)
  → packaged App deploys runtime + spawns the gateway itself
  → Login page: phone → agree → "获取验证码" → OTP → "登录"
  → Left nav "应用设置" → settings tab "激活授权"
  → type the real licence key → click "激活"
  → UI reaches the bound state ("已绑定授权 / 当前账户已绑定 <sku>")
  → models.list returns ≥1 real model (provider === 'clawrouter'), no restart
  → new task → send one real message → real reply lands
  → that assistant message carries real model provenance
```

### Non-goals

Explicitly out of scope (user decision, 2026-09-14):

- invalid-licence-key negative control
- USB `license.key` auto-discovery (Stage 3A)
- logout teardown / slow-forward / other standing debt
- UI polish
- re-opening Stage 2C
- switching models mid-session (that is `provenance-live.spec.ts`)

## Prerequisites (owner-run, not the agent)

1. Mint one card:

   ```bash
   cd "D:/Desktop/new project/mofang-compass"
   node scripts/gen-licenses.mjs --count 1 --sku "USB-标准版" --quota-points 5000 --max-activations 1
   ```

2. Put that key into the local dev profile:
   `%APPDATA%\@clawwork\desktop\clawwork-config.json` →
   `commercial.testLicenseKey = "<key>"`.

   `commercial.testPhone` / `commercial.testOtp` are already present on this
   machine (presence verified; values never read into the repo).

The agent never reads `SUPABASE_SERVICE_ROLE_KEY`, and never prints the licence
key, phone number, OTP, token or session.

## Server-side semantics (verified against the RPC, not assumed)

From `supabase/migrations/20260912000023_billing_micros.sql:778` (`activate_license`):

- requires `auth.uid()`; requires the caller to own an org (`role='owner'`)
- an unbound licence (`org_id is null`) is **auto-bound to the activator's org**
- an already-bound licence belonging to another org raises
  `license already bound to another organization`
- the call is **idempotent for a known device fingerprint** (updates
  `last_seen_at`, does not consume an activation slot)
- `relay_key` is generated once and then fixed

From `supabase/migrations/20260910000001_init.sql:430` (`handle_new_user`): every
new user gets a personal org with `role='owner'`. A brand-new phone number
signing in for the first time therefore satisfies the owner requirement with no
manual setup. `sendLoginOtp()` calls `signInWithOtp({ phone })` without
`shouldCreateUser: false`, so a new number really does sign up.

**Consequence for the owner**: the first run permanently binds the card to the
test phone account's personal org. Later runs are idempotent. Never use a real
customer card for this.

## Changes

### 1. `e2e/packaged/provision.ts` (small edit, three spots)

- `CommercialProvision` gains `testLicenseKey?: string`, documented with the same
  discipline note as `testPhone`/`testOtp` (local profile only, never in the
  repo, absence ⇒ skip).
- `readDevProvision()` reads it; it stays optional so existing specs are
  unaffected.
- `ProvisionOptions` gains `withoutLicenseKey?: boolean`; when set,
  `provisionProfile()` omits `commercial.licenseKey` from the written config.

The third point is the one that makes the spec meaningful. `provisionProfile()`
currently **always** writes `commercial.licenseKey`, and the dev profile's value
is the owner's real card. Leaving it in means the app boots already-licensed,
`ActivationSection` renders its bound state instead of the form, and the test
would no longer be testing activation at all.

**Boundary, stated explicitly.** `supabaseUrl`, `supabaseAnonKey`,
`workspacePath` and `deviceId` are still provisioned. Provisioning the first two
is the product's own out-of-band setup, not a bypass — and as of 2026-09-18 they
are also the **shipped defaults** (`packages/shared/src/commercial-defaults.ts`,
resolved at read time), so a provisioned profile no longer has to carry them at
all; the `commercial:set-config` IPC still has no UI caller. The single field
being withheld is `licenseKey`, i.e. the one thing that could substitute for
activation. (Note the flip side: because every packaged spec provisions a
profile, none of them can see the "clean machine" path — see
`packages/desktop/test/commercial-config-defaults.test.ts` for the coverage of that.)

`deviceId` stays shared with the dev profile (existing behaviour) so the
fingerprint is stable: re-runs hit the idempotent branch instead of churning
activation rows.

### 2. `e2e/packaged/demo-main-path.spec.ts` (new file)

Reuses `harness.ts` (`freshTrackedProfile`, `launchApp`, `waitForGateway`,
`connect`, `readModels`, `waitForRelayModels`, `gatewayPid`, `portHasGateway`,
`stopEverything`, `markFailure`, `cleanupProfiles`) and `provision.ts`, plus
`sweepStaleProfiles` from `e2e/helpers/temp-root.ts`. The `queryDb` sqlite helper
is copied from `provenance-live.spec.ts:51`.

#### Selectors (all verified against source, none guessed)

| Target             | Locator                                                                                                   | Source                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| phone input        | `input[type=tel]` (placeholder `手机号`)                                                                  | `Login/index.tsx:198`                                          |
| agreement checkbox | `input[type=checkbox]` — **submit stays disabled until checked**                                          | `Login/index.tsx:236,252`                                      |
| send code          | `getByRole('button', { name: '获取验证码' })`                                                             | `zh.json` `login.sendCode`                                     |
| OTP input          | `input[placeholder="验证码"]` (appears in phase `code`)                                                   | `Login/index.tsx:215`                                          |
| sign in            | `getByRole('button', { name: '登录' })`                                                                   | `zh.json` `login.signIn`                                       |
| open settings      | `button[aria-label="应用设置"]`                                                                           | `LeftNav/index.tsx:477`, `zh.json` `leftNav.appSettings`       |
| activation tab     | `getByRole('button', { name: '激活授权' })` — **Settings defaults to `general`**, the tab must be clicked | `Settings/index.tsx:27`, `SettingsNav.tsx:10`                  |
| licence input      | `getByPlaceholder('授权码')`                                                                              | `ActivationSection.tsx:81`, `zh.json` `activation.placeholder` |
| activate           | `getByRole('button', { name: '激活' })`                                                                   | `ActivationSection.tsx:90`, `zh.json` `activation.submit`      |
| bound state        | text `已绑定授权` / `当前账户已绑定`                                                                      | `ActivationSection.tsx:59-62`                                  |

#### Assertion matrix

| #   | Requirement                                     | How it is proven                                                                                                                                                  |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OTP login is the real UI flow                   | only `page.fill` / `page.click`; the spec never calls the `commercialSendOtp` / `commercialVerifyOtp` IPC                                                         |
| 2   | Licence goes through the real form              | `getByPlaceholder('授权码')` + real "激活" click                                                                                                                  |
| 3   | No internal helper                              | the spec contains no `activateLicense` / `commercialLicenseActivate` reference                                                                                    |
| 4   | No direct local config write                    | assert `clawwork-config.json` has **no** `licenseKey` before activation, and **has** it after; both writes are the product's                                      |
| 5   | No direct clawrouter config                     | the spec never writes gateway config; it only _reads_ `openclaw-state/openclaw.json` as corroboration (same assertion as `commercial-activation.spec.ts:273-279`) |
| 6   | Models appear after activation, without restart | `readModels().relay.length === 0` before; `waitForRelayModels(page, 1, 240_000)` after                                                                            |
| 7   | App PID unchanged                               | recorded before login, compared at the end                                                                                                                        |
| 8   | Gateway PID unchanged                           | `gatewayPid()` (port-based, not name-based), same before/after                                                                                                    |
| 9   | Real round trip                                 | gateway `listSessions`: target session `status === 'done'` **and** `outputTokens > 0`                                                                             |
| 10  | Real model provenance                           | three independent sources agree: gateway `session.model` ↔ `data-testid="model-badge"` `title` ↔ sqlite `messages.model`                                          |

Two ordering details that are easy to get wrong, both already documented:

- **The task row does not exist until the first message is sent.** Clicking
  "新任务" only opens a UI pane; `loadTasks()` returns `{ rows: [] }` until the
  send actually happens. The task id and `sessionKey` must therefore be read
  _after_ the send, by polling — same as `provenance-live.spec.ts:160-175`.
- **The three model values are not textually identical.** The gateway records
  `clawrouter/<catalogue id>`; the badge `title` and the sqlite `model` column
  both hold the bare catalogue id. The gateway value is compared after stripping
  the `<provider>/` prefix. The badge _text_ is the display name and may differ
  from the id, so `title` — not the visible label — is the source of truth.

The activation-success assertion deliberately targets the **bound state**
(`已绑定授权` / `当前账户已绑定 <sku>`), not the transient success toast. The
bound state only renders once `commercialAccountOverview` has read the binding
back from the server, which makes it a much stronger signal than a toast.

#### Supporting evidence (recorded on success, used on failure)

- profile ndjson must contain **no** `relay.config-no-gateway`,
  `relay.config-write-failed` or `relay.config-write-done { verified: false }`
- the profile's `openclaw-state/openclaw.json` has a `clawrouter` provider whose
  `baseUrl` contains `/relay`

## Failure triage

If the RPC succeeds but models stay at 0, **do not restart the app to work
around it**. Read the profile's ndjson and report the root cause, classified by:

- `relay.config-no-gateway` — no connected gateway client at activation time
- `relay.config-write-failed` — its `kind` (`transport` / `rejected` / `hash-conflict`)
- `relay.config-write-done` with `verified: false` — read-back verification failed

Login failures report the `errorCode` only (`otp_rate_limited`, `otp_hook_failed`,
`otp_send_failed`, …).

## Discipline

- **Never print**: the full licence key (at most `slice(0, 3) + '…'`, the shape
  `describeProvision()` already uses), phone numbers (use `maskPhone()`), OTP,
  tokens, session JSON.
- Isolation: fresh tracked profile; a **run-exclusive** workspace
  (`e2e-artifacts/e2e-workspace-demo-<pid>-<ts>`), never the shared one.
- Port 18789 must be free before the run; teardown by PID, never by name.
- Profiles are kept on failure (evidence) and removed on success, always
  junction-safe via `cleanupProfiles()`.
- **No product code changes.** If the rehearsal exposes a product bug, report it
  and stop — do not fix it inside this branch.
- Run: `pnpm test:e2e:packaged demo-main-path`
- Estimated duration: 10–15 minutes per run (runtime first-deploy dominates,
  same order as the existing packaged specs).

## Acceptance criteria

The spec passes when run alone. The **only** legitimate skip reason is a missing
`commercial.testLicenseKey` in the dev profile, and that skip must print an
explicit reason to stdout — following `late-login.spec.ts:219-233` — so that a
skip can never be misread as a pass.

## Open risks

- The bound-state assertion depends on `commercialAccountOverview` succeeding. If
  that read proves flaky, the fallback is to assert on the
  `commercialLicenseStatus` IPC result instead; the toast is not a substitute.
- The test phone account may already exist. That is fine (the login branch is
  taken rather than the signup branch) but it means the personal org may already
  hold another licence; `org_active_license` is `distinct on (org_id)` ordered by
  remaining quota, and this design never depends on that view.
