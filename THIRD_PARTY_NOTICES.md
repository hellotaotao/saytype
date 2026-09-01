# Third-party notices

## Nemotron local transcription

SayType does not ship the Nemotron runtime. When the user enables the engine it
downloads NVIDIA's own **NeMo-Speech.cpp v0.1.0** release archive (macOS arm64
Metal, or Windows x86_64 CPU) and verifies it against a pinned sha256. Those
archives carry the licenses of everything inside them under
`share/licenses/nemo-speech/`.

- **NeMo-Speech.cpp** v0.1.0 (commit `4f9676226f667d14608487df744f375db87127f8`)
  is distributed under Apache License 2.0.
  See <https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.1.0>.
- **SentencePiece**, **ggml**, **llama.cpp**, **cpp-httplib**, **miniaudio**,
  and (on Windows) **abseil**, **protobuf**, and **utf8-range** are linked into
  that release. Their licenses ship inside the archive.
- The Windows archive also carries Microsoft's redistributable MSVC and OpenMP
  runtimes (`msvcp140*.dll`, `vcruntime140*.dll`, `concrt140.dll`,
  `vcomp140.dll`), as redistributed by NVIDIA in that release.
- **Nemotron 3.5 ASR Streaming 0.6B** is downloaded on demand from NVIDIA's
  pinned Hugging Face revision and is licensed under OpenMDW-1.1. See
  <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>.

SayType previously built its own macOS runtime from the same commit. That is
gone: the pinned commit *is* upstream's v0.1.0 tag, and upstream's archives are
already self-contained and relocatable, so the private build only re-derived
packaging work that upstream had done — the same conclusion recorded in
`vendor/llama.cpp/README.md` for the other local engine.
