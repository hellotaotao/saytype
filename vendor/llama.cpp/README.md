# SayType llama.cpp runtime

SayType pins llama.cpp build `b9960` at commit
`a935fbffe1a3d31509c325c116454ab5d56b2eb8` and applies the patches listed in
`runtime.json`.

## Why the patch exists

Upstream `llama-mtmd-cli` stores `mtmd::batch_ptr` on the long-lived chat
context while the chunks referenced by that batch belong to one
`eval_message()` call. After the call returns, the batch can retain dangling
chunk pointers. A later audio request may reuse the same address and receive
the previous audio embedding.

The maintained patch makes the media batch request-local and expands `/clear`
to reset queued media, sampler state, pending content, chat history, and model
memory. Model weights and model contexts remain resident.

## Build

```sh
npm run build:llama-runtime:mac-arm64
```

The build script:

1. fetches the exact upstream commit;
2. verifies and applies the maintained patch;
3. builds only `llama-mtmd-cli` and its runtime libraries, linked against a
   loader-relative RPATH;
4. verifies the staged files are relocatable (see below);
5. writes an archive and SHA-256 metadata under
   `artifacts/local-asr-runtime/`.

After reviewing a new artifact, copy it to `src-tauri/resources/local-asr/`,
update the size and SHA-256 in `src-tauri/src/local_asr.rs`, and run the
contract, Rust, and real two-audio resident smoke tests.

## Relocatability

The staged runtime has to resolve its own libraries. CMake links build-tree
binaries against an absolute RPATH pointing back at the build directory, so a
runtime staged verbatim keeps working only while that directory survives. The
first `b9960-saytype-reset-v1` archive shipped that way: it ran fine off
`/private/tmp/saytype-llama-maintained-build/build/bin` for weeks, and once
macOS cleaned that path every local transcription failed with `resident
llama-mtmd-cli did not reach its initial prompt` (the child was aborting in
dyld with `Library not loaded`, on a stderr the resident spawn discards).

So the build sets `CMAKE_INSTALL_RPATH=@loader_path` and then checks two
things after staging: that no Mach-O in the archive keeps an absolute rpath,
and that a copy of the stage directory, launched from somewhere else, loads
every `libllama`/`libggml`/`libmtmd` image out of that copy
(`DYLD_PRINT_LIBRARIES`). The second check depends on the first — while the
build directory is still present, a binary with an absolute rpath launches
happily from anywhere, which is why "it runs" was never evidence here.

On the app side, `local_asr.rs` stamps `bin/<runtimeId>/.saytype-runtime-sha256`
with the archive hash at extraction and re-extracts when it does not match.
Without that, rebuilding an archive under an existing runtime id leaves the old
extraction in place on every machine that already has it.

## Platform policy

The checked-in patched runtime currently covers macOS arm64, the platform on
which SayType enables local-first behavior. Other platforms keep upstream
`b9960`, but SayType retires the chat worker after every decode there so stale
media state cannot cross recordings. Add a platform to the resident-safe set
only after its patched archive passes the same two-audio regression.

## Upgrade policy

Never move the patch to a new upstream build by changing only the build number.
Reproduce the bug first, inspect upstream ownership and `/clear` behavior,
rebase the patch, and rerun the real resident A/B test. If upstream has fixed
the ownership issue, remove only the redundant source hunk while retaining the
SayType reset-contract verification.
