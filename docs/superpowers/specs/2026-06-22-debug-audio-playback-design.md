# Debug 录音回放 — 设计文档

- 日期:2026-06-22
- 状态:已通过 brainstorm,待 review
- 关联:用于诊断"开头吞字 / 识别质量差"出在录音层还是模型层;是后续"录音就绪门(reveal-on-first-audio)"改动的前置验证工具。

## 1. 目标

开发阶段能直接听到每次录音的**原始音频**(即发给 OpenAI 的那一份字节,未经任何处理),从而一刀切开:开头真丢了 = 录音问题;音频里字都在、只是没转出来 = 模型问题。在 history 每条旁加一个 ▶ 播放按钮。

## 2. 范围

- **仅开发构建**:后端用 `cfg!(debug_assertions)` gate,前端用 `isDev` gate。生产版完全不存音频、不显示播放按钮。
- **成功与失败的转录都存**音频 —— 失败/吞字的那条最需要回放。
- 非目标(YAGNI):生产启用、音频转码/压缩、波形显示、跨设备同步、播放进度条。

## 3. 数据流

```
录音(前端) → audio_buffer → transcribe_audio(后端)
  1. dev: clone 一份 audio_buffer + mime(在它被 move 进转录请求之前)
  2. 正常转录(成功或失败)
  3. append_activity 生成 id → 用同一 id 把音频写到 debug-audio/<id>.<ext>
     → 条目加 audioId + audioMime
  4. main 窗口渲染:isDev 且有 audioId → 显示 ▶
  5. 点 ▶ → read_debug_audio(id) → Blob → <audio> 播放
```

## 4. 详细设计

### 4.1 存储(后端)
- 新增 `settings::debug_audio_dir()` → `<appdata>/debug-audio/`(复用 history 同级目录)。
- `transcribe_audio` 入口:`let audio_for_debug = cfg!(debug_assertions).then(|| (audio_buffer.clone(), mime.clone()));`,在 `audio_buffer` 被 move 进 `perform_transcription_request` 之前 clone。
- `append_activity` 签名扩展为 `append_activity(text, success, error, audio: Option<(Vec<u8>, String)>)`。内部生成 `id` 后,若 `audio` 为 `Some((bytes, mime))`:由 mime 推断扩展名(mp4→m4a,否则 webm),写 `debug-audio/<id>.<ext>`,并在条目写入 `"audioId": id`、`"audioMime": mime`。
- 两个调用点(成功 [commands.rs:201](../../../src-tauri/src/commands.rs#L201)、失败 [commands.rs:216](../../../src-tauri/src/commands.rs#L216))都把 `audio_for_debug` 传进去。

### 4.2 history 条目
新增可选字段 `audioId`(= 条目 id)、`audioMime`。旧条目无此字段 → 前端不显示 ▶。结构其余不变。

### 4.3 命令 `read_debug_audio`
`read_debug_audio(id: String) -> Result<DebugAudio, String>`,`DebugAudio { bytes: Vec<u8>, mime: String }`。从 `debug-audio/` 找 `<id>.*` 读出。找不到 → `Err`。

### 4.4 前端播放
- `ipc-bridge.js` 注册 `read-debug-audio`。
- `main.js` 的 `buildActivityRow`:若 `isDev` 且 `activity.audioId`,在 copy/delete 旁加 ▶ 按钮。点击:`invoke("read-debug-audio", id)` → `Uint8Array` → `Blob(mime)` → `URL.createObjectURL` → `new Audio(url).play()`;播放结束 `revokeObjectURL`。每次点击新建 Audio 播放(无需暂停/进度逻辑)。

### 4.5 清理(不让音频无限堆积)
- `append_activity` 在 `truncate(100)` 时,收集被移除条目的 `audioId`,删对应文件。
- `delete_history_item`:删条目后删其音频文件。
- `clear_history`:清空 `debug-audio/` 目录。
- 所有删除 best-effort(文件不存在等错误忽略)。

### 4.6 IPC 注册(遵循 CLAUDE.md 的"三处")
- `commands.rs`:`#[tauri::command] read_debug_audio`
- `lib.rs`:`invoke_handler!` 列表
- `ipc-bridge.js`:`tauriCommands` + `tauriArgs`

## 5. 错误处理
- 存音频失败(dev):`log::warn!`,不影响转录与 history(音频是附属物)。
- `read_debug_audio` 找不到文件:返回 `Err`,前端 toast/状态提示"音频不存在"。
- 清理失败:忽略(best-effort)。

## 6. 测试
- 手动(dev):① 录一段 → ▶ → 听到**完整开头**;② 故意触发失败转录 → 也能播放;③ delete 单条 → 音频文件消失;④ clear all → 目录清空;⑤ 录 >100 条 → 最老的音频被清。
- 单测:若清理逻辑落在 `history.rs`,补一条"删除条目时清理音频文件"的测试(沿用现有 `TempDir` 模式)。
