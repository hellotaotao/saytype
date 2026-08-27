# Third-party notices

## Nemotron local transcription

- **NeMo-Speech.cpp**, pinned to commit `4f9676226f667d14608487df744f375db87127f8`, is distributed under Apache License 2.0. Its license is included inside the bundled runtime archive.
- **SentencePiece**, pinned to commit `17d7580d6407802f85855d2cc9190634e2c95624`, is statically linked into that runtime. Its license is included inside the archive.
- **ggml**, **cpp-httplib**, and **miniaudio** are bundled by the pinned NeMo-Speech.cpp build. Their licenses are included inside the archive.
- **Nemotron 3.5 ASR Streaming 0.6B** is downloaded on demand from NVIDIA's pinned Hugging Face revision and is licensed under OpenMDW-1.1. See <https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b>.

The runtime archive can be reproduced with `scripts/build-nemotron-runtime.sh` on an Apple Silicon Mac.
