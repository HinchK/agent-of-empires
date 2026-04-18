# Plan: Web Push notifications for the aoe dashboard

## Problem

A user runs `aoe serve --remote` on their dev box and opens the resulting Cloudflare tunnel URL on their phone. They start a Claude Code session in a worktree. Five minutes later, Claude hits a permission prompt or completes a long operation and waits for input.

Today, the user has no way to know this happened unless they are actively looking at the tab. The dashboard has no push notifications, no favicon badge, no tab-title alert, no sound. If the tab isn't the frontmost tab, the agent sits idle indefinitely while the user does other things.

This kills the core value proposition of the web dashboard: **remote, asynchronous agent access**. Without notifications, the dashboard is just "SSH with a prettier terminal." With notifications, it becomes "set the agent running, put the phone in your pocket, come back when it pings you."

Secondary motivation: on iOS, notifications delivered to an installed PWA appear on the Lock Screen. Tapping one unlocks the device and deep-links straight to the right session. That is the lock-screen access path the user asked about. There is no PWA-on-Lock-Screen widget API on iOS (Apple doesn't expose Live Activities or Control Center to web); notifications are the vehicle.

## Goal

Deliver Web Push notifications from `aoe serve` to an installed PWA. Minimum viable behavior:
- On the transition Running → Waiting (agent needs user input), send a push to every subscribed device.
- Notification body shows the session title; tapping the notification opens the PWA deep-linked to that session.
- User opts in from a Settings toggle inside the PWA; opting in asks for browser permission and registers a Web Push subscription.
- A "Send test notification" button so the user can confirm it works end-to-end before walking away.

Stretch (not in v1):
- Running → Error and Running → Idle-after-long-run triggers.
- Per-session opt-in.
- Rich notification actions (Approve/Reject from the lock screen). Pairs with the future permission-UI feature.
- Quiet hours / throttling.

## Non-goals

- Local-mode (http://) support on iOS. iOS requires HTTPS for push. Tunnel mode already gives HTTPS. Non-iOS browsers that allow push over http://localhost can still work; we won't block it, but we won't test for it either.
- Android-specific feature parity. Firefox/Chrome Android should work via standard Web Push; no custom Android plumbing.
- Replacing the TUI's in-terminal notification mechanism. aoe already has desktop sound alerts and tmux bell; this adds a web-specific channel, doesn't replace them.

## Approach

Standard Web Push over VAPID. Server signs pushes with a VAPID private key; client registers a Service Worker push subscription using the VAPID public key; server POSTs payloads to the push endpoint URLs the browsers vend.

### Server side (`src/server/`)

**New module:** `src/server/push.rs`

- **VAPID keypair:** Generated on first server start, persisted to `$app_dir/push.vapid.json` (same directory as `serve.token`). Permissions 0600, owner-only read. Loaded on every subsequent start. Key is P-256 ECDSA as required by the Web Push spec.
- **Subscription storage:** Persisted to `$app_dir/push.subscriptions.json`. Entries are `{endpoint, p256dh_key, auth_key, created_at, user_agent}` keyed by endpoint. Loaded on start into a `RwLock<HashMap<String, Subscription>>` in `AppState`. Writes are atomic (write-to-temp + rename).
- **Garbage collection:** When a send returns 410 Gone (subscription expired) or 404 Not Found, remove the entry and persist. No explicit heartbeat or TTL.

**New endpoints:**
- `GET  /api/push/vapid-public-key` → `{ "public_key": "<base64url>" }`
- `POST /api/push/subscribe` → body: the browser's `PushSubscription.toJSON()` shape. Stores it. Returns 204.
- `POST /api/push/unsubscribe` → body: `{ "endpoint": "..." }`. Removes by endpoint. Returns 204.
- `POST /api/push/test` → fires a one-shot test notification to all of the caller's subscriptions (identified by endpoint match against the request's stored subscriptions, or all subscriptions if we can't narrow it). Returns 204.

All endpoints are auth-gated like the rest of `/api/*`.

**Status transition hook:** In the existing `status_poll_loop` (currently refreshes tmux state every 2s), add a per-session `previous_status` map. When a session transitions `Running → Waiting`, enqueue a push send for that session. Send happens on a spawned Tokio task so the poll loop doesn't block on slow push endpoints.

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
The `tag` coalesces repeat notifications for the same session — if Claude waits, gets input, waits again, the second notification replaces the first on the lock screen rather than stacking.

**Crate choice:** `web-push = "0.10"` for signing and sending. It handles VAPID JWT construction and AES-128-GCM payload encryption. Mature crate, low dependency weight.

### Client side (`web/`)

**Extend `public/sw.js`:**
Current `sw.js` has install/activate only and no fetch handler. Add:
- `push` event listener: parses the payload, calls `self.registration.showNotification(title, { body, tag, data: { url } })`.
- `notificationclick` event listener: closes the notification, calls `clients.openWindow(event.notification.data.url)` after checking for an already-open PWA window that matches.

**New component:** `web/src/components/NotificationSettings.tsx`, rendered as a section inside `SettingsView.tsx`.
- Shows current state: Off / Asking / Enabled / Denied / Unsupported.
- Primary button: "Enable notifications" (Off → Asking → Enabled flow).
- Secondary button: "Send test notification" (visible only when Enabled).
- Disable button: "Turn off notifications" (visible only when Enabled).
- iOS-specific inline help: "On iPhone, you need to add this dashboard to your Home Screen first. Tap the Share icon in Safari, then 'Add to Home Screen.' Then open the installed app to enable notifications."
- "Unsupported" state appears on browsers without Push API, or on iOS Safari that isn't running as a PWA. Detection: `'PushManager' in window && navigator.serviceWorker` plus platform heuristic for iOS-not-standalone.

**New hook:** `web/src/hooks/usePushSubscription.ts`
- Reads current state from `Notification.permission` and `ServiceWorkerRegistration.pushManager.getSubscription()`.
- `enable()`: requests permission, fetches VAPID public key, calls `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, POSTs the subscription to `/api/push/subscribe`.
- `disable()`: unsubscribes locally, POSTs to `/api/push/unsubscribe`.
- `sendTest()`: POSTs to `/api/push/test`.

**Manifest check:** Audit `web/public/manifest.json` to ensure `display: "standalone"`, `start_url: "/"`, `icons` with 192 and 512 present. Required for iOS to treat it as an installable PWA.

### Test plan

**Rust side (`cargo test`):**
- VAPID keypair: generate, persist, reload, same key.
- Subscription storage: add, persist, reload, remove, persist.
- GC on 410/404: subscription removed from store.
- Status transition detection: given a sequence of status updates, correct push enqueues.

**Frontend (`playwright`):**
- Settings → Enable button flow (mock permission grant, mock server endpoints, verify subscription posted).
- Test-notification button posts to `/api/push/test`.
- iOS-not-standalone heuristic shows "Unsupported" state.
- Disable button unsubscribes and posts to `/api/push/unsubscribe`.

**End-to-end (manual, documented in `docs/push-notifications.md`):**
- Install PWA on iPhone (iOS 16.4+).
- Open PWA, enable notifications, send test → appears on Lock Screen.
- Start a Claude session that will hit a permission prompt, put phone on lock screen, observe notification.
- Tap notification → PWA opens to that session.

### Effort estimate

Roughly:
- `push.rs` module + VAPID + storage + endpoints: ~1 day CC
- Status transition hook in `status_poll_loop`: ~2 hours CC
- Service worker changes: ~2 hours CC
- React Settings component + hook: ~half day CC
- Tests (unit + Playwright): ~half day CC
- Documentation (docs/push-notifications.md + user-facing help): ~2 hours CC

Total: ~3 days CC. This is a lake, not an ocean.

## Files touched

New:
- `src/server/push.rs`
- `web/src/components/NotificationSettings.tsx`
- `web/src/hooks/usePushSubscription.ts`
- `web/tests/push-notifications.spec.ts`
- `docs/push-notifications.md`

Modified:
- `src/server/mod.rs` — add `push` module, `AppState` fields for VAPID/subscriptions, hook push send into `status_poll_loop`, register new routes.
- `src/server/api.rs` — not touched (push endpoints live in push.rs).
- `Cargo.toml` — add `web-push = "0.10"`.
- `web/public/sw.js` — add push + notificationclick handlers.
- `web/public/manifest.json` — verify PWA installability fields (edit if missing any).
- `web/src/components/SettingsView.tsx` — render new NotificationSettings section.
- `docs/cli/reference.md` — regen if CLI changes (it shouldn't).

## Open questions for review

1. Is `Running → Waiting` the right sole trigger for v1? Or should we ship with Running → Error too (errors are higher-severity)?
2. Should subscriptions be tied to a device/passphrase identity so one user's "disable" affects only their devices, or is global-per-server fine for v1?
3. Should we log push sends to the tracing log? Useful for debugging, potential minor privacy concern if logs are shared.
4. The `web-push` crate is at 0.10, not 1.x — is maturity risk acceptable? Alternatives: reqwest + manual VAPID JWT + aes-gcm crate.

---

## Phase 1: CEO Review — Findings

Codex unavailable in this environment (OpenAI auth). Review proceeds `[subagent-only]`.

### Premise gate: Option A chosen
User confirmed the plan's premises: Web Push is the right vehicle, notifications-before-permission-UI is the right sequencing, PWA install friction is an acceptable user-base gate. Subagent pushed back on all three; user accepted the risk.

### CEO findings adopted into the plan
- **Subscription security (subagent finding #4 — HIGH):** bind subscriptions to the auth token; invalidate all subscriptions on token rotation. Added to Eng scope.
- **Status-transition flake (subagent finding #5 — MEDIUM):** add a dwell requirement before firing a push (e.g., session must be `Waiting` for ≥5s). Prevents phone buzzes on transient scrape flicker. Added to Eng scope.
- **Scope estimate (subagent finding #6 — MEDIUM):** revise estimate from 3d CC to 5d CC to absorb token-rotation UX, subscription GC, rate-limiting of push sends, and the dwell mechanism.

### CEO findings deferred
- **Sequencing (subagent finding #1 — CRITICAL):** permission-approval UI is out of scope for v1. User accepts the "half-feature" critique. Permission UI tracked as the next dashboard feature.
- **Alternative vehicles (subagent finding #3 — HIGH):** Telegram/ntfy integrations not in scope. User accepts that PWA-install friction gates the feature. Can add as additional channels later.
- **Unproven premise (subagent finding #2 — HIGH):** proceeding without instrumenting current dashboard usage first. User's call.

---

## Phase 2: Design Review — Findings (all auto-adopted into plan scope)

### Critical (were: missing from plan)
- **State machine expansion.** Replace the 5-state model with a discriminated union: `{kind: 'off'|'asking'|'subscribing'|'enabled'|'sending-test'|'disabling'|'denied'|'unsupported'|'stale'|'error', error?: string}`. Every button disabled during transient states with inline spinner suffix ("Enabling…"). Without this, double-click race-fires subscribes during the 500ms–3s handshake.
- **iOS denied vs denied-in-settings branch.** After `requestPermission()` returns `denied`, re-run the standalone check and branch error copy: "Denied — iOS requires adding to Home Screen first" with inline steps vs "Denied — enable notifications for this site in Settings > Safari."

### High
- **Delivery feedback loop.** `/api/push/test` returns `{delivered: N, failed: N, gone: N}` (not 204). UI shows "Sent to 2 devices. Didn't see it? Check Focus/DND, then try again." Add a "last successful delivery" row mirroring SecuritySettings' `Row` pattern.
- **Silent-revocation recovery path (stale state).** Permission granted but `getSubscription()` returns null → show warn-tone badge "Reconnection needed" + single Re-enable button. Poll `/api/push/subscriptions/mine` on SettingsView mount.
- **Platform-gated iOS help.** `<details>` disclosure "How to enable on iPhone" shown only when `state === 'unsupported' && isIOSSafari`. Numbered `<ol>` with Share-icon glyph inline. Desktop sees nothing.

### Medium
- **Visual language match.** Reuse `Row` and `Badge` components from `SecuritySettings.tsx:1-129`. Extract both to a shared `ui/Row.tsx` + `ui/Badge.tsx` (new, DRY — P4). `NotificationSettings` leads with a status Row (`<Badge tone="ok">enabled · 2 devices</Badge>`), actions below.
- **Enabled-but-undeliverable.** Server tracks last-delivery outcome per subscription. If last ≥3 consecutive attempts failed, show `<Badge tone="warn">enabled · delivery failing</Badge>` + "Diagnose" button that re-runs the test and surfaces the server-side error.
- **Device list.** `ConnectedDevices.tsx` pattern already exists — small per-subscription list below buttons: `{ua_summary, created_at, [Revoke]}`. Revoke POSTs to `/api/push/unsubscribe` with that endpoint.

### Scope impact
Design findings add: shared `Row`/`Badge` extraction, expanded state machine, server-side delivery-outcome tracking, device-list UI, stale-state detection + poll endpoint. Revised effort estimate: **5d → 7d CC**.

---

## Phase 3: Eng Review — Findings

### Consensus table `[subagent-only]`

| Dimension | Subagent | Codex | Consensus |
|---|---|---|---|
| Architecture sound? | DISAGREE (poll-loop is wrong hook; bus better) | N/A | Flagged → taste decision |
| Test coverage sufficient? | DISAGREE (no concurrency, no auth-boundary) | N/A | Adopt |
| Performance risks addressed? | DISAGREE (no per-send timeout, no semaphore) | N/A | Adopt |
| Security threats covered? | DISAGREE (token-binding underspec; proxy leak) | N/A | Adopt |
| Error paths handled? | DISAGREE (GC race, VAPID keygen race, dwell+tag) | N/A | Adopt |

### Auto-adopted into plan (completeness, P1 + security, mechanical)

**Push-send robustness (F-E2):** every `WebPushClient::send` wrapped in `tokio::time::timeout(Duration::from_secs(10), ...)`, concurrency capped via a `tokio::sync::Semaphore` with 8 permits. Without these, a single dead FCM endpoint + N subscriptions accumulates leaked tasks at 2s intervals.

**Token-binding spec (F-S1, from CEO finding #4):** each `Subscription` stores `owner_token_hash: [u8; 32]` = SHA-256 of the token used at subscribe time. `auth_middleware` sets a request extension `AuthenticatedTokenHash([u8; 32])` that handlers read. All `/api/push/*` handlers filter to owner-matching rows. `TokenManager::rotate()` iterates stored subscriptions and drops rows whose hash isn't the new-or-grace-period hash. Unsubscribe also requires owner match.

**Proxy leak defense (F-S3):** build `WebPushClient` with `reqwest::Client::builder().no_proxy().build()` injected. Document why in `push.rs` (corporate MITM proxies would otherwise see endpoint URLs).

**VAPID keygen race (F-E6):** acquire exclusive `fs2::FileExt::try_lock_exclusive` on `push.vapid.json.lock` before the generate-and-write sequence. Prevents two concurrent `aoe serve` invocations (dev rapid-restart, daemon SIGHUP recovery) from racing and producing two keypairs.

**GC race with in-flight send (F-E3):** each `Subscription` gets a generation counter. GC path removes only if the current entry's generation matches the value observed at send-start. Simple optimistic lock.

**Dwell + post-send cooldown (F-E1):** dwell (≥5s in Waiting before firing) is not sufficient on its own. Add a post-send cooldown of 60s per session: once a push fires, suppress further sends for that session until it leaves `Waiting`, then returns. `HashMap<InstanceId, LastNotifiedAt>`.

**Test ownership fallback removed (F-T3):** `/api/push/test` requires `{endpoint}` in the body; fires only to that subscription. No "fire to all" fallback — that would let any authenticated caller spam every registered device.

**Service worker `renotify: true` (F-H4):** otherwise iOS silently updates the banner with no buzz/sound when `tag` matches.

**Concurrency + auth-boundary tests (F-T1, F-T2):** two concurrent 410s on the same endpoint; subscribe-during-send race; dwell-during-flicker; subscribe with T1 → rotate to T2 → assert subscription dropped; unsubscribe with wrong-owner endpoint → 403.

**Document threat model + caveats (F-S2, F-H2, F-H3, F-D1):** new `docs/push-notifications.md` covers: endpoint URLs are correlatable by push providers (Apple/Google, acceptable given single-owner threat model), SW activation path (new push handler requires PWA re-open after upgrade), deep-link 401-then-rehydrate path on installed PWA, `web-push` crate caveats (0.10.x pin, feature flags to avoid openssl, consider reqwest+aes-gcm roll-your-own if scope grows).

**Extract PushState from AppState (F-A2):** `AppState` already has 10 fields. New push fields (`vapid`, `subscriptions`, `delivery_outcomes`, `notified_at`) live on a `PushState` owned by a single `AppState.push` field.

### Scope impact
Eng findings revise effort: **7d → 9–10d CC**. The token-binding plumbing (request extension + middleware propagation + rotate-invalidation) is a day on its own.

---

## Phase 4: Final Approval — Decisions

### Taste decision resolved
**Option Y adopted: status-change event bus.**

- `AppState` gains a `tokio::sync::broadcast::Sender<StatusChange>` field (channel capacity ~64). `StatusChange = { instance_id, old: Status, new: Status, at: DateTime<Utc> }`.
- `Instance::update_status_with_metadata` gains a caller-provided `Option<&broadcast::Sender<StatusChange>>` param. When `old != new`, emit. Callers that don't care (TUI-only paths) pass `None`.
- `status_poll_loop` passes the bus handle.
- `push.rs` runs a dedicated consumer task that subscribes to the bus, applies dwell + cooldown state, and enqueues sends through the semaphore-bounded worker.
- Unit tests feed the bus directly, no tmux required.

**Scope impact of the bus:** +~1d CC for the refactor (touches `instance.rs`, TUI callers, storage). Revised total: **10–11d CC.**

### Milestone split (implicit)
User chose single-PR delivery (option B, not C). The final scope is one ~10-day PR. If it gets unwieldy during implementation, a reviewer can carve out the bus refactor as a prerequisite PR.

### Rejected options
- **X (poll-loop snapshot diff):** rejected in favor of bus. User prioritized cleaner multi-trigger future and testability without tmux over ~1d of scope.

### Approved scope
Everything in this plan document, with the bus architecture from Option Y. All auto-adopted findings from all three phases are in scope. Deferred items remain deferred.

---

## Autoplan summary
- **Dual voices:** `[subagent-only]` throughout (codex unavailable, 401 in this environment).
- **Phases run:** CEO, Design, Eng. DX skipped (no developer-facing API surface).
- **User challenges surfaced at premise gate:** 2 (sequencing, alternative vehicles). Both resolved by user choosing Option A (ship as planned).
- **Taste decisions surfaced at final gate:** 1 (bus vs. poll diff). Resolved by user choosing Option B (bus).
- **Auto-decided findings:** 21 (completeness + mechanical + security).
- **Effort estimate evolution:** 3d → 5d → 7d → 9–10d → 10–11d. Each phase added real gaps; each bump is justified in the phase's findings section above.
- **Status:** APPROVED, ready for `/ship` when implementation is complete.
