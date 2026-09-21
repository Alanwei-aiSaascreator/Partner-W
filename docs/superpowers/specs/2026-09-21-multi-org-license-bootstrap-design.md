# Multi-organization license bootstrap recovery

**Date:** 2026-09-21
**Status:** Direction approved; peer-reviewed written design awaiting confirmation
**Scope:** `mofang-compass-backend` authorization RPC and `mofang-compass-desktop` startup error reporting

## Problem

A fresh 0.0.25 portable profile on a second computer completed runtime deployment, gateway startup, and interactive login, but never received commercial models. The captured run proved the following sequence:

- runtime deployment completed in 35 seconds;
- the local gateway was ready in 45 seconds;
- authentication succeeded;
- one second later, `activate_license` returned `P0001: license already bound to another organization`;
- relay bootstrap received no relay key and returned `unlicensed`, while the renderer continued to present model preparation.

The account belongs to more than one organization. The current database function chooses the caller's earliest owner organization before it reads the license. A license already bound to another organization owned by the same caller is therefore rejected even though the card, account, and device are legitimate.

This is a release blocker for a portable product: an old computer may keep working because its gateway already has relay configuration, while a new computer must request the relay key again and hits the stale organization-selection rule.

## Goals

1. A license already bound to an organization can be reused on a new device when the signed-in user owns that exact organization.
2. The function must never move an already-bound license between organizations.
3. An unrelated user or a non-owner team member must not obtain the relay key.
4. Existing unbound-card activation remains backward-compatible and deterministic.
5. Permanent entitlement failures become an explicit startup error instead of an indefinite preparation state.
6. Relay keys, license keys, and access tokens never enter logs or renderer IPC. Raw backend error objects and messages
   never enter renderer IPC; main-process diagnostics retain only a redacted message when it is needed for support.
7. Existing desktop clients that already have the portable license key benefit from the backend correction without
   requiring a new binary.

## Non-goals

- Do not couple billing to the community panel's currently selected team.
- Do not let the client choose or submit a target organization.
- Do not change quota accounting, device eviction, relay-key rotation, or activation limits.
- Do not rebind production license rows as a workaround.
- Do not redesign account-wide license discovery when a profile has no stored license key. The captured portable profile
  has its 14-character key, and that observed path is the release blocker. A no-key profile must fail truthfully and
  direct the user to activation rather than spin forever.
- Do not deploy the migration or publish an update feed as part of implementation; rollout remains a separate authorized operation.

## Considered approaches

### A. Correct the existing RPC and add truthful client failure state — selected

The bound card is the source of truth. The RPC reads and locks the license first. If it is already bound, it validates that the caller is an owner of that exact organization and keeps the binding unchanged. If it is unbound, it uses the existing deterministic owner selection and binds once.

This fixes the observed path in old and new clients when the portable profile already holds its license key, preserves
server-side authority, and requires no client-supplied organization identifier.

### B. Add an organization parameter or a new organization-specific RPC

This makes the choice explicit but expands the authorization surface, requires coordinated client and server rollout, and leaves shipped clients broken. It is unnecessary for the observed failure.

### C. Manually rebind the affected license

This can make one account work but changes ownership data and leaves every other multi-organization account vulnerable. It is an operational workaround, not a product fix.

## Backend design

Add an append-only migration after the current migration sequence. The implementation baseline is the **final effective**
function in `20260912000023_billing_micros.sql`, not the earlier migration 11 definition. It replaces
`public.activate_license(text, text)` while preserving its signature, ACL, micro-unit return fields, device-registration
behavior, activation eviction, and relay-key generation.

The transaction order is:

1. Require an authenticated user and a non-empty device fingerprint.
2. Select the license by key `for update`.
3. Validate existence, active status, and expiry.
4. If `license.org_id` is non-null:
   - require an `org_members` row for the caller, that organization, and role `owner`;
   - use `license.org_id` as `v_org_id`;
   - never update `licenses.org_id`.
5. If `license.org_id` is null:
   - select the caller's earliest owner organization with the existing `joined_at asc, org_id asc` rule;
   - bind the license to that organization exactly once.
6. Run the unchanged device activation/eviction logic.
7. Generate or return the unchanged per-license relay key.

The role remains `owner`, not any organization member. The community-team design explicitly kept financial assets and relay credentials owner-only. Allowing a member to read a shared spending credential is a separate product and security decision.

The rejection for a bound card whose caller is not its owner remains the existing
`P0001 / license already bound to another organization`. Keeping that stable avoids revealing membership details and
preserves the shipped client's `license_bound_elsewhere` mapping. The function must not use `primary_org_id()`:
the current-team selector admits member/admin relationships, while billing ownership deliberately does not follow the
currently selected community team.

The migration must not accept `org_id` from the caller. It must not return whether an arbitrary organization exists. Rejection uses stable server messages that the desktop maps to safe error codes.

## Desktop design

### Structured result

`fetchRelayKeyForLicense` will stop collapsing every RPC failure into `null`. It will return a discriminated result
containing either a relay key or a safe failure code plus retryability. The existing activation-error classifier in
`license.ts` becomes the single exported mapper used by both manual activation and bootstrap; bootstrap must not add a
second string-matching table. Raw Supabase messages remain in main-process diagnostics only after secret redaction;
the renderer receives only a bounded code.

Permanent codes include:

- `license_bound_elsewhere`;
- `license_not_found`;
- `license_inactive`;
- `license_expired`;
- `activation_failed` when the server returned a deterministic rejection.

The public state also uses `license_required` when no stored key exists. That is a client state, not a server error; it
must lead to activation guidance rather than model-preparation animation.

Thrown network/time-out failures map to a separate retryable transport result and are not mislabeled as entitlement
denial. A missing stored license key remains `unlicensed`; it is not silently converted into an organization conflict.

`RelayBootstrapResult` will distinguish permanent entitlement failure from ordinary `unlicensed`, authentication
delay, runtime-not-ready, and retryable transport states. A deterministic entitlement result is terminal for that run:
the four-minute gateway/auth retry loop must not call `activate_license` repeatedly.

The public-state mapping is fixed rather than inferred in the renderer:

| Bootstrap result                                            | Public state                         |
| ----------------------------------------------------------- | ------------------------------------ |
| `applied` / `already-applied`                               | `ready`                              |
| `unlicensed`                                                | `blocked: license_required`          |
| deterministic activation rejection                          | `blocked: <safe activation code>`    |
| exhausted auth, network, runtime, or gateway transport path | `retryable-error: <safe error code>` |

### Renderer visibility

The main process keeps the latest secret-free relay bootstrap public state and exposes both an initial IPC read and a
change notification through preload. The query prevents the renderer from missing a result emitted before it mounted;
the event covers asynchronous startup, login, activation, and manual retry runs. The payload contains only a bounded
phase (`idle`, `running`, `ready`, `blocked`, or `retryable-error`), a whitelisted error code, and a timestamp.

Preload also exposes a manual relay-bootstrap request. It only schedules the existing single-flight runner and returns
an acknowledgement; renderer progress follows the public state event, so an IPC request is not held open for the
runner's full retry window. Signing out clears the snapshot. A new interactive login clears an old account's blocked
state before it schedules bootstrap.

`useStartupReadiness` consumes that state:

- `ready` continues to rely on the real model catalog;
- `preparing` preserves the existing bounded loading behavior;
- a permanent entitlement failure immediately maps AI readiness to `error`;
- a retryable transport failure offers retry; retry schedules commercial bootstrap first and refreshes the model
  catalog after relay state becomes ready;
- `license_bound_elsewhere` offers account/activation guidance rather than a normal retry button that cannot change the
  result;
- sign-out or a new login resets stale state before another bootstrap begins.

The production surface is `MainArea/StartupReadinessPanel.tsx` plus the chat input state; the currently unmounted
full-screen readiness component is not accepted as proof. Errors take precedence over the panel's 90-second
`takingLonger` message, the progress bar stops implying active work, and the composer is no longer blocked by a known
permanent failure. Localized text explains that the signed-in account cannot use this activation and directs the user
to account/activation settings. No raw SQL or English backend message is shown.

## State flow

```text
interactive login
  -> clear stale relay access
  -> relay bootstrap starts (public state: running)
  -> read stored portable license key (missing -> blocked + license_required)
  -> activate_license
       bound card + caller owns bound org -> return relay key
       bound card + caller does not own org -> blocked + license_bound_elsewhere
       transport failure -> retryable-error
  -> apply and verify gateway relay config
  -> refresh model catalog
  -> public state: ready
```

## Testing

### SQL red-green tests

Add a multi-organization case to the backend SQL test suite:

1. one user owns organizations A and B, with A earlier and/or selected as primary;
2. a license already bound to B activates on a new device, returns the existing relay key, leaves `org_id = B`, and
   records the device;
3. a B member, a B admin, and an unrelated owner each fail with the stable code/message while leaving organization,
   relay-key, activation, and device-slot state unchanged;
4. an unbound license still binds to the existing deterministic earliest **owner** organization even when the user's
   primary team is a member/admin relationship or another owned team;
5. a caller with only member/admin relationships gets `no organization for user` and the card remains unbound;
6. the final result keeps the micro-unit quota fields and existing relay-key behavior from migration 23;
7. the existing RPC ACL guard still proves anon cannot execute while authenticated/service-role grants remain intact.

The test must fail against the current migration with `license already bound to another organization` before the new
migration is added. A mutation restoring the old "choose owner first" ordering must make the named regression fail. A
mutation removing or weakening the bound-organization owner check must make the member/admin security tests fail. A
mutation replacing earliest-owner selection with bare `primary_org_id()` must make the unbound-card tests fail. Each
mutation script self-checks that its anchor is unique and that at least one named assertion actually ran.

### Desktop red-green tests

- Relay bootstrap preserves and exposes `license_bound_elsewhere` rather than returning generic `unlicensed`.
- Retryable auth/network failures are not converted to permanent entitlement errors.
- Preload never exposes a key or raw backend message.
- Startup readiness changes from loading to error on a permanent relay failure.
- A new login clears the previous account's permanent error before bootstrap.
- Initial IPC read recovers an error emitted before renderer mount; the change event carries login/activation results.
- Manual retry invokes commercial bootstrap rather than only refreshing gateway/catalog state.
- The active in-workspace panel still shows the entitlement error after fake timers pass 90 seconds, has no preparing
  spinner, and offers the account/activation route rather than a no-op retry.
- A cross-layer test feeds `P0001 / license already bound to another organization` and ends at the active panel's
  localized authorization error.
- Existing success, single-flight, account-cleanup, and catalog retry tests remain green.

### Acceptance

1. Apply the migration only in an authorized test or production environment.
2. Start from a clean local runtime/state on a second computer while keeping the U-disk portable data flow realistic.
3. Sign in with the observed two-organization account.
4. Verify relay bootstrap succeeds, the expected commercial model catalog appears, and a real chat round-trip completes.
5. Restart on the same computer and verify no repeated configuration writes.
6. Exercise a deliberately unauthorized account and verify an explicit error replaces the preparation spinner, stays
   visible beyond 90 seconds, and does not issue repeated activation RPCs.

## Rollout and rollback

The backend migration is backward-compatible and should be deployed before distributing the rebuilt desktop package so existing 0.0.25 candidates also recover. Before deployment, run the complete SQL guard suite and snapshot the affected function definition and grants. Rollback restores the previous function definition; it does not rewrite license ownership rows because the new function never moves an existing binding.

The desktop candidate is rebuilt only after backend and desktop test gates pass. Production migration deployment, package publication, and automatic-update publication remain separately authorized actions.

## Success criteria

- The captured two-organization/new-device scenario no longer produces `license already bound to another organization` for the rightful owner.
- No already-bound license changes organization.
- Unauthorized users cannot receive the relay key.
- The UI never represents a known permanent entitlement failure as ongoing model preparation.
- A clean-machine real chat succeeds before the candidate is declared releasable.
