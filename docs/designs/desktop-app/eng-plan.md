# Plan: aoe Desktop App (Tauri) with QR Code Pairing

## Context

Agent of Empires has a working web dashboard (`aoe serve`) but no native macOS app. Non-technical users are "scared away from the command line." The goal: a .app they download, double-click, and are managing AI agents in 30 seconds. The killer feature: scan a QR code from the menu bar and access the dashboard from your phone.

Design doc: `~/.gstack/projects/njbrake-agent-of-empires/root-main-design-20260409-183003.md` (APPROVED)

## Decisions from Eng Review

1. **Server refactor**: `ServerConfig` struct. Existing `start_server()` becomes a thin wrapper. Desktop calls `start_server_with_config()`.
2. **ConnectInfo**: Always enable `into_make_service_with_connect_info::<SocketAddr>()` in all modes.
3. **Startup race**: Oneshot channel signal from server to Tauri after TCP bind succeeds.
4. **CLI coexistence**: One server per machine. Desktop writes `serve.pid`/`serve.url`. CLI defers to running desktop server.

## Architecture

```
Desktop App Startup Flow
========================

main() [#[tokio::main]]
  |
  ├── find_available_port() → port
  ├── generate_auth_token() → token
  ├── Arc::new(AtomicBool::new(false)) → remote_enabled
  ├── oneshot::channel() → (tx, rx)
  |
  ├── tokio::spawn(start_server_with_config(ServerConfig {
  │       port, token, remote_enabled,
  │       print_banner: false,
  │       write_url_file: false,
  │       ready_signal: Some(tx),
  │   }))
  |
  └── tauri::Builder::default()
        .setup(|app| {
            // Wait for server ready signal
            rx.await?;
            // Create main window → http://127.0.0.1:{port}/?token={token}
            // Setup tray icon
        })
        .run()


Remote Access Middleware
=======================

Request → ConnectInfo<SocketAddr> → check remote_enabled
  |
  ├── remote_enabled = None → PASS (CLI mode, no filtering)
  ├── remote_enabled = Some(false)
  │     ├── IP is 127.0.0.1 or ::1 → PASS
  │     └── IP is anything else → 403 Forbidden
  └── remote_enabled = Some(true) → PASS (auth still required)


QR Code Pairing Flow
====================

User clicks "Enable Remote Access" in tray
  |
  ├── remote_enabled.store(true)
  ├── detect_lan_ip() → "192.168.1.42"
  ├── build URL: http://192.168.1.42:{port}/?token={token}
  ├── generate_qr_png(url) → PNG bytes
  ├── open frameless popover window below tray icon
  │     |-- QR code image
  │     |-- URL text (selectable)
  │     |-- "Only use on trusted networks" warning
  ├── copy URL to clipboard
  └── macOS notification: "Remote access enabled"
```

## Files to Modify (existing codebase)

### `Cargo.toml` (workspace root)
- Add `"desktop"` to `workspace.members`

### `src/server/mod.rs`
- Add `ServerConfig` struct:
  ```rust
  pub struct ServerConfig {
      pub profile: String,
      pub host: String,
      pub port: u16,
      pub no_auth: bool,
      pub read_only: bool,
      pub remote_enabled: Option<Arc<AtomicBool>>,
      pub print_banner: bool,
      pub write_url_file: bool,
      pub ready_signal: Option<oneshot::Sender<()>>,
  }
  ```
- Add `remote_enabled: Option<Arc<AtomicBool>>` to `AppState`
- Add `start_server_with_config(config: ServerConfig) -> anyhow::Result<String>` (returns token)
- Refactor existing `start_server()` to build a default `ServerConfig` and call `start_server_with_config()`
- Change `axum::serve(listener, app)` to `axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())`
- Add `remote_access_middleware()` as an axum layer
- Fire `ready_signal` after TCP bind succeeds, before entering serve loop
- Add unit tests for middleware (5 cases)

### `src/cli/serve.rs`
- Update `run()` to use `start_server_with_config()` with `print_banner: true, write_url_file: true, remote_enabled: None`
- No behavior change for CLI users

## Files to Create (desktop workspace)

### `desktop/Cargo.toml`
```toml
[package]
name = "aoe-desktop"
version = "0.1.0"
edition = "2021"

[dependencies]
agent-of-empires = { path = "..", features = ["serve"] }
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-shell = "2"
tauri-plugin-notification = "2"
tokio = { version = "1", features = ["full"] }
qrcode = "0.14"
image = "0.25"
local-ip-address = "0.6"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

### `desktop/tauri.conf.json`
- App name: "Agent of Empires"
- Window: 1200x800, resizable, titled
- Security: allow localhost connections
- Tray icon configuration
- Bundle identifier: `ai.mozilla.agent-of-empires`

### `desktop/src/main.rs` (~80 lines)
- `#[tokio::main]` entry point
- `find_available_port()` (try 8080-8090)
- Tauri Builder setup with server spawn + oneshot wait
- Write `serve.pid` and `serve.url` on startup, clean up on exit

### `desktop/src/tray.rs` (~120 lines)
- `setup_tray(app, port, token, remote_enabled)`
- Menu items: session count (updated on timer), remote toggle, open dashboard, quit
- Remote toggle handler: flips AtomicBool, opens/closes QR popover
- Quit handler: clean shutdown (remove PID/URL files, stop server, exit)

### `desktop/src/qr.rs` (~60 lines)
- `generate_qr_png(url: &str) -> Vec<u8>` (pure function)
- `detect_lan_ips() -> Vec<IpAddr>` (filters loopback, Docker, VPN interfaces)
- Unit tests (2 for QR, 3 for IP detection)

### `desktop/build.rs`
- Standard `tauri_build::build()` call

### `desktop/capabilities/default.json`
- Tauri capability permissions for window management, tray, notifications

### `desktop/icons/`
- App icon in .icns format (macOS), .ico (Windows future), .png (Linux future)

## Reused Code (existing, unchanged)

| What | Where | How |
|------|-------|-----|
| All REST API routes | `src/server/api.rs` (804 lines) | Called via `build_router()` |
| Auth middleware + token gen | `src/server/auth.rs` (128 lines) | Unchanged |
| WebSocket PTY relay | `src/server/ws.rs` (209 lines) | Unchanged |
| Static asset embedding | `build.rs` + `rust-embed` | Unchanged |
| Session management | `src/session/` | Unchanged |
| tmux integration | `src/tmux/` | Unchanged |
| Process management | `src/process/macos.rs` | Unchanged |
| PID/URL file logic | `src/cli/serve.rs` (patterns reused) | Pattern copied to desktop |
| PWA manifest + service worker | `web/manifest.json`, `web/sw.js` | Unchanged |

## Test Plan

**Unit tests (14 tests, run on any OS in CI):**

In `src/server/mod.rs` (`#[cfg(test)]`):
1. `test_remote_middleware_local_ipv4_always_passes`
2. `test_remote_middleware_local_ipv6_always_passes`
3. `test_remote_middleware_remote_ip_blocked_when_off`
4. `test_remote_middleware_remote_ip_allowed_when_on`
5. `test_remote_middleware_none_allows_all` (CLI compat)
6. `test_server_config_default_matches_cli`
7. `test_server_config_desktop_mode`

In `desktop/src/qr.rs` (`#[cfg(test)]`):
8. `test_generate_qr_png_valid_url`
9. `test_generate_qr_png_returns_valid_png`
10. `test_detect_lan_ips_excludes_loopback`
11. `test_detect_lan_ips_returns_ipv4`
12. `test_detect_lan_ips_handles_no_network`

In `desktop/src/main.rs` (`#[cfg(test)]`):
13. `test_find_available_port_returns_valid`
14. `test_find_available_port_skips_occupied`

**macOS E2E tests (2 tests, `#[ignore]`, require macOS runner):**
15. `test_tray_icon_created`
16. `test_webview_loads_after_server_ready`

## Failure Modes

| Code path | Failure | Test? | Error handling? | User sees? |
|-----------|---------|-------|-----------------|------------|
| TCP bind | Port in use | test_find_available_port | Yes, retry 8081-8090 | Clear error if all fail |
| Server spawn | Panic in tokio task | No | Tauri catches, tray goes gray | "Server stopped. Restart?" |
| tmux binary | Missing/no-exec | No | Falls back to system tmux | Error + install link |
| LAN IP detect | No interfaces | test_detect_lan_ips | Returns empty vec | Toggle disabled |
| QR generation | Invalid input | test_generate_qr_png | Returns error | No popover shown |
| Remote middleware | Wrong IP classification | 5 tests | Yes | Security boundary |
| Oneshot signal | Server fails before bind | No | rx.await returns Err | Tauri shows error dialog |

**Critical gaps:** 0 (all security-critical paths have tests; server panic and tmux missing are handled by error UI but not automated tests, which is acceptable for v1).

## NOT in Scope

- First-launch wizard (deferred to v1.1, existing dashboard UI sufficient)
- Auto-launch on macOS login (deferred to v1.1)
- TLS/HTTPS (documented for tunnels, not built-in)
- Internet tunneling (Tailscale/Cloudflare documented, not integrated)
- Windows/Linux desktop builds (Tauri supports them; deferred to v2)
- Auto-update via Tauri updater plugin (requires code signing first; tracked in TODOS.md)
- Homebrew Cask formula (post-launch distribution)
- tmux bundling (v1 requires tmux pre-installed; app checks on launch and shows install instructions if missing)
- Code signing + notarization (requires Apple Developer account; tracked in TODOS.md)

## What Already Exists

- **Web dashboard**: fully built, React + TypeScript + Vite + Tailwind, mobile-responsive
- **Server**: axum with auth, REST API, WebSocket PTY relay, static asset embedding
- **Daemon mode**: PID/URL file management in `src/cli/serve.rs`
- **PWA support**: manifest.json and service worker already in web/
- **Library exports**: `src/lib.rs` already exports `server` module publicly

## Implementation Order

1. Refactor `src/server/mod.rs`: ServerConfig, remote middleware, ConnectInfo, oneshot signal, tests
2. Update `src/cli/serve.rs` to use new config (no behavior change)
3. Scaffold `desktop/` workspace: Cargo.toml, tauri.conf.json, build.rs, capabilities
4. Wire `desktop/src/main.rs`: server spawn, webview, PID/URL files
5. Implement `desktop/src/tray.rs`: menu bar icon, remote toggle, quit
6. Implement `desktop/src/qr.rs`: QR generation, LAN IP detection, popover window
7. Add desktop tests
8. CI workflow for Tauri build (macOS runner, code signing as separate step)

## Verification

1. `cargo test` passes (existing tests unaffected + 7 new server tests)
2. `cargo test -p aoe-desktop` passes (7 new desktop tests)
3. `cargo run -- serve` still works identically (CLI regression check)
4. `cargo tauri dev` (from `desktop/`) opens a macOS window showing the dashboard
5. Toggle "Remote Access" in tray, scan QR code on phone, dashboard loads
6. Run `aoe serve` while desktop is running, verify it defers to existing server

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | CLEAR | 5 proposals, 5 accepted, 0 deferred |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR | 4 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** CEO + ENG CLEARED — ready to implement. Consider `/plan-design-review` for UI design specs on the 4 new surfaces (tray, popover, notifications, error dialogs).
