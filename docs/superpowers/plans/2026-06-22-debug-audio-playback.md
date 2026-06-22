# Debug 录音回放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use `- [ ]` for tracking.

**Goal:** 开发构建下,在 history 每条旁加 ▶ 播放按钮,回放发给 OpenAI 的原始录音,用于诊断"开头吞字"出在录音层还是模型层。

**Architecture:** 转录前 dev-gate 地 clone 一份 audio_buffer;`append_activity` 用条目 id 把音频写到 `<appdata>/debug-audio/<id>.<ext>` 并在条目记 `audioId`/`audioMime`;新命令 `read_debug_audio` 读回字节;前端 `buildActivityRow` 在 dev 下加播放按钮。文件 IO 抽到 `history.rs` 的 `_in(dir,...)` 纯函数以便单测。

**Tech Stack:** Rust (Tauri 2, serde_json, chrono), 原生前端 JS。

## Global Constraints

- **Dev-only**:后端 `cfg!(debug_assertions)`,前端 `isDev`。生产构建不存音频、不显示按钮。
- **IPC 三处登记**:`commands.rs` + `lib.rs` invoke_handler + `ipc-bridge.js`(见 CLAUDE.md)。
- **mime→ext**:`contains("mp4")`→`m4a`,否则→`webm`。**ext→mime**:`m4a`→`audio/mp4`,否则→`audio/webm`。
- **清理 best-effort**:删除时忽略"文件不存在"类错误。
- 不记录 API key / 转录文本到日志;音频是附属物,存/读失败不得影响转录与 history。

---

### Task 1: history.rs — debug-audio 文件 IO(纯函数 + 单测)

**Files:**
- Modify: `src-tauri/src/history.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces — Produces:**
- `ext_for_mime(mime: &str) -> &'static str`
- `write_debug_audio_in(dir: &Path, id: &str, bytes: &[u8], mime: &str) -> Result<()>`
- `read_debug_audio_in(dir: &Path, id: &str) -> Result<(Vec<u8>, String)>`
- `delete_debug_audio_in(dir: &Path, id: &str) -> Result<()>`
- `clear_debug_audio_in(dir: &Path) -> Result<()>`

- [ ] **Step 1: 写失败测试**(往返 + 删除 + 清空)

```rust
#[test]
fn debug_audio_roundtrip_and_cleanup() {
    let temp = TempDir::new().unwrap();
    let dir = temp.path();
    write_debug_audio_in(dir, "100", &[1, 2, 3], "audio/mp4").unwrap();
    let (bytes, mime) = read_debug_audio_in(dir, "100").unwrap();
    assert_eq!(bytes, vec![1, 2, 3]);
    assert_eq!(mime, "audio/mp4");           // m4a -> audio/mp4
    assert!(dir.join("100.m4a").exists());

    delete_debug_audio_in(dir, "100").unwrap();
    assert!(read_debug_audio_in(dir, "100").is_err());
    delete_debug_audio_in(dir, "missing").unwrap();   // best-effort, no error

    write_debug_audio_in(dir, "1", &[9], "audio/webm").unwrap();
    clear_debug_audio_in(dir).unwrap();
    assert!(read_debug_audio_in(dir, "1").is_err());
}
```

- [ ] **Step 2: 运行确认失败** — `cd src-tauri && cargo test debug_audio_roundtrip` → FAIL（函数未定义）

- [ ] **Step 3: 实现**(加到 `history.rs`,`use std::path::PathBuf;` 已在 `Path` 旁；新增 `use std::fs;` 已存在)

```rust
pub fn ext_for_mime(mime: &str) -> &'static str {
    if mime.contains("mp4") { "m4a" } else { "webm" }
}

fn mime_for_ext(ext: &str) -> String {
    if ext == "m4a" { "audio/mp4".into() } else { "audio/webm".into() }
}

pub fn write_debug_audio_in(dir: &Path, id: &str, bytes: &[u8], mime: &str) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("failed to create {}", dir.display()))?;
    let path = dir.join(format!("{id}.{}", ext_for_mime(mime)));
    fs::write(&path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

pub fn read_debug_audio_in(dir: &Path, id: &str) -> Result<(Vec<u8>, String)> {
    for ext in ["m4a", "webm"] {
        let path = dir.join(format!("{id}.{ext}"));
        if path.exists() {
            let bytes = fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
            return Ok((bytes, mime_for_ext(ext)));
        }
    }
    anyhow::bail!("no debug audio for id {id}")
}

pub fn delete_debug_audio_in(dir: &Path, id: &str) -> Result<()> {
    for ext in ["m4a", "webm"] {
        let path = dir.join(format!("{id}.{ext}"));
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

pub fn clear_debug_audio_in(dir: &Path) -> Result<()> {
    if dir.exists() {
        let _ = fs::remove_dir_all(dir);
    }
    Ok(())
}
```

- [ ] **Step 4: 运行通过** — `cargo test debug_audio_roundtrip` → PASS
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(debug): debug-audio file IO in history.rs"`

---

### Task 2: settings.rs — `debug_audio_dir()` + history public wrappers

**Files:**
- Modify: `src-tauri/src/settings.rs`(在 `history_path` 旁)
- Modify: `src-tauri/src/history.rs`(public wrappers)

**Interfaces — Consumes:** `settings::app_data_dir()`. **Produces:** `settings::debug_audio_dir() -> Result<PathBuf>`; `history::{write_debug_audio, read_debug_audio, delete_debug_audio, clear_debug_audio}`.

- [ ] **Step 1: settings.rs 加目录助手**

```rust
pub fn debug_audio_dir() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("debug-audio"))
}
```

- [ ] **Step 2: history.rs 加 wrappers**(委托 `_in`,目录用 `settings::debug_audio_dir()`)

```rust
pub fn write_debug_audio(id: &str, bytes: &[u8], mime: &str) -> Result<()> {
    write_debug_audio_in(&settings::debug_audio_dir()?, id, bytes, mime)
}
pub fn read_debug_audio(id: &str) -> Result<(Vec<u8>, String)> {
    read_debug_audio_in(&settings::debug_audio_dir()?, id)
}
pub fn delete_debug_audio(id: &str) -> Result<()> {
    delete_debug_audio_in(&settings::debug_audio_dir()?, id)
}
pub fn clear_debug_audio() -> Result<()> {
    clear_debug_audio_in(&settings::debug_audio_dir()?)
}
```

- [ ] **Step 3:** `cargo build` 通过(无新测试,wrappers 是 IO 包装)
- [ ] **Step 4: Commit** — `git commit -am "feat(debug): debug_audio_dir + history wrappers"`

---

### Task 3: commands.rs — 存音频(append_activity 扩参 + transcribe_audio clone + truncate 清理)

**Files:**
- Modify: `src-tauri/src/commands.rs`(`transcribe_audio` 入口/分支、`append_activity` ~447-464)

**Interfaces — Consumes:** Task 2 history wrappers. **Produces:** `append_activity(text, success, error, audio: Option<(Vec<u8>, String)>)`.

- [ ] **Step 1:** `transcribe_audio` 入口处,`audio_buffer` 被 move 前 clone(dev gate)

```rust
let mime = mime_type.clone().unwrap_or_else(|| "audio/webm".into());
let audio_for_debug =
    cfg!(debug_assertions).then(|| (audio_buffer.clone(), mime.clone()));
```
（注:现有代码在 select 里直接传 `mime_type.unwrap_or_else(...)`;改为先取 `mime` 变量复用。）

- [ ] **Step 2:** 成功分支 `append_activity(&text, true, None, audio_for_debug)`;失败分支 `append_activity(&message, false, Some(error.to_string()), audio_for_debug)`。
  （`audio_for_debug` 只会走其中一条分支,所有权 move 进去即可。）

- [ ] **Step 3:** 改 `append_activity`,生成 id 后存音频、写字段、truncate 时清理被挤出者

```rust
fn append_activity(
    text: &str,
    success: bool,
    error: Option<String>,
    audio: Option<(Vec<u8>, String)>,
) -> Result<()> {
    let mut entries = history::read_history_entries()?;
    let id = Utc::now().timestamp_millis().to_string();
    let mut entry = json!({
        "id": id, "text": text, "timestamp": Utc::now().to_rfc3339(),
        "success": success, "error": error,
    });
    if let Some((bytes, mime)) = audio {
        if let Err(e) = history::write_debug_audio(&id, &bytes, &mime) {
            log::warn!("failed to save debug audio: {e:#}");
        } else {
            entry["audioId"] = json!(id);
            entry["audioMime"] = json!(mime);
        }
    }
    entries.insert(0, entry);
    if entries.len() > 100 {
        for dropped in &entries[100..] {
            if let Some(aid) = dropped.get("audioId").and_then(Value::as_str) {
                let _ = history::delete_debug_audio(aid);
            }
        }
        entries.truncate(100);
    }
    history::write_history_entries(&entries)?;
    Ok(())
}
```
（确认 `commands.rs` 顶部已 `use serde_json::{json, Value};` 或等价;若缺 `Value` 则补。）

- [ ] **Step 4:** `cargo test` 全绿(现有测试不受影响)
- [ ] **Step 5: Commit** — `git commit -am "feat(debug): persist original audio per transcription (dev)"`

---

### Task 4: read_debug_audio 命令 + 注册

**Files:**
- Modify: `src-tauri/src/commands.rs`(新命令)、`src-tauri/src/lib.rs`(invoke_handler)、`src/views/ipc-bridge.js`(tauriCommands + tauriArgs)

**Interfaces — Produces:** Tauri 命令 `read_debug_audio(id) -> { bytes: Vec<u8>, mime: String }`(序列化为 `{bytes, mime}`)。

- [ ] **Step 1:** commands.rs 加命令

```rust
#[derive(serde::Serialize)]
pub struct DebugAudio { pub bytes: Vec<u8>, pub mime: String }

#[tauri::command]
pub fn read_debug_audio(id: String) -> Result<DebugAudio, String> {
    let (bytes, mime) = history::read_debug_audio(&id).map_err(stringify_error)?;
    Ok(DebugAudio { bytes, mime })
}
```

- [ ] **Step 2:** lib.rs 的 `invoke_handler![... ]` 列表加 `read_debug_audio`。
- [ ] **Step 3:** ipc-bridge.js:`tauriCommands` 加 `"read-debug-audio": "read_debug_audio"`;`tauriArgs` 加 `"read-debug-audio": [["id"]]`。
- [ ] **Step 4:** `cargo build` 通过。
- [ ] **Step 5: Commit** — `git commit -am "feat(debug): read_debug_audio command + ipc"`

---

### Task 5: 删除/清空时清理音频

**Files:**
- Modify: `src-tauri/src/commands.rs`(`delete_history_item` ~382、`clear_history` ~390)

- [ ] **Step 1:** `delete_history_item`:删 history 条目后,`let _ = history::delete_debug_audio(&id);`
- [ ] **Step 2:** `clear_history`:清 history 后,`let _ = history::clear_debug_audio();`
- [ ] **Step 3:** `cargo test` 全绿。
- [ ] **Step 4: Commit** — `git commit -am "feat(debug): clean up audio on delete/clear"`

---

### Task 6: 前端播放按钮 + i18n

**Files:**
- Modify: `src/views/main.js`(`buildActivityRow` ~358-395)、`src/views/i18n.js`(en + zh `activity.playTitle`)

**Interfaces — Consumes:** ipc `read-debug-audio`;`isDev`(main.js 中既有的 dev 标志,确认其来源,若无则从 `get-settings` 的 `isDev` 取并缓存)。

- [ ] **Step 1:** 确认 main.js 是否已有 `isDev`;若无,在初始化(`get-settings` 处)缓存 `isDev`。
- [ ] **Step 2:** `buildActivityRow` 内,copy 按钮之前/之后插入:

```js
if (isDev && activity.audioId) {
  const playBtn = document.createElement("button");
  playBtn.className = "icon-btn";            // 沿用 copy/delete 的类名
  playBtn.title = t("activity.playTitle");
  playBtn.setAttribute("aria-label", t("activity.playTitle"));
  playBtn.innerHTML = '<span class="material-icons">play_arrow</span>';
  playBtn.addEventListener("click", async () => {
    try {
      const res = await ipc.invoke("read-debug-audio", activity.audioId);
      const blob = new Blob([new Uint8Array(res.bytes)], { type: res.mime });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
    } catch (e) {
      console.error("debug audio playback failed:", e);
    }
  });
  actions.appendChild(playBtn);
}
```
（确认 copy/delete 用的真实类名,playBtn 沿用;`actions` 即现有 `activity-actions` 容器。）

- [ ] **Step 3:** i18n.js 两处加 `activity.playTitle`(en: "Play recording (debug)"、zh: "播放录音(调试)")。
- [ ] **Step 4: 手动验证(dev)** — `npm run dev`:① 录一段→列表出现 ▶→点击听到**完整开头**;② 触发失败转录(如断网)→该条也能播放;③ 删除单条→再点其它条仍正常;④ Clear all→无报错。
- [ ] **Step 5: Commit** — `git commit -am "feat(debug): play button for recordings in history"`

---

## Self-Review

- **Spec coverage:** 存储(T1–T3)、条目字段(T3)、read 命令(T4)、UI 播放(T6)、清理 truncate/delete/clear(T3/T5)、IPC 三处(T4)、dev gate 前后端(T3/T6)、成功+失败都存(T3 Step 2)、测试(T1 单测 + T6 手动)。全覆盖。
- **Placeholder scan:** 无 TBD;每段含真实代码。两处"确认"标注(commands.rs 的 `Value` import、main.js 的 `isDev`/类名)是执行时的实读核对点,非占位。
- **Type consistency:** `audioId`/`audioMime` 全程一致;`DebugAudio{bytes,mime}` 与前端 `res.bytes`/`res.mime` 对应;`ext_for_mime`/`mime_for_ext` 互逆。
