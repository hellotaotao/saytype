# Automatic Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app automatic updates via `tauri-plugin-updater` + GitHub Releases: background check (startup + every 24 h) → silent download → low-key "restart to update" prompt (tray menu + settings page).

**Architecture:** All update logic lives in Rust (new `src-tauri/src/updater.rs` module); the frontend is display-only, wired through the existing `ipc-bridge.js` command/event maps. CI (`release.yml`) expands from macOS-only to a 3-platform matrix that emits minisign-signed updater artifacts and a merged `latest.json` onto the draft GitHub Release; the existing draft → manual Publish flow is the rollout gate.

**Tech Stack:** Tauri 2 (`tauri-plugin-updater = "2"`), GitHub Releases + `tauri-apps/tauri-action`, minisign keypair (`tauri signer generate`), plain JS frontend (no bundler).

**Spec:** `docs/superpowers/specs/2026-07-13-auto-update-design.md`

## Global Constraints

- Endpoint (exact): `https://github.com/hellotaotao/saytype/releases/latest/download/latest.json`
- GitHub secrets (exact names): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- UX: auto-download + prompt-to-restart. Never a blocking dialog; automatic-check failures are log-only.
- Check timing: first check ~30 s after startup, then every 24 h. **Never in debug builds** (`cfg!(debug_assertions)` guard).
- `bundle.createUpdaterArtifacts` lives ONLY in CI/e2e overlay configs — the main `tauri.conf.json` must stay buildable without the private key.
- No `tauri-plugin-process`, no notification plugin. Restart is Rust-side `AppHandle::restart()`.
- One frontend event channel: `update-status` (payload = `UpdateStatus`); states are exactly `idle | checking | downloading | ready | upToDate | error`.
- Tray menu labels are English-only (matches the existing tray).
- All `cargo` commands run inside `src-tauri/`.
- New IPC commands are registered in all three places: `commands.rs`, `lib.rs` `invoke_handler!`, `ipc-bridge.js` `tauriCommands`.
- Known pre-condition: the currently published release (v1.3.5) has **no** `latest.json` asset, so any real-endpoint check returns an HTTP 404-style error until the first updater-equipped release is published. Verification steps below expect this.
- Commit style: conventional commits (`feat(updater): …`, `ci(release): …`, `docs: …`).

---

### Task 1: Generate the updater signing keypair, store secrets

**Files:**
- Modify: `scripts/sign.env` (untracked, local only)
- Modify: `scripts/sign.env.example`

**Interfaces:**
- Produces: `~/.tauri/saytype-updater.key` (+ `.key.pub`), GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the public-key string consumed by Task 2's `tauri.conf.json`.

- [ ] **Step 1: Generate the keypair**

```bash
mkdir -p ~/.tauri
export UPDATER_KEY_PASSWORD="$(openssl rand -base64 24)"
echo "$UPDATER_KEY_PASSWORD"
npm run tauri -- signer generate -w ~/.tauri/saytype-updater.key --password "$UPDATER_KEY_PASSWORD"
```

Expected: prints the **public key** (a long base64 string) and writes `~/.tauri/saytype-updater.key` + `~/.tauri/saytype-updater.key.pub`. Keep the password in the shell for the next steps.

- [ ] **Step 2: Set the GitHub secrets**

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/saytype-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body "$UPDATER_KEY_PASSWORD"
gh secret list | grep TAURI
```

Expected: both `TAURI_SIGNING_*` secrets listed.

- [ ] **Step 3: Add the vars to `scripts/sign.env` (untracked) and `scripts/sign.env.example` (tracked)**

Append to **both** files (in `sign.env` use the real password; in `sign.env.example` keep the placeholder):

```sh
# Updater (minisign) signing — only needed for builds that pass an overlay
# config with createUpdaterArtifacts (release overlay / e2e overlay). Losing
# this key means installed clients can never auto-update again — keep a copy
# in the password manager.
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/saytype-updater.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<updater key password>"
```

- [ ] **Step 4: Tell the user to back up the key**

Surface to the user: back up `~/.tauri/saytype-updater.key` + the password in a password manager. This is a hard requirement from the spec (lost key = installed clients can never auto-update again).

- [ ] **Step 5: Commit**

```bash
git add scripts/sign.env.example
git commit -m "chore(updater): document updater signing key vars in sign.env.example"
```

---

### Task 2: Updater plugin config, dependency, and registration

**Files:**
- Modify: `src-tauri/tauri.conf.json` (add top-level `plugins` key)
- Create: `src-tauri/tauri.release.conf.json`
- Create: `src-tauri/tauri.updater-e2e.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs` (plugin registration only)

**Interfaces:**
- Consumes: the public key printed in Task 1 (`cat ~/.tauri/saytype-updater.key.pub`).
- Produces: a registered updater plugin so `app.updater()` works in Task 4; overlay configs consumed by Task 7 (CI) and Task 8 (e2e).

- [ ] **Step 1: Add `plugins.updater` to `src-tauri/tauri.conf.json`**

After the closing brace of the `"bundle"` object (before the file's final `}`), add:

```json
  "plugins": {
    "updater": {
      "pubkey": "<PASTE CONTENTS OF ~/.tauri/saytype-updater.key.pub>",
      "endpoints": [
        "https://github.com/hellotaotao/saytype/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
```

(Insert a comma after the `bundle` object's closing brace.)

- [ ] **Step 2: Create `src-tauri/tauri.release.conf.json`**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

- [ ] **Step 3: Create `src-tauri/tauri.updater-e2e.conf.json`**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "endpoints": ["http://127.0.0.1:8765/latest.json"],
      "dangerousInsecureTransportProtocol": true
    }
  }
}
```

- [ ] **Step 4: Add the Cargo dependency**

In `src-tauri/Cargo.toml` `[dependencies]`, after the `tauri-plugin-single-instance` line:

```toml
tauri-plugin-updater = "2"
```

- [ ] **Step 5: Register the plugin in `src-tauri/src/lib.rs`**

In the `setup` closure, immediately after `app.handle().plugin(log_plugin)?;`:

```rust
      // Auto-update: checks GitHub Releases' latest.json and verifies packages
      // against our minisign pubkey (docs/superpowers/specs/2026-07-13-auto-update-design.md).
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
```

- [ ] **Step 6: Verify it compiles and boots**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

Expected: `Finished` with no errors. Then boot dev briefly (plugin config parse happens at startup):

```bash
npm run dev
```

Expected: app starts, tray appears, no panic/log error mentioning `updater`. Quit with Ctrl+C.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/tauri.release.conf.json src-tauri/tauri.updater-e2e.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat(updater): register tauri-plugin-updater with GitHub Releases endpoint"
```

---

### Task 3: `updater.rs` status types + AppState wiring

**Files:**
- Create: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod updater;`)
- Modify: `src-tauri/src/state.rs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/updater.rs`

**Interfaces:**
- Produces (used by Tasks 4–6):
  - `updater::UpdateStatus { state: String, version: Option<String>, message: Option<String> }` — serde camelCase; the JSON wire contract for the `update-status` event and `get_update_status` command.
  - `updater::UpdateStatus::new(state: &str, version: Option<String>, message: Option<String>) -> UpdateStatus`; `Default` = `idle`.
  - `updater::PendingUpdate { update: tauri_plugin_updater::Update, bytes: Vec<u8> }`
  - `AppState.pending_update: Mutex<Option<updater::PendingUpdate>>`
  - `AppState.update_status: Mutex<updater::UpdateStatus>`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/updater.rs`:

```rust
use serde::Serialize;

/// A fully-downloaded update waiting for the user to restart.
pub struct PendingUpdate {
  pub update: tauri_plugin_updater::Update,
  pub bytes: Vec<u8>,
}

/// Status payload shared with the settings page via the `update-status` event
/// and the `get_update_status` command.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
  /// idle | checking | downloading | ready | upToDate | error
  pub state: String,
  /// Version of the available/downloaded update, when known.
  pub version: Option<String>,
  /// Human-readable error message when state == "error".
  pub message: Option<String>,
}

#[cfg(test)]
mod tests {
  use super::UpdateStatus;

  // The settings page reads these exact JSON keys over IPC — the shape is a
  // wire contract, not an implementation detail.
  #[test]
  fn update_status_serializes_expected_keys() {
    let status = UpdateStatus::new("ready", Some("1.4.0".into()), None);
    let json = serde_json::to_value(&status).unwrap();
    assert_eq!(json["state"], "ready");
    assert_eq!(json["version"], "1.4.0");
    assert_eq!(json["message"], serde_json::Value::Null);
  }

  #[test]
  fn update_status_default_is_idle() {
    let status = UpdateStatus::default();
    assert_eq!(status.state, "idle");
    assert!(status.version.is_none());
  }
}
```

And in `src-tauri/src/lib.rs`, add to the module list (alphabetical, after `mod tray;`):

```rust
mod updater;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src-tauri && cargo test update_status 2>&1 | tail -10
```

Expected: **compile error** — `UpdateStatus::new` and `Default` not defined.

- [ ] **Step 3: Implement `new` and `Default`**

Add to `src-tauri/src/updater.rs` below the struct:

```rust
impl UpdateStatus {
  pub fn new(state: &str, version: Option<String>, message: Option<String>) -> Self {
    Self {
      state: state.into(),
      version,
      message,
    }
  }
}

impl Default for UpdateStatus {
  fn default() -> Self {
    Self::new("idle", None, None)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test update_status 2>&1 | tail -5
```

Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Add the AppState fields**

In `src-tauri/src/state.rs`, add two fields to `AppState` (after `local_model_download`):

```rust
  /// Update downloaded and waiting for the user to restart (tray/settings).
  pub pending_update: Mutex<Option<crate::updater::PendingUpdate>>,
  /// Last known updater status, mirrored to the frontend as `update-status`.
  pub update_status: Mutex<crate::updater::UpdateStatus>,
```

And in `impl Default for AppState`, add to the struct literal:

```rust
      pending_update: Mutex::new(None),
      update_status: Mutex::new(crate::updater::UpdateStatus::default()),
```

- [ ] **Step 6: Run the full test suite**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: all tests pass, no compile errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/updater.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat(updater): UpdateStatus wire type and pending-update app state"
```

---

### Task 4: Check/download/install flow, periodic checks, dynamic tray item

**Files:**
- Modify: `src-tauri/src/updater.rs` (append flow functions)
- Modify: `src-tauri/src/tray.rs` (menu rebuild + update entry)
- Modify: `src-tauri/src/lib.rs` (spawn periodic checks in `setup`)
- Modify: `docs/superpowers/specs/2026-07-13-auto-update-design.md` (two corrections)

**Interfaces:**
- Consumes: Task 3's types/state; Task 2's registered plugin.
- Produces (used by Task 5):
  - `updater::check_and_download(app: &tauri::AppHandle) -> UpdateStatus` (async)
  - `updater::current_status(app: &tauri::AppHandle) -> UpdateStatus`
  - `updater::install_pending_and_restart(app: &tauri::AppHandle) -> Result<(), String>`
  - `updater::spawn_periodic_checks(app: tauri::AppHandle)`
  - `tray::set_update_ready(app: &tauri::AppHandle, version: &str)`
  - Emits `update-status` events (payload: `UpdateStatus`).

- [ ] **Step 1: Append the flow to `src-tauri/src/updater.rs`**

Add these imports at the top of the file (replacing the existing `use serde::Serialize;` line):

```rust
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;
use crate::tray;

/// How long after startup the first automatic check runs.
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(30);
/// Interval between automatic checks while the app stays running.
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
```

Then append below the `Default` impl:

```rust
/// Store the new status and broadcast it to the frontend.
fn set_status(app: &AppHandle, status: UpdateStatus) {
  *app.state::<AppState>().update_status.lock().unwrap() = status.clone();
  let _ = app.emit("update-status", status);
}

pub fn current_status(app: &AppHandle) -> UpdateStatus {
  app.state::<AppState>().update_status.lock().unwrap().clone()
}

/// Check the manifest and, if a newer version exists, download it fully.
/// Returns the final status (also stored + emitted as `update-status`).
pub async fn check_and_download(app: &AppHandle) -> UpdateStatus {
  // Already downloaded and waiting? Don't re-check or re-download.
  // (Clone the version out so the pending_update guard is released before
  // set_status takes the update_status lock.)
  let already_ready = app
    .state::<AppState>()
    .pending_update
    .lock()
    .unwrap()
    .as_ref()
    .map(|pending| pending.update.version.clone());
  if let Some(version) = already_ready {
    let status = UpdateStatus::new("ready", Some(version), None);
    set_status(app, status.clone());
    return status;
  }

  set_status(app, UpdateStatus::new("checking", None, None));

  let checked = match app.updater() {
    Ok(updater) => updater.check().await,
    Err(error) => Err(error),
  };
  let update = match checked {
    Ok(update) => update,
    Err(error) => {
      log::warn!("updater:check-failed error={error}");
      let status = UpdateStatus::new("error", None, Some(error.to_string()));
      set_status(app, status.clone());
      return status;
    }
  };

  let Some(update) = update else {
    let status = UpdateStatus::new("upToDate", None, None);
    set_status(app, status.clone());
    return status;
  };

  let version = update.version.clone();
  log::info!("updater:found version={version}");
  set_status(app, UpdateStatus::new("downloading", Some(version.clone()), None));

  let bytes = match update.download(|_chunk, _total| {}, || {}).await {
    Ok(bytes) => bytes,
    Err(error) => {
      log::warn!("updater:download-failed version={version} error={error}");
      let status = UpdateStatus::new("error", Some(version), Some(error.to_string()));
      set_status(app, status.clone());
      return status;
    }
  };

  *app.state::<AppState>().pending_update.lock().unwrap() =
    Some(PendingUpdate { update, bytes });
  tray::set_update_ready(app, &version);

  let status = UpdateStatus::new("ready", Some(version), None);
  set_status(app, status.clone());
  status
}

/// Install the downloaded update and relaunch. On Windows the installer kills
/// the process itself; on macOS/Linux we restart explicitly.
pub fn install_pending_and_restart(app: &AppHandle) -> Result<(), String> {
  let pending = app
    .state::<AppState>()
    .pending_update
    .lock()
    .unwrap()
    .take()
    .ok_or_else(|| "no update downloaded".to_string())?;

  log::info!("updater:install version={}", pending.update.version);
  if let Err(error) = pending.update.install(&pending.bytes) {
    let message = error.to_string();
    log::error!("updater:install-failed error={message}");
    // Put it back so the user can retry from the tray/settings.
    *app.state::<AppState>().pending_update.lock().unwrap() = Some(pending);
    set_status(app, UpdateStatus::new("error", None, Some(message.clone())));
    return Err(message);
  }
  app.restart();
}

/// Automatic background checks: once shortly after startup, then daily.
/// Stops once an update is downloaded (the user restarts whenever they like).
/// Dev builds never self-update.
pub fn spawn_periodic_checks(app: AppHandle) {
  if cfg!(debug_assertions) {
    return;
  }
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(STARTUP_CHECK_DELAY).await;
    loop {
      let status = check_and_download(&app).await;
      if status.state == "ready" {
        return;
      }
      tokio::time::sleep(PERIODIC_CHECK_INTERVAL).await;
    }
  });
}
```

- [ ] **Step 2: Rework `src-tauri/src/tray.rs` for a rebuildable menu**

Replace the menu-construction block at the top of `create()` (the six lines from `let show = …` through `let menu = Menu::with_items(…)?;`) with:

```rust
  let menu = build_menu(app, None)?;
```

Add these two functions at the bottom of the file:

```rust
/// Build the tray menu; with `update_version` set, a "Restart to update"
/// entry is prepended (tray labels are English-only, like the rest of the menu).
fn build_menu(
  app: &AppHandle,
  update_version: Option<&str>,
) -> tauri::Result<Menu<tauri::Wry>> {
  let menu = Menu::new(app)?;
  if let Some(version) = update_version {
    let install = MenuItem::with_id(
      app,
      "install-update",
      format!("Restart to update to v{version}"),
      true,
      None::<&str>,
    )?;
    menu.append(&install)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
  }
  menu.append(&MenuItem::with_id(app, "show", "Show Main Window", true, None::<&str>)?)?;
  menu.append(&MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?)?;
  menu.append(&PredefinedMenuItem::separator(app)?)?;
  menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
  Ok(menu)
}

/// Swap in a tray menu carrying the "Restart to update to vX.Y.Z" entry.
/// Called by the updater once a download is ready; idempotent.
pub fn set_update_ready(app: &AppHandle, version: &str) {
  let Some(tray) = app.tray_by_id("main-tray") else {
    log::warn!("tray:set-update-ready no tray icon");
    return;
  };
  match build_menu(app, Some(version)) {
    Ok(menu) => {
      if let Err(error) = tray.set_menu(Some(menu)) {
        log::error!("tray:set-update-menu-failed error={error}");
      }
    }
    Err(error) => log::error!("tray:build-update-menu-failed error={error}"),
  }
}
```

Add the menu-event arm in `create()`'s `.on_menu_event` (before the `_ => {}` arm):

```rust
      "install-update" => {
        if let Err(error) = crate::updater::install_pending_and_restart(app) {
          log::error!("tray:install-update-failed error={error}");
        }
      }
```

- [ ] **Step 3: Spawn the periodic checks in `src-tauri/src/lib.rs`**

In the `setup` closure, after the hotkey listener lines (`*app.state::<state::AppState>().hotkey.lock().unwrap() = Some(hotkey_handle);`), add:

```rust
      updater::spawn_periodic_checks(app.handle().clone());
```

- [ ] **Step 4: Verify it compiles and tests pass**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: all tests pass. If `app.tray_by_id` needs a type hint, use `app.tray_by_id("main-tray")` as written — `Manager::tray_by_id` takes `&str`-compatible ids.

- [ ] **Step 5: Correct the spec (two deviations)**

In `docs/superpowers/specs/2026-07-13-auto-update-design.md`:
1. In "Client logic": change `**Dependencies:** \`tauri-plugin-updater\`, \`tauri-plugin-process\` (relaunch).` to `**Dependencies:** \`tauri-plugin-updater\` only — restart is Rust-side \`AppHandle::restart()\`, so \`tauri-plugin-process\` (which only exposes restart to JS) is not needed.`
2. In "Client logic", change the `update-ready` event bullet to: `emit an \`update-status\` event (single channel for all states: idle | checking | downloading | ready | upToDate | error; "ready" carries the version).` Also update the "New events" line to name `update-status` only.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/updater.rs src-tauri/src/tray.rs src-tauri/src/lib.rs docs/superpowers/specs/2026-07-13-auto-update-design.md
git commit -m "feat(updater): background check/download flow, daily re-check, tray restart-to-update entry"
```

---

### Task 5: IPC commands + bridge mapping

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (`invoke_handler!` list)
- Modify: `src/views/ipc-bridge.js`

**Interfaces:**
- Consumes: Task 4's `updater::{check_and_download, current_status, install_pending_and_restart}`.
- Produces (used by Task 6): renderer channels `check-for-updates`, `get-update-status`, `install-update-and-restart` (no arguments; the first two resolve to an `UpdateStatus` JSON object).

- [ ] **Step 1: Add the commands to `src-tauri/src/commands.rs`**

Append at the end of the file:

```rust
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<crate::updater::UpdateStatus, String> {
  log::info!("command:check_for_updates");
  Ok(crate::updater::check_and_download(&app).await)
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> crate::updater::UpdateStatus {
  crate::updater::current_status(&app)
}

#[tauri::command]
pub fn install_update_and_restart(app: AppHandle) -> Result<(), String> {
  log::info!("command:install_update_and_restart");
  crate::updater::install_pending_and_restart(&app)
}
```

(`AppHandle` is already imported at the top of `commands.rs`; verify with `grep -n "use tauri" src-tauri/src/commands.rs` and add `use tauri::AppHandle;` only if missing.)

- [ ] **Step 2: Register in `src-tauri/src/lib.rs`**

In the `invoke_handler!` list, after `commands::delete_local_model,`:

```rust
      commands::check_for_updates,
      commands::get_update_status,
      commands::install_update_and_restart,
```

- [ ] **Step 3: Map the channels in `src/views/ipc-bridge.js`**

In `tauriCommands`, after the `"delete-local-model"` entry:

```js
    "check-for-updates": "check_for_updates",
    "get-update-status": "get_update_status",
    "install-update-and-restart": "install_update_and_restart",
```

(No `tauriArgs` entries — none of the three takes arguments.)

- [ ] **Step 4: Verify compile + tests**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: pass.

- [ ] **Step 5: Verify the command path end-to-end in dev**

```bash
npm run dev
```

Open the Settings window (tray → Settings), open its devtools (right-click → Inspect Element), and in the console run:

```js
await window.__SAYTYPE_IPC__.invoke("get-update-status")
// → {state: "idle", version: null, message: null}
await window.__SAYTYPE_IPC__.invoke("check-for-updates")
```

Expected for `check-for-updates`: `{state: "error", message: …}` where the message indicates the release JSON could not be fetched (HTTP 404) — **this is correct**: the currently published release predates the updater and has no `latest.json` asset (see Global Constraints). The positive path is exercised in Task 8. Quit dev.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/views/ipc-bridge.js
git commit -m "feat(updater): check/status/install IPC commands wired through the bridge"
```

---

### Task 6: Settings-page UI + i18n

**Files:**
- Modify: `src/views/settings.html`
- Modify: `src/views/settings.js`
- Modify: `src/views/i18n.js`

**Interfaces:**
- Consumes: Task 5's channels + the `update-status` event; existing `translate(key, vars)` helper and module-level `ipc` in settings.js; i18n interpolation is single-brace `{version}` (see `formatTemplate` in i18n.js).

- [ ] **Step 1: Add the setting item to `src/views/settings.html`**

In the General section (`#section-general`), immediately after the `setting-item` containing `startMinimizedCheck` (before the two closing `</div>`s that end its `setting-group` and the section), insert:

```html
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-title" data-i18n="settings.updates.title">Software updates</div>
            <div class="setting-description" data-i18n="settings.updates.description">
              New versions download in the background; you choose when to restart.
            </div>
          </div>
          <div class="setting-control">
            <div id="updateStatus" class="permission-status"></div>
            <button class="btn btn-secondary" id="checkUpdatesBtn" data-i18n="settings.updates.check">
              Check for updates
            </button>
            <button class="btn btn-primary hidden" id="installUpdateBtn" data-i18n="settings.updates.restart">
              Restart to update
            </button>
          </div>
        </div>
```

- [ ] **Step 2: Add the strings to `src/views/i18n.js`**

Inside the `settings: { … }` object of the **en** pack (find it with `grep -n "startMinimized" src/views/i18n.js`; add the block as a sibling key):

```js
      updates: {
        title: "Software updates",
        description: "New versions download in the background; you choose when to restart.",
        check: "Check for updates",
        restart: "Restart to update",
        checking: "Checking…",
        downloading: "Downloading v{version}…",
        ready: "v{version} ready — restart to update",
        upToDate: "v{version} — up to date",
        error: "Update check failed: {message}",
      },
```

And in the **zh** pack's `settings` object:

```js
      updates: {
        title: "软件更新",
        description: "新版本会在后台自动下载,由你决定何时重启生效。",
        check: "检查更新",
        restart: "重启并更新",
        checking: "正在检查…",
        downloading: "正在下载 v{version}…",
        ready: "v{version} 已就绪 — 重启即可更新",
        upToDate: "v{version} — 已是最新",
        error: "检查更新失败:{message}",
      },
```

- [ ] **Step 3: Add the panel logic to `src/views/settings.js`**

Near the other module-level flags (after `let localModelSyncBound = false;`), add:

```js
let updatesPanelBound = false;
let currentAppVersion = "";
```

After the `setupLocalModelSync()` function definition, add:

```js
function renderUpdateStatus(status) {
  const statusEl = document.getElementById("updateStatus");
  const checkBtn = document.getElementById("checkUpdatesBtn");
  const installBtn = document.getElementById("installUpdateBtn");
  if (!statusEl || !checkBtn || !installBtn) {
    return;
  }

  const state = status?.state || "idle";
  const version = status?.version || "";
  checkBtn.disabled = state === "checking" || state === "downloading";
  checkBtn.classList.toggle("hidden", state === "ready");
  installBtn.classList.toggle("hidden", state !== "ready");

  if (state === "checking") {
    statusEl.textContent = translate("settings.updates.checking");
  } else if (state === "downloading") {
    statusEl.textContent = translate("settings.updates.downloading", { version });
  } else if (state === "ready") {
    statusEl.textContent = translate("settings.updates.ready", { version });
  } else if (state === "error") {
    statusEl.textContent = translate("settings.updates.error", { message: status?.message || "" });
  } else if (state === "upToDate") {
    statusEl.textContent = translate("settings.updates.upToDate", { version: currentAppVersion });
  } else {
    statusEl.textContent = currentAppVersion ? `v${currentAppVersion}` : "";
  }
}

async function refreshUpdateStatus() {
  try {
    renderUpdateStatus(await ipc.invoke("get-update-status"));
  } catch {
    renderUpdateStatus({ state: "idle" });
  }
}

async function setupUpdatesPanel() {
  if (updatesPanelBound || !ipc) {
    return;
  }
  updatesPanelBound = true;

  ipc.on("update-status", (_event, payload) => {
    if (payload) {
      renderUpdateStatus(payload);
    }
  });

  document.getElementById("checkUpdatesBtn")?.addEventListener("click", async () => {
    try {
      renderUpdateStatus(await ipc.invoke("check-for-updates"));
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  document.getElementById("installUpdateBtn")?.addEventListener("click", async () => {
    try {
      await ipc.invoke("install-update-and-restart");
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  try {
    currentAppVersion = await ipc.invoke("get-app-version");
  } catch {
    currentAppVersion = "";
  }
  await refreshUpdateStatus();
}
```

In `bootstrapSettingsPage()`, after the `setupLocalModelSync();` line, add:

```js
    void setupUpdatesPanel();
```

In `handleUiLanguageChange()`, after `void checkAccessibilityStatus();`, add (re-renders the status line in the new language):

```js
  void refreshUpdateStatus();
```

- [ ] **Step 4: Verify in dev**

```bash
npm run dev
```

Settings → General: the "Software updates" item shows the status line `v1.3.5` (current version). Click "Check for updates" → status becomes "Checking…" then the error text (404 — expected pre-first-release, see Global Constraints). Switch UI language to 中文 → labels re-render ("检查更新" etc.). Quit dev.

- [ ] **Step 5: Commit**

```bash
git add src/views/settings.html src/views/settings.js src/views/i18n.js
git commit -m "feat(updater): settings-page update panel with manual check (EN/中文)"
```

---

### Task 7: Release workflow — 3-platform matrix + updater manifest

**Files:**
- Modify: `.github/workflows/release.yml` (full rewrite below)

**Interfaces:**
- Consumes: Task 1's GitHub secrets; Task 2's `src-tauri/tauri.release.conf.json`.
- Produces: on every `v*` tag, a draft release carrying DMG/EXE/MSI/AppImage/deb/rpm + updater artifacts + merged `latest.json`.

- [ ] **Step 1: Replace `.github/workflows/release.yml` with:**

```yaml
name: Release

# 推送形如 v1.0.90 的 tag 时触发:三平台矩阵构建(macOS 通用二进制 DMG 签名+公证,
# Windows NSIS/MSI,Linux AppImage/deb/rpm),生成 minisign 签名的更新产物与合并的
# latest.json,创建 GitHub Release(草稿)。手动 Publish 后自动更新端点才会看到新版。
on:
  push:
    tags:
      - "v*"

jobs:
  release:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            label: macOS
            rust-targets: aarch64-apple-darwin,x86_64-apple-darwin
            build-args: --target universal-apple-darwin --config src-tauri/tauri.release.conf.json
          - os: windows-latest
            label: Windows
            rust-targets: x86_64-pc-windows-msvc
            build-args: --target x86_64-pc-windows-msvc --config src-tauri/tauri.release.conf.json
          - os: ubuntu-22.04
            label: Linux
            rust-targets: x86_64-unknown-linux-gnu
            build-args: --target x86_64-unknown-linux-gnu --config src-tauri/tauri.release.conf.json
    name: Release (${{ matrix.label }})
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write # 允许 tauri-action 创建 Release 并上传产物

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rust-targets }}

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: "./src-tauri -> target"

      # Tauri 2 Linux build prerequisites — same list as ci.yml (see there for
      # the per-package rationale).
      - name: Install Linux system dependencies
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf \
            libxdo-dev \
            libxkbcommon-dev \
            libx11-dev \
            libxtst-dev \
            build-essential \
            curl wget file libssl-dev pkg-config

      - name: Install JS tooling (@tauri-apps/cli)
        run: npm ci

      - name: Configure Apple signing
        if: matrix.os == 'macos-latest'
        # Signing/notarization only happen when a certificate secret is present.
        # We inject the APPLE_* vars into the environment ONLY in that case, so
        # that when the secrets are absent tauri-cli sees no APPLE_* vars at all
        # and cleanly produces an UNSIGNED build instead of crashing on an empty
        # certificate. Adding the secrets later enables signing with no code change.
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          if [ -n "$APPLE_CERTIFICATE" ]; then
            echo "Apple certificate present — build will be signed and notarized."
            # Certificate is multi-line base64, so use a heredoc delimiter.
            {
              echo "APPLE_CERTIFICATE<<__SAYTYPE_CERT_EOF__"
              echo "$APPLE_CERTIFICATE"
              echo "__SAYTYPE_CERT_EOF__"
              echo "APPLE_CERTIFICATE_PASSWORD=$APPLE_CERTIFICATE_PASSWORD"
              echo "APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY"
              echo "APPLE_ID=$APPLE_ID"
              echo "APPLE_PASSWORD=$APPLE_PASSWORD"
              echo "APPLE_TEAM_ID=$APPLE_TEAM_ID"
            } >> "$GITHUB_ENV"
          else
            echo "::warning::No APPLE_CERTIFICATE secret configured — producing an UNSIGNED, not notarized build. Add the Apple signing secrets to enable signing/notarization."
          fi

      - name: Build, sign & publish release
        uses: tauri-apps/tauri-action@v0
        # APPLE_* vars come from the "Configure Apple signing" step (macOS leg
        # only, and only when the secrets exist). TAURI_SIGNING_* signs the
        # updater artifacts (minisign) on every leg — required because
        # tauri.release.conf.json sets createUpdaterArtifacts.
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          # 版本号由提交中的 Cargo.toml / tauri.conf.json 决定
          args: ${{ matrix.build-args }}
          # 用触发的 tag 作为 Release 的 tag 与标题
          tagName: ${{ github.ref_name }}
          releaseName: "SayType ${{ github.ref_name }}"
          releaseBody: "下载对应平台的安装包。"
          # 先建草稿,确认无误后在 Release 页面手动点 Publish —— 这同时是
          # 自动更新的发布闸门(latest.json 只有 Publish 后才对客户端可见)。
          releaseDraft: true
          prerelease: false
          # 生成并合并 latest.json(自动更新清单);Windows 以 NSIS .exe 为准。
          includeUpdaterJson: true
          updaterJsonPreferNsis: true

  release-notes:
    # Fills the draft release body with AI-generated bilingual notes covering
    # <previous v* tag>..<this tag>. Missing secret or any failure -> warning,
    # the release itself never breaks. Runs once, after all matrix legs, so the
    # notes edit never races an asset upload.
    needs: release
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # Full history + tags: release-notes generation diffs against the previous tag
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Generate release notes
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::warning::No ANTHROPIC_API_KEY secret — release keeps the default body."
            exit 0
          fi
          if node scripts/generate-release-notes.mjs "${GITHUB_REF_NAME}" > notes.md; then
            gh release edit "${GITHUB_REF_NAME}" --notes-file notes.md
            echo "Release notes updated for ${GITHUB_REF_NAME}."
          else
            echo "::warning::Release-notes generation failed — release keeps the default body."
          fi
```

- [ ] **Step 2: Review the diff against the old workflow**

```bash
git diff .github/workflows/release.yml
```

Check specifically: (a) the Apple-signing step gained `if: matrix.os == 'macos-latest'` and is otherwise byte-identical; (b) the notes job body is byte-identical to the old step; (c) every leg passes `--config src-tauri/tauri.release.conf.json`; (d) `TAURI_SIGNING_*` env on the tauri-action step. There is no local runner for this file — real validation is the next tag push (safe: the release stays a draft).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): 3-platform matrix with signed updater artifacts and latest.json"
```

---

### Task 8: macOS end-to-end verification via localhost manifest

**Files:** none committed (scratch only). Uses `src-tauri/tauri.updater-e2e.conf.json` from Task 2.

**Interfaces:**
- Consumes: everything from Tasks 1–6; `scripts/sign.env` with both Apple + updater keys.
- Produces: verified update chain on a real machine (check → download → tray entry → install → relaunch as new version, permissions intact).

> ⚠️ This task replaces `/Applications/SayType.app` and temporarily bumps version files. Both are restored at the end. Do not run `scripts/collect-artifacts.js` here — it would overwrite the archived real installer in `dist/`.

- [ ] **Step 1: Quit the running SayType and build+install the "old" e2e build (current version, localhost endpoint)**

```bash
osascript -e 'quit app "SayType"' 2>/dev/null; sleep 1
CI=true sh -c '. ./scripts/sign.env; npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.updater-e2e.conf.json'
rm -rf /Applications/SayType.app
cp -R src-tauri/target/aarch64-apple-darwin/release/bundle/macos/SayType.app /Applications/
```

Expected: build succeeds (updater artifacts signed — proves the key/env wiring), app copied.

- [ ] **Step 2: Bump the version locally (NOT committed) and build the "new" version**

```bash
npm run version:tauri:patch
CI=true sh -c '. ./scripts/sign.env; npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.updater-e2e.conf.json'
ls src-tauri/target/aarch64-apple-darwin/release/bundle/macos/ | grep tar.gz
```

Expected: `SayType.app.tar.gz` and `SayType.app.tar.gz.sig` exist. Note the new version number (`grep '"version"' src-tauri/tauri.conf.json`).

- [ ] **Step 3: Stage the manifest + archive and serve on :8765**

(Use the session scratchpad dir; `<NEW_VERSION>` = the bumped version, e.g. `1.3.6`.)

```bash
STAGE=/private/tmp/claude-501/-Users-tao-code-OpenClaw-Code-SayType/9e314248-a722-4b0f-bd5f-59680cd221f2/scratchpad/updater-e2e
mkdir -p "$STAGE"
cp src-tauri/target/aarch64-apple-darwin/release/bundle/macos/SayType.app.tar.gz "$STAGE/"
node -e '
const fs = require("fs");
const [sigPath, version, out] = process.argv.slice(1);
fs.writeFileSync(out, JSON.stringify({
  version,
  notes: "e2e test",
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: "http://127.0.0.1:8765/SayType.app.tar.gz",
    },
  },
}, null, 2));
' src-tauri/target/aarch64-apple-darwin/release/bundle/macos/SayType.app.tar.gz.sig <NEW_VERSION> "$STAGE/latest.json"
cd "$STAGE" && python3 -m http.server 8765
```

(Leave the server running; do the next step in another shell.)

- [ ] **Step 4: Restore the version files, then run the update flow**

```bash
git checkout -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
open /Applications/SayType.app
```

In the app: Settings → General → "Check for updates". Verify, in order:
1. Status: checking → downloading → "v<NEW_VERSION> 已就绪" (or EN equivalent); the "Restart to update" button appears.
2. Tray menu now has "Restart to update to v<NEW_VERSION>" at the top.
3. Click the tray entry (or the settings button) → app quits and relaunches.
4. Main window footer shows the NEW version (`#appVersion`).
5. Dictation still works without new permission prompts (Accessibility/Microphone grants survived — stable signing identity).

- [ ] **Step 5: Clean up — stop the server, reinstall the real build**

```bash
# Ctrl+C the http.server, then:
npm run build:mac:install
```

Expected: the installed app is back on the real GitHub endpoint config, correct (un-bumped) version.

- [ ] **Step 6: Record the result**

No commit (nothing changed). If any step failed, fix the code task it points at before proceeding; re-run this task after fixes.

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md` — only if it documents release/install steps (check first; skip otherwise)

**Interfaces:**
- Consumes: everything shipped above.

- [ ] **Step 1: Update `CLAUDE.md`**

1. In the **Release signing & notarization** intro, note that release builds also produce minisign-signed updater artifacts + `latest.json`, and that the workflow is now a 3-platform matrix (macOS signed+notarized; Windows/Linux unsigned, unverified on real machines).
2. In the **GitHub repo secrets** table, add two rows:

```markdown
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/saytype-updater.key` (updater minisign key; **back up — lost key = clients can never auto-update**) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the updater key password |
```

3. In **Cutting a release**, add after the draft-review sentence: publishing the draft is also the auto-update rollout gate — installed clients (from the first updater-equipped version onward) poll `releases/latest/download/latest.json` daily and auto-download, offering "Restart to update" in the tray + settings.
4. In **Architecture Overview → Rust backend**, add a `updater.rs` bullet:

```markdown
- `updater.rs` — auto-update: daily background check of the GitHub Releases
  `latest.json` (skipped in debug builds), silent download, `update-status`
  events; install+restart on user action (tray "Restart to update" entry /
  settings button). `createUpdaterArtifacts` lives only in
  `tauri.release.conf.json` (CI) and `tauri.updater-e2e.conf.json` (localhost
  e2e harness, see the plan) so local builds never require the minisign key.
```

- [ ] **Step 2: Check README**

```bash
grep -n -i "release\|install\|download" README.md | head
```

If it documents installation/releases, add one line that the app self-updates from GitHub Releases; otherwise skip.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: auto-update — new secrets, updater.rs module, publish-as-rollout-gate"
```

---

## Live-fire checklist (first real release, run by the user)

Not a plan task — the runbook for the first updater-equipped release:

1. `npm run version:tauri:patch` → commit → `git tag vX.Y.Z && git push origin main --tags`.
2. Watch the three matrix legs; on the draft release verify assets include: DMG, `SayType.app.tar.gz(.sig)`, NSIS `.exe(.sig)`, MSI, `.AppImage(.sig)`, deb/rpm, and **`latest.json` containing `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64` entries**.
3. Publish the draft. Install this version manually (bootstrap: it's the first version that can self-update).
4. On the *next* release, verify the installed app picks it up within a day (or via the settings button) and updates cleanly.
