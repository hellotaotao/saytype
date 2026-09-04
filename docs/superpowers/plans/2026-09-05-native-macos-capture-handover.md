# Handover: macOS native audio capture (WKWebView 3.0 s attenuation)

**Date:** 2026-09-05
**State:** one real bug found and mitigated; a native-capture replacement is proven
in a spike but not wired in. Commits `1a49a8a`, `22d8942`, `f7c879f`, `9c58b57` — none pushed.
**Audience:** whoever picks this up next.

---

## 0. Read this part first

This document was written by the agent that did the investigation. It contains
**three conclusions that turned out to be wrong** and were only caught because the
user pushed back. Treat the plan in §6 as a hypothesis, not an instruction.

**Before implementing anything, re-derive the core claim yourself.** It is cheap:
§3 gives the exact commands. If your measurement disagrees with §2, trust your
measurement and rewrite this document.

The single most useful lesson from this session, which caused *every* error in it
including the original bug in v1.3.0:

> **Measure the quantity that matters, not the one that is easy to measure.**
> This bug hid for three months behind a latency measurement, then survived two
> more wrong diagnoses from me, because at each step someone measured timing when
> they should have measured signal level, or level when they should have measured
> SNR.

---

## 1. The user-visible problem

SayType is a hold-to-dictate app. The user reported, on an **M1 MacBook Air with its
built-in microphone**:

- Press the hotkey, start speaking → **the first ~3 seconds are missing from the
  transcript**.
- During those 3 seconds the **waveform display also barely moves**; from about the
  4th second it animates normally.
- **Every single time**, not intermittent. Resets on each new recording.
- **Not reproducible** on Windows, and reportedly not on their Mac mini M4.
- The user believes older versions did not have this. **They are right** — see §5.

---

## 2. What is actually true (measured, reproducible)

### 2.1 The one real defect

**A fresh WKWebView `getUserMedia` stream is attenuated ~32 dB for exactly its
first 3.0 seconds, then steps to full level.**

Measured with a constant 440 Hz reference tone played through the speakers, at
three output volumes, two repetitions each — six runs, all consistent:

| output volume | during 0–3.0 s | after 3.0 s | gap |
|---|---|---|---|
| 25 | −66, −66 | −34, −33 | 32 dB |
| 50 | −58, −58 | −26, −25 | 32 dB |
| 90 | −47, −47 | −15, −16 | 31 dB |

The during-window level **tracks the source**, so the signal is attenuated, not
muted. The boundary lands consistently inside the 3.0–3.5 s bucket.

### 2.2 It is WebKit's capture path, not the device

Same machine, same microphone, same tone, same output volume (85), only the
capture API changed:

```
WKWebView getUserMedia:
  env_db = -52,-48,-48,-48,-48,-48, | -30 | -16,-17,-17,-17,-17,-17
  snr_db =  -5,-32,-32,-31,-32,  0, |  -9 |  21, 22, 22, 22, 22, 22

native cpal / CoreAudio:
  env_db = -18,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17,-17
  snr_db =   7, 24, 24, 25, 25, 25, 25, 25, 25, 24, 24, 24, 24, 24, 24, 24
```

Two things make this comparison trustworthy: the **steady states agree**
(−17 vs −16/−17 env, +24 vs +21/22 SNR), so it is the same signal chain once
WebKit recovers; and **cold and warm native opens read identically**, so native
needs no warm-up at all. `ffmpeg` via avfoundation independently shows a flat
−56 dBFS from t=0.

### 2.3 Three candidate causes, all falsified

Do not re-investigate these; each was tested directly.

| candidate | test | result |
|---|---|---|
| Qwen prewarm starving the process | compared a 531 ms prewarm against a 3105 ms one | step still at exactly 3.0 s |
| Paint / JS stall (waveform freeze) | counted analyser ticks per 500 ms bucket | uniform 7–8 throughout, nothing stalls |
| WebKit's 16 kHz→48 kHz resampler | forced the track to `rate=48000` | step still at exactly 3.0 s |

The prewarm is the seductive one: it starts 500 ms after the hotkey and runs
~3.0 s, which matches the symptom almost perfectly. **It is a coincidence.**
I called it the prime suspect twice and was wrong twice.

### 2.4 `AudioContext.state === "suspended"` is a red herring

Every recording logs `ctx_state_before=suspended` — the window is raised by the
Rust event tap, so no user gesture ever reaches the webview. I concluded this was
a second, independent defect and that adding `resume()` fixed the lost words.
**That was wrong.**

The user caught it by logic, before any instrument did: a context that genuinely
never rendered would produce silence *forever*, not a clean recovery at 3.0 s.
Rebuilt with `resume()` removed and the probe kept:

```
no resume, fresh stream : blocks=2488 first_nonzero_ms=8
                          env_db=-50,-45,-49,-50,-45,-47, | -26,-12,-11
no resume, warm  stream : blocks=2710 first_nonzero_ms=32
                          env_db=-13,-11,-12,-15,-16,-11,-12,-14
```

Identical to the resumed build. WebKit auto-starts a context that has a live
capture source. `resume()` is kept as belt-and-braces only (see `9c58b57`).

**There is one defect, not two.**

---

## 3. How to reproduce any of this yourself

The instrumentation is committed and ships in local builds. Three log lines,
all on the `saytype_lifecycle` target so they survive release-level filtering:

```bash
grep -aE "audio-capture|audio-onset|audio-envelope" ~/Library/Logs/com.tao.saytype/SayType.log | tail
```

- `audio-capture` — device, `getSettings()`, AudioContext state, `mic_ms`.
  **`mic_ms=0` means the shared stream was reused; non-zero means a fresh
  `getUserMedia`.** This is the quickest way to tell which path a recording took.
- `audio-onset` — blocks, `captured_ms` vs `hold_ms`, first non-zero / first
  signal / first speech, all on the **audio timeline** (sample position), so
  main-thread jank cannot smear them.
- `audio-envelope` — per-500 ms RMS in dBFS (`env_db`), per-bucket SNR against a
  440 Hz tone via Goertzel (`snr_db`), analyser ticks per bucket (`frames`), and
  `clipped` / `clipped_pct`.

**`snr_db` is only meaningful when a 440 Hz tone is playing.** With speech it
measures "how much 440 Hz is in this speech" and is garbage. I nearly misread
this myself.

To drive a recording without a human, a synthetic modifier-hold works
(`CGEventPost` of `flagsChanged` for Ctrl+Shift). Note this needs the app's event
tap to be alive — see §7 on signing.

A standalone cpal probe lives outside the repo in the session scratchpad; the
committed `src-tauri/src/native_capture.rs` supersedes it and is reachable via the
`probe_native_capture` Tauri command.

---

## 4. What was changed

| commit | what |
|---|---|
| `1a49a8a` | Keep **one capture stream for the process** instead of acquiring per recording; single-flight acquisition; the `audio-capture` / `audio-onset` probes. Also the (harmless, non-fixing) `resume()`. |
| `22d8942` | CLAUDE.md section recording the 3.0 s attenuation and why the 2026-06-19 investigation missed it. |
| `f7c879f` | `native_capture.rs`: cpal capture + windowed-sinc resampler + envelope, macOS-gated, behind a `probe_native_capture` verification command. **Not wired into recording.** |
| `9c58b57` | Correction of the AudioContext claim in `1a49a8a` and CLAUDE.md. |

Also, untracked and **not** committed (gitignored): `scripts/sign.env` — see §7.

**Current mitigation and its cost.** Holding one stream open removes the
attenuation for every recording after the first, at the price of macOS keeping the
orange microphone indicator lit for as long as SayType runs. The user accepted
that. **They were not asked about the other cost**: v1.0.97 rejected always-on
warm-keep partly because it forces Bluetooth headsets into HFP mode, degrading
system-wide audio quality. That has never been re-evaluated. Going native (§6)
removes both costs, because native capture needs no warm stream.

---

## 5. Where the bug came from

```
3eeec04  feat: prime mic at launch, remove warm-keep   (2026-06-19, shipped in v1.3.0)
```

Before that commit, `takeWarmStream()` reused a recently-used stream. The deleted
comment said warm-keep existed to avoid the cold-start that "**is what drops the
first words**". The commit traded it for a cleaner mic indicator, on the assumption
that the cost was a ~150 ms WebKit audio-stack init, to be absorbed by a launch
prime.

Both halves of that assumption were false:

1. The cost is not 150 ms; it is 3.0 s at −32 dB. The 2026-06-19 investigation
   measured `getUserMedia` **call latency** (~150 ms cold, 18–28 ms settled). The
   call returns quickly and hands back a live track that is merely quiet — a
   latency probe cannot see this.
2. **The launch prime never ran.** The input-prompt page does not load until its
   window is first shown; verified by logging zero prime attempts in 35 s after a
   restart. So `primeMicrophone()` executes on the first hotkey press, racing the
   recording it was supposed to protect.

This also explains the user's memory that old versions were fine: pre-v1.3.0 only
the first dictation per launch was affected, which is rare enough not to register.

---

## 6. Proposed next step — **treat as a hypothesis**

The user's decision was: **go native on macOS, all devices, no per-device
detection** (a Settings toggle is acceptable; a self-calibrating device probe was
judged over-engineering for now). Windows and Linux keep the existing WebKit path.

The agreed shape is **"PCM back to the frontend"**: Rust captures, and the frontend
keeps chunking, VAD, the waveform and the recording state machine exactly as they
are. The seam is clean because `setupChunkedLocal`'s `node.port.onmessage` already
consumes Float32 blocks — it becomes an IPC handler and little else changes.

Sketch, in dependency order:

1. Rust: cpal capture → resample to 16 kHz mono → stream PCM16 blocks to the
   frontend. **Use a Tauri `Channel` (binary), not JSON events** — 48 kHz f32 as
   JSON is ~10× bloat. Sending 16 kHz PCM16 is ~32 KB/s and also removes the
   frontend's `OfflineAudioContext` resample.
2. Frontend: feed those blocks to `SayTypeChunk` as today. `chunked.sampleRate`
   becomes 16000; `decideCut` is already parameterised by rate.
3. Waveform: compute from the same PCM; `AnalyserNode` can go away entirely.
4. **The cloud path needs redesign.** It currently gets AAC from `MediaRecorder`.
   Native capture has no MediaRecorder, so cloud uploads become WAV (~+60% bytes,
   probably fine) — but `adoptLateRecorderAudio` recovery also leans on the
   single-`dataavailable` MediaRecorder contract. **This is the part most likely
   to bite; it was not in the original "just swap capture" framing.**
5. Device selection (`config.microphone`) and hot-plug must be handled explicitly;
   WebKit did this for free.
6. Platform branch: macOS native, Windows/Linux unchanged.

**Things worth challenging before you build this:**

- Is the frontend the right home for chunking at all, now that PCM originates in
  Rust? Shipping it back across IPC only to have the frontend hand chunks back for
  decode is a round trip. Moving `SayTypeChunk` into Rust is more work but may be
  the better structure. The "回传" decision was made to minimise disruption, not
  because it is architecturally superior.
- Is `cpal` the right dependency, or is a thin CoreAudio/AudioUnit binding
  preferable given only macOS is targeted?
- Does the 3.0 s window exist on other Macs / other input devices? Everything here
  is one machine, one built-in mic. **The Mac mini reportedly does not show it**,
  and nobody has checked why. If it is device-class dependent, a smaller fix might
  suffice.

---

## 7. Open items unrelated to the above

**Clipping — unmeasured, possibly more important than the 3 s window.**
Every one of the user's speech recordings peaked above full scale:
`peak = 1.23, 5.05, 1.63, 1.62, 1.93, 1.91, 2.26`. `encodeWavPcm16` hard-clips at
±1, so the WAV sent to Qwen is flat-topped on **every dictation**. macOS input
volume is at **100**. The only real `clipped_pct` figures so far are 0.05–0.17%,
but those come from *synthesized speech* peaking at 1.38 — a floor, not an
estimate. The user speaks at normal volume, so a 5× overshoot is not "shouting",
it is gain.
Likely fix: scale by `1/peak` in float **before** PCM16 quantisation. That is
lossless linear scaling, not the kind of pre-processing CLAUDE.md argues against
(that section is about denoising/AGC as enhancement). **Going native does not fix
this** — cpal showed `peak=1.38` on the same source, so it is input gain, not API.

**First dictation per app launch still pays the 3.0 s**, because the input-prompt
page loads lazily (§5). Fixing it needs the webview forced to load from Rust at
startup. Native capture makes this moot.

**Local signing.** `scripts/sign.env` did not exist on this machine, so every local
build was ad-hoc signed with a fresh cdhash, which silently revoked the app's
Accessibility grant and killed the global hotkey. I hit this mid-session; the event
tap list (`CGGetEventTapList`) is how to check — if SayType is absent from it, the
grant is gone. Now pinned to the developer's `Apple Development` identity, and
verified to survive rebuilds. **Do not remove that file.**

---

## 8. Do not repeat these

I made all three of these. They are cheap to avoid and expensive to make.

1. **Do not conclude from a measurement you have not taken.** I claimed the
   suspended AudioContext caused the loss, having never run the build without
   `resume()`.
2. **Do not accept a coincidence as a cause.** The prewarm's ~3 s matched the
   symptom's ~3 s. Two things being 3 seconds long is not causation; the 531 ms
   prewarm run settled it in one measurement.
3. **Check the discriminating power of your evidence.** I argued SNR was preserved
   because room tone scaled with the signal. Room tone is *acoustic*: it scales
   under analog attenuation too, so that observation distinguishes nothing. The
   ADC's own noise floor was the thing to isolate, and a tone SNR measurement is
   what does it.

And one about the user's own reports: they had developed a habit of **not speaking
for the first 3 seconds** to work around the bug. So "the transcript was complete"
was not evidence the audio was fine. Ask what behaviour is behind a report before
building on it.
