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
3. builds only `llama-mtmd-cli` and its runtime libraries;
4. writes an archive and SHA-256 metadata under
   `artifacts/local-asr-runtime/`.

After reviewing a new artifact, copy it to `src-tauri/resources/local-asr/`,
update the size and SHA-256 in `src-tauri/src/local_asr.rs`, and run the
contract, Rust, and real two-audio resident smoke tests.

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
