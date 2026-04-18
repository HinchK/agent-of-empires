# Plan: Web Push notifications for the aoe dashboard

## Problem

A user runs `aoe serve --remote` on their dev box and opens the resulting Cloudflare tunnel URL on their phone. They start a Claude Code session in a worktree. Five minutes later, Claude hits a permission prompt or completes a long operation and waits for input.

Today, the user has no way to know this happened unless they are actively looking at the tab. The dashboard has no push notifications, no favicon badge, no tab-title alert, no sound. If the tab is not the frontmost tab, the agent sits idle indefinitely while the user does other things.

This kills the core value proposition of the web dashboard: remote, asynchronous agent access. Without notifications, the dashboard is just "SSH with a prettier terminal." With notifications, it becomes "set the agent running, put the phone in your pocket, come back when it pings you."

Secondary motivation: on iOS, notifications delivered to an installed PWA appear on the Lock Screen. Tapping one unlocks the device and deep-links straight to the right session. That is the lock-screen access path the feature delivers. There is no PWA-on-Lock-Screen widget API on iOS (Apple does not expose Live Activities or Control Center to web); notifications are the vehicle.

## Goal

Deliver Web Push notifications from `aoe serve` to an installed PWA. Minimum viable behavior:
- On the transition Running to Waiting (agent needs user input), send a push to every subscribed device whose owner matches the current auth token.
- Notification body shows the session title; tapping the notification opens the PWA deep-linked to that session.
- Two levels of toggle (see Toggleability below).
- A "Send test notification" button so the user can confirm it works end-to-end before walking away.

Stretch (not in v1):
- Running to Error and Running to Idle-after-long-run triggers.
- Per-session opt-in.
- Rich notification actions (Approve/Reject from the lock screen). Pairs with the future permission-UI feature.
- Quiet hours / throttling.

## Non-goals

- Local-mode (`http://`) support on iOS. iOS requires HTTPS for push. Tunnel mode already gives HTTPS. Non-iOS browsers that allow push over `http://localhost` can still work; we will not block it, but will not test for it either.
- Android-specific feature parity. Firefox/Chrome Android should work via standard Web Push; no custom Android plumbing.
- Replacing the TUI's in-terminal notification mechanism. aoe already has desktop sound alerts and tmux bell; this adds a web-specific channel, it does not replace them.

## Toggleability

Two levels. Both must work.

**Server-level toggle (`web.notifications_enabled`, default true).** A new config field on `WebConfig`, editable in the TUI settings screen per CLAUDE.md convention. When false:
- `/api/push/*` endpoints return 404 instead of registering subscriptions.
- The status-change event bus consumer in `push.rs` drops all events (or never starts).
- The frontend, on fetching `GET /api/push/status`, sees `{enabled: false}` and shows a disabled state in `NotificationSettings` with help text: "Push notifications are disabled by the server. Contact the operator to enable."
- Existing subscriptions persist but are not sent to. Flipping back to true resumes delivery without user re-opt-in.

Wiring required per CLAUDE.md (`## Settings & Configuration`):
- Add `FieldKey::WebNotificationsEnabled` in `src/tui/settings/fields.rs`.
- Add a `SettingField` entry in the matching `build_*_fields()`.
- Wire `apply_field_to_global()` and `apply_field_to_profile()`.
- Add a `clear_profile_override()` case in `src/tui/settings/input.rs`.
- Add the field to `WebConfigOverride` in `profile_config.rs` with merge logic in `merge_configs()`.

**User-level toggle (Settings UI in the dashboard).** The `NotificationSettings` component with states Off, Asking, Subscribing, Enabled, Sending-test, Disabling, Denied, Unsupported, Stale, Error. Primary Enable/Disable buttons, a Send-test button when enabled, a device list with per-device Revoke. Details in "Client side" below.

## Approach

Standard Web Push over VAPID. Server signs pushes with a VAPID private key; client registers a Service Worker push subscription using the VAPID public key; server POSTs payloads to the push endpoint URLs the browsers vend. Status changes flow through an internal event bus so the detection logic is decoupled from tmux polling and testable without a real tmux.

### Server side (`src/server/`)

**New module:** `src/server/push.rs`, exporting a `PushState` struct that owns VAPID, the subscription store, delivery-outcome tracking, the dwell/cooldown map, and the broadcast-channel consumer task.

**New field on `AppState`:** `push: PushState`. (Not individual fields; the Eng review flagged `AppState` as already god-struct-shaped.)

**New event bus:** `AppState.status_tx: broadcast::Sender<StatusChange>` with capacity ~64. `StatusChange = { instance_id, old: Status, new: Status, at: DateTime<Utc> }`. `Instance::update_status_with_metadata` gains a `Option<&broadcast::Sender<StatusChange>>` parameter; when `old != new` it emits. Callers that do not care (TUI-only paths) pass `None`. `status_poll_loop` and any future caller that wants transitions emitted pass the handle.

**VAPID keypair.** Generated on first server start, persisted to `$app_dir/push.vapid.json`. Permissions 0600. Key is P-256 ECDSA. To prevent concurrent `aoe serve` invocations racing (dev restart, daemon SIGHUP recovery path from commit 5494e8b), the generate-and-write sequence acquires an exclusive `fs2::FileExt::try_lock_exclusive` on `push.vapid.json.lock`. If the lock is held, wait briefly and re-read the file rather than generating a second keypair.

**Subscription storage.** Persisted to `$app_dir/push.subscriptions.json`, atomic write (temp+rename). Each `Subscription`:

```rust
struct Subscription {
    endpoint: String,           // PushSubscription.endpoint
    p256dh: String,             // base64url from PushSubscription.toJSON().keys.p256dh
    auth: String,               // base64url from PushSubscription.toJSON().keys.auth
    owner_token_hash: [u8; 32], // SHA-256 of the bearer token at subscribe-time
    user_agent: String,
    created_at: DateTime<Utc>,
    generation: u64,            // optimistic-lock counter for GC-during-send
    last_delivery: Option<DeliveryOutcome>,
}
```

Loaded on start into a `RwLock<HashMap<String /* endpoint */, Subscription>>` on `PushState`.

**Token-hash ownership (security).** `auth::auth_middleware` (`src/server/auth.rs:196`) sets a request extension `AuthenticatedTokenHash([u8; 32])` after validating the bearer token. All `/api/push/*` handlers read this extension and filter the subscription store by `owner_token_hash`. `TokenManager::rotate` (`src/server/mod.rs:110`) iterates subscriptions and drops any whose hash is not the new-or-grace-period hash. Unsubscribe also requires owner match; cross-owner unsubscribe returns 403.

**Garbage collection.** On send, if the response is 410 Gone or 404 Not Found, remove the entry, but only if its `generation` counter matches the value observed at send-start. A concurrent `subscribe` for the same endpoint increments the counter; the stale-GC condition prevents wiping a freshly re-subscribed entry.

**Dwell + post-send cooldown.** Firing requires the session to have been in `Waiting` for at least 5 seconds (`DWELL_MS = 5_000`) to suppress flicker. After a push fires for a session, suppress further pushes until the session leaves `Waiting`, OR 60 seconds have elapsed since the last fire for that session (`COOLDOWN_MS = 60_000`), whichever comes second. Internal state: `HashMap<InstanceId, { waiting_since: Option<Instant>, last_notified: Option<Instant> }>`.

**Push send robustness.** Each send wrapped in `tokio::time::timeout(Duration::from_secs(10), ...)`. Concurrent sends capped via `tokio::sync::Semaphore` with 8 permits. The `WebPushClient` is built with a `reqwest::Client` constructed via `reqwest::Client::builder().no_proxy().build()` to prevent leaking endpoint URLs and payloads through corporate MITM proxies.

**New endpoints:**
- `GET  /api/push/status` returns `{ enabled: bool }`, gating UI affordances.
- `GET  /api/push/vapid-public-key` returns `{ public_key: "<base64url>" }`. 404 when disabled.
- `POST /api/push/subscribe` accepts the browser's `PushSubscription.toJSON()` body, stores it with owner hash. Returns 204. 404 when disabled.
- `POST /api/push/unsubscribe` accepts `{ endpoint }`, removes only if owner matches. Returns 204 (or 403 on mismatch). 404 when disabled.
- `POST /api/push/test` accepts `{ endpoint }` (required, no "fire to all" fallback). Fires one push. Returns `{ delivered: u32, failed: u32, gone: u32 }` so the UI can show real outcome, not just a 204.

All endpoints are auth-gated like the rest of `/api/*`.

**Push payload shape:**
```json
{
  "title": "Claude is waiting",
  "body": "<session title>",
  "url": "/sessions/<session-id>",
  "tag": "session-<session-id>",
  "session_id": "<session-id>"
}
```
The `tag` coalesces repeat notifications for the same session, so subsequent pushes replace the prior banner rather than stacking. The service worker passes `renotify: true` to `showNotification`; without it, iOS silently updates the existing banner with no buzz or sound.

**Crate choice.** `web-push = "0.10"` with `default-features = false` and pure-Rust crypto features only (avoids transitive `openssl`). The crate handles VAPID JWT construction and AES-128-GCM payload encryption. Roll-your-own alternative (`reqwest` + manual JWT + `aes-gcm`) is ~200 lines; acceptable if the crate's maintenance slows.

### Client side (`web/`)

**Extend `public/sw.js`:**
- `push` event listener: parses the JSON payload, calls `self.registration.showNotification(title, { body, tag, renotify: true, data: { url } })`.
- `notificationclick` event listener: closes the notification, searches `clients.matchAll({ type: 'window' })` for an already-open PWA window and focuses it (navigating to `url` if different), else `clients.openWindow(url)`.

Known limitation documented in `docs/push-notifications.md`: users who upgrade aoe while the PWA is installed do not get the new handlers until the service worker activates, which happens on next PWA open. First-bug-report preempt: "enable notifications after the PWA has been re-opened once following an upgrade."

**New component:** `web/src/components/NotificationSettings.tsx`, rendered as a section inside `SettingsView.tsx`. State modeled as a discriminated union:

```ts
type State =
  | { kind: 'off' }
  | { kind: 'asking' }
  | { kind: 'subscribing' }
  | { kind: 'enabled'; devices: Device[] }
  | { kind: 'sending-test' }
  | { kind: 'disabling' }
  | { kind: 'denied' }
  | { kind: 'unsupported'; reason: 'no-api' | 'ios-not-standalone' }
  | { kind: 'stale' }                    // permission granted but no subscription on server
  | { kind: 'error'; message: string }
  | { kind: 'disabled-by-server' };     // /api/push/status returned enabled: false
```

Transient states (`asking`, `subscribing`, `sending-test`, `disabling`) disable buttons with inline spinner suffix ("Enabling...") so double-clicks cannot race. The `enabled` variant shows a device list reusing the `ConnectedDevices.tsx` pattern; each row has `{user_agent_summary, created_at, Revoke}`. Revoke POSTs to `/api/push/unsubscribe` with that endpoint. Last-delivery-outcome timestamp shown alongside; if the last 3 attempts all failed, show `<Badge tone="warn">enabled, delivery failing</Badge>` and a Diagnose button that re-runs the test and surfaces the server-side error.

**iOS denied-vs-denied-in-settings branch.** After `requestPermission()` returns `denied`, re-run the standalone check. If not standalone, render the `unsupported` variant with an `<ol>` of the Add-to-Home-Screen steps plus the inline Share-icon glyph. If standalone, render `denied` with copy pointing to Settings > Safari > Notifications. The `<ol>` is rendered only in the unsupported variant, so desktop users never see the iOS steps.

**Visual language.** `NotificationSettings` leads with a status Row (tone badge, count of devices) matching `SecuritySettings.tsx:1-129` visually. Extract the shared `Row` and `Badge` primitives to `web/src/components/ui/Row.tsx` and `web/src/components/ui/Badge.tsx` so both sections use the same source.

**New hook:** `web/src/hooks/usePushSubscription.ts`. Reads live state from `Notification.permission` and `ServiceWorkerRegistration.pushManager.getSubscription()`. Provides `enable()`, `disable()`, `sendTest()`, and `refresh()`. `refresh()` also polls `/api/push/status` on mount so `disabled-by-server` is reflected without a page reload.

**Stale-state detection.** If `Notification.permission === 'granted'` and `getSubscription()` is null, the local subscription was revoked by the OS or the server dropped the subscription on token rotation. Render `stale` variant with a single Re-enable button.

**Manifest audit.** `web/public/manifest.json` already has `display: "standalone"`, `start_url: "/"`, `icons` with 192 and 512. No edits required; the plan's earlier "audit required" wording was out of date. Confirmed.

### Test plan

**Rust unit tests (`cargo test --features serve`):**
- VAPID keypair: generate, persist, reload, same key.
- VAPID keygen lock: two spawned tasks calling the init function concurrently produce one keypair, not two.
- Subscription storage: add, persist, reload, remove, persist.
- GC race: generation counter prevents wiping a freshly re-subscribed entry when the previous generation returns 410.
- Token-rotation invalidation: subscribe with T1; call `TokenManager::rotate`; subscription store no longer contains T1-hash-owned entries after grace period.
- Unsubscribe cross-owner: subscribe as T1, attempt unsubscribe as T2 with same endpoint, expect 403.
- Dwell + cooldown: feed a `broadcast::Receiver<StatusChange>` a sequence of transitions (Running to Waiting for 3s, back to Running, back to Waiting for 6s); assert exactly one push enqueued.
- Server-enabled flag off: `/api/push/*` returns 404 even when subscribed; consumer task drains events without sending.

**Frontend Playwright (`web/tests/`):**
- Enable-button flow: mock permission grant + mock server endpoints; verify subscription posted with correct body shape.
- Transient-state button disable: click Enable, assert button disabled until server ack.
- Test-notification button: posts to `/api/push/test`, surfaces `{delivered, failed, gone}` in UI.
- iOS-not-standalone heuristic: emulate iPhone + non-standalone; assert `unsupported` variant with steps.
- Disable flow: unsubscribes locally, POSTs to `/api/push/unsubscribe`, returns to `off` state.
- Stale detection: mock `Notification.permission === 'granted'` + `getSubscription() === null`; assert `stale` variant.
- Disabled-by-server: mock `/api/push/status` returning `{enabled: false}`; assert disabled copy and no Enable button.

**End-to-end (manual, documented in `docs/push-notifications.md` alongside implementation):**
- Install the PWA on iPhone (iOS 16.4+) via Safari, Share, Add to Home Screen.
- Open the installed PWA, enable notifications in Settings, tap Send test; notification appears on the Lock Screen.
- Start a Claude session that will hit a permission prompt; put the phone on the Lock Screen; observe the notification when Claude waits.
- Tap the notification; PWA opens and deep-links to the session.
- Flip `web.notifications_enabled` to false in TUI settings; the PWA's Settings view updates within ~5s via `/api/push/status` poll.

## Effort estimate

~10 to 11 days CC. Rough breakdown:

| Piece | Effort |
|---|---|
| Event bus refactor (`broadcast::Sender<StatusChange>`, wrap `update_status_with_metadata`, thread through all callers) | 1 day |
| `push.rs` module: VAPID gen+lock, subscription store with generation counters, dwell+cooldown map, semaphore-bounded send, timeout, no-proxy reqwest client | 2 days |
| Token-hash ownership: `AuthenticatedTokenHash` request extension, propagation, filter on every `/api/push/*` handler, rotate-invalidation | 1 day |
| 4 API endpoints + `/api/push/status` + auth wiring | 0.5 day |
| Server config toggle: `web.notifications_enabled`, TUI field wiring (FieldKey, SettingField, apply functions, `WebConfigOverride`, merge logic) | 0.5 day |
| Service worker: push + notificationclick with `renotify: true` | 0.25 day |
| React `NotificationSettings` component with 11-variant state machine + device list + iOS branch + stale detection + disabled-by-server | 1.5 days |
| `usePushSubscription` hook | 0.25 day |
| Extract shared `Row` and `Badge` primitives | 0.25 day |
| Rust unit tests (concurrency, token rotation, dwell, keygen lock, disabled flag) | 1 day |
| Playwright tests (all 7 listed above) | 1 day |
| Docs (`docs/push-notifications.md`: threat model, iOS install steps, SW activation caveat, crate-choice rationale) | 0.5 day |
| Buffer for integration surprises and codex review round | 0.5 day |

This is a lake, not an ocean. Natural split if one PR is too large:
- **Milestone 1 (~5 days):** event bus, `push.rs` core, VAPID, endpoints, token-hash binding, server-enabled flag, SW push handler, minimal Settings toggle, test button. End-to-end loop works.
- **Milestone 2 (~5 days):** full state machine, delivery-outcome feedback, stale detection, device list, shared primitives, concurrency tests, docs.

## Files touched

New files:
- `src/server/push.rs`
- `web/src/components/NotificationSettings.tsx`
- `web/src/components/ui/Row.tsx` (extracted from `SecuritySettings.tsx`)
- `web/src/components/ui/Badge.tsx` (extracted from `SecuritySettings.tsx`)
- `web/src/hooks/usePushSubscription.ts`
- `web/tests/push-notifications.spec.ts`
- `docs/push-notifications.md` (user-facing docs, separate from this plan)

Modified:
- `src/server/mod.rs`: register `push` module, add `AppState.push: PushState` and `AppState.status_tx`, add `/api/push/*` routes.
- `src/server/auth.rs`: `auth_middleware` sets `AuthenticatedTokenHash` request extension after token validation.
- `src/session/instance.rs`: `update_status_with_metadata` accepts an optional `&broadcast::Sender<StatusChange>` and emits on `old != new`.
- `src/session/config.rs` (or wherever `WebConfig` lives): add `notifications_enabled: bool` field defaulting to true.
- `src/tui/settings/fields.rs`: new `FieldKey`.
- `src/tui/settings/input.rs`: `clear_profile_override` case.
- `src/tui/settings/profile_config.rs`: `WebConfigOverride` entry, `merge_configs` logic.
- (wherever `build_*_fields()` lives): new `SettingField` entry.
- `Cargo.toml`: `web-push = { version = "0.10", default-features = false, features = ["..."] }` (pick the pure-Rust-crypto set), `fs2`.
- `web/public/sw.js`: push and notificationclick handlers.
- `web/src/components/SettingsView.tsx`: render `NotificationSettings` section.
- `web/src/components/SecuritySettings.tsx`: replace local `Row`/`Badge` with imports from `ui/`.
- `docs/cli/reference.md`: regenerated via `cargo xtask gen-docs` if any CLI changes land (they should not).

## Deferred (tracked, not dropped)

- **Permission-approval UI from the lock screen** (CEO sequencing critique): next dashboard feature.
- **Running to Error and Running to Idle triggers**: stretch; adding them motivated the bus architecture.
- **Telegram/ntfy/email as additional channels**: possible after v1 usage signal.
- **Per-session opt-in**: stretch; requires `subscription.session_filter: Option<Vec<SessionId>>` and a per-session toggle in the sidebar.
- **Rich notification actions (Approve/Reject)**: pairs with the future permission-UI feature.
- **Quiet hours / throttling**: stretch.
- **Usage instrumentation**: skipped; the premise that remote async use is the dominant workflow is accepted without evidence.

## Review history

This plan went through a `/autoplan` pipeline (CEO, Design, Eng). Codex voice was unavailable in the review environment (OpenAI 401). All phases ran `[subagent-only]`. A second pass with working Codex auth before implementation is recommended.

**Premise gate (Phase 1, user-decided):** chose Option A, ship Web Push as planned over alternatives Telegram/ntfy, accepting PWA install friction and the "notifications without permission UI" half-feature critique.

**Taste gate (Phase 4, user-decided):** chose Option B, event bus over poll-loop snapshot diff. Plus ~1 day for testability and cleaner multi-trigger future.

**Auto-adopted findings** (principles P1 completeness + P4 DRY + security/mechanical):
- Token-hash binding with `AuthenticatedTokenHash` request extension, filter on every handler, rotate-invalidation.
- Per-send `timeout(10s)` + `Semaphore(8)` concurrency cap + `reqwest::Client::builder().no_proxy()`.
- `fs2` exclusive lock on VAPID keypair generation.
- Subscription generation counter to prevent GC race with in-flight send.
- Dwell (5s) and post-send cooldown (60s per session).
- `/api/push/test` requires explicit `endpoint`, no "fire to all" fallback (closes spam vector).
- Service worker `renotify: true`.
- Delivery-outcome tracking with Diagnose button when last 3 attempts failed.
- 11-variant state machine (up from the original 5).
- iOS denied-branch: standalone-check after deny to render correct help.
- Platform-gated iOS help: steps only render in the `unsupported`+`ios-not-standalone` variant.
- Shared `Row`/`Badge` extraction to `web/src/components/ui/`.
- Device list with per-device Revoke.
- Stale-state detection via `/api/push/status` poll on mount.
- `PushState` extracted from `AppState` to avoid god-struct.
- Concurrency + auth-boundary tests added to the Rust suite.
- Docs covering threat model, iOS install steps, SW-activation-on-upgrade, crate-choice rationale.

**Deferred despite surfacing in review:** the four items listed under "Deferred" above, each with rationale.
