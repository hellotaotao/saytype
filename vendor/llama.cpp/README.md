# The llama.cpp reset patch — kept as a record, no longer built

SayType ships **upstream's own llama.cpp `b9960` releases** on every platform.
Nothing here is built or bundled. The patch and this note stay because the bug
they describe is real, still present upstream, and is the reason
`reuse_local_worker` defaults off.

## The bug

`llama-mtmd-cli` stores `mtmd::batch_ptr` on the long-lived chat context while
the chunks that batch references belong to one `eval_message()` call. After the
call returns, the batch can retain dangling chunk pointers, and a later audio
request may reuse the same address and receive the previous audio's embedding.

Measured on Windows against stock `b9960`, feeding one process alternating clips
with `/clear` between them exactly as SayType does:

- every decode after the first returned the **previous** clip's transcript;
- the process aborted on the third with `0xC0000409`
  (`STATUS_STACK_BUFFER_OVERRUN` — memory corruption caught by /GS).

`/clear` does not help: upstream's implementation does not reset media state.

## Why SayType no longer patches around it

The patch made the media batch request-local and expanded `/clear` to reset
queued media, sampler state, pending content, chat history, and model memory.
It worked. Building it did not.

A private runtime meant reproducing distribution work upstream had already done,
and each omission shipped as a defect: an OpenSSL link inherited from the build
machine (broke Windows on release, and had silently broken macOS for anyone
without homebrew's `openssl@3`), an OpenMP runtime imported but not shipped, and
a single CPU variant compiled for whatever the CI runner happened to support —
one build required AVX-512 and would not start on the development machine.
Upstream's packs carry per-arch CPU dispatch, a bundled OpenMP runtime, and no
stray links.

The bug also stopped mattering. It needs two audios in one process, and SayType
now starts a worker at shortcut-down and retires it after its single decode. The
model load overlaps the user's speech instead of following it, which was the
larger win, and each process only ever sees one clip. Verified against stock
`b9960`: six alternating decodes, one worker each, all correct.

What reuse would still buy is utterances shorter than the model load — about
2.7 s on a Windows i5-7400, 0.2–0.33 s on an M4. Not enough to maintain a
private native build for.

## If it is ever revisited

`git log -- vendor/llama.cpp scripts/build-patched-llama.mjs` has the whole
pipeline: the build script, its relocatability and self-contained-import guards,
and the CI job. Any revival should start from upstream's CMake configuration
rather than a hand-picked subset — `GGML_BACKEND_DL=ON`,
`GGML_CPU_ALL_VARIANTS=ON`, bundled libomp — since every defect above came from
diverging from it.

`0001-reset-per-audio-state.patch` applies to
`a935fbffe1a3d31509c325c116454ab5d56b2eb8` (`b9960`).
