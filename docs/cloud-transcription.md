# Cloud transcription

Groq and OpenAI are optional engines. This file keeps the model choices and the measurements behind
them, checked against `a183354` (1.15.1) on 2026-09-11.

## Current setup

- OpenAI has a single model row, `gpt-transcribe`. It is the default in `settings.rs`
  (`default_model`), in `commands.rs` (`default_model_for` and the empty-model fallback in
  `perform_transcription_request`) and in `input-prompt.js` (`RECORD_DEFAULT_MODEL`). Groq offers
  Whisper large-v3-turbo (its default, marked recommended) and large-v3.
- Chinese Whisper requests carry a punctuation seed, `SEED_ZH` in `commands.rs`. The local engines
  never receive it.
- Translation (hold Shift+Alt; the result is English) always goes to a cloud provider
  (`resolve_transcription_route`). With a cloud engine selected, it uses that provider and its key,
  with no separate consent. With a local engine selected, it uses `translate_provider` (`groq` or
  `openai`; an install that never chose one falls back to Groq, then OpenAI, if the key exists) and
  requires `translate_consented`, because that is the one path where a local user's audio leaves
  the device. Settings shows the translation provider picker only for local engines. OpenAI's
  `/audio/translations` accepts only `whisper-1`, so translation is hardcoded to it even though
  `whisper-1` is gone from the picker. Retired model ids keep their `MODEL_LABEL` entries so old History rows still show a name.
- Audio is uploaded without noise suppression or AGC; see the decision in
  [audio-capture.md](audio-capture.md).

## Why these choices (measured 2026-07-03 and 2026-09-07)

A 77-call controlled sweep on 2026-07-03 (same audio sent to Groq/OpenAI, temperature × prompt, 3–5
repetitions each) and a head-to-head on 2026-09-07 back four decisions:

- **Groq recommends turbo over large-v3.** On a real 96-character run-on Chinese dictation,
  `whisper-large-v3` returned zero punctuation every time, with or without the seed, while
  `whisper-large-v3-turbo` + seed placed 3 marks correctly. Whether punctuation appears depends on the
  utterance, not on luck: repeats return byte-identical text.
- **`SEED_ZH` stays** because it costs nothing and helps turbo; it does not rescue large-v3. On
  degenerate repetitive audio `whisper-1` once returned the seed itself as the whole transcript; the
  VAD gate covers the silent case.
- **Don't add a temperature parameter for punctuation.** Groq's default is identical to
  `temperature=0`, and `0.4` was strictly worse (zero-punctuation collapse plus run-to-run variance).
- **OpenAI offers only `gpt-transcribe`** ($0.0045/min). On a 20 s run-on Chinese clip it matched
  `gpt-4o-mini-transcribe` ($0.003/min) on words and punctuation count (6 marks), but the mini used
  half-width ASCII commas and ran the utterance into one sentence, which `scrub.rs` doesn't fix; the
  price gap is about $0.68/month at 15 minutes a day. `gpt-4o-transcribe` and `whisper-1` cost more
  and collapsed to zero or near-zero punctuation. Caveat: one TTS clip.

For Groq users the lasting fix would be the LLM post-processing pass parked in TODO.md #1.

## Hallucination guards

Whisper large-v3 (zh) can append YouTube-outro boilerplate at long pauses or trailing silence, even
on otherwise correct long dictations. Current guards: the VAD gate skips clips with no speech and
trims audio to 300 ms before the first and 450 ms after the last speech segment (`bcc568d`), and
`scrub.rs` strips known boilerplate families and seed-prompt leaks, returning empty text when the
whole output is boilerplate (`5882e78`). Further options, such as segment-level `verbose_json`
filtering, are parked in TODO.md #10.
