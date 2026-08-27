#!/usr/bin/env bash
set -euo pipefail

NEMO_COMMIT="4f9676226f667d14608487df744f375db87127f8"
SENTENCEPIECE_COMMIT="17d7580d6407802f85855d2cc9190634e2c95624"
ROOT="${TMPDIR:-/tmp}/saytype-nemotron-build"
SOURCE="$ROOT/NeMo-Speech.cpp"
SP_SOURCE="$ROOT/sentencepiece"
SP_BUILD="$ROOT/sentencepiece-build"
SP_PREFIX="$ROOT/deps/sentencepiece"
BUILD="$ROOT/build"
STAGE="$ROOT/stage"
OUTPUT="src-tauri/resources/local-asr/nemo-speech-4f967622-macos-arm64.tar.gz"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "This runtime must be built on an Apple Silicon Mac." >&2
  exit 1
fi

command -v cmake >/dev/null
command -v ninja >/dev/null

if [[ ! -d "$SOURCE/.git" ]]; then
  git clone --filter=blob:none https://github.com/NVIDIA/NeMo-Speech.cpp.git "$SOURCE"
fi
git -C "$SOURCE" fetch --depth 1 origin "$NEMO_COMMIT"
git -C "$SOURCE" checkout --force "$NEMO_COMMIT"
git -C "$SOURCE" submodule update --init --recursive --depth 1

if [[ ! -d "$SP_SOURCE/.git" ]]; then
  git clone --filter=blob:none https://github.com/google/sentencepiece.git "$SP_SOURCE"
fi
git -C "$SP_SOURCE" fetch --depth 1 origin "$SENTENCEPIECE_COMMIT"
git -C "$SP_SOURCE" checkout --force "$SENTENCEPIECE_COMMIT"

cmake -G Ninja -S "$SP_SOURCE" -B "$SP_BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15 \
  -DSPM_BUILD_TEST=OFF \
  -DSPM_ENABLE_SHARED=OFF \
  -DSPM_ENABLE_TCMALLOC=OFF
cmake --build "$SP_BUILD" --target sentencepiece-static -j 4
mkdir -p "$SP_PREFIX/lib" "$SP_PREFIX/include" "$SP_PREFIX/share/licenses/sentencepiece"
cp "$SP_BUILD/src/libsentencepiece.a" "$SP_PREFIX/lib/"
cp "$SP_SOURCE/src/sentencepiece_processor.h" "$SP_PREFIX/include/"
cp "$SP_SOURCE/LICENSE" "$SP_PREFIX/share/licenses/sentencepiece/LICENSE"

perl -0pi -e 's/if\(UNIX AND NOT APPLE\)/if(UNIX)/' "$SOURCE/src/asr/CMakeLists.txt"
perl -0pi -e 's/    target_link_options\(\n        nemo_speech_asr PRIVATE "LINKER:--exclude-libs,libsentencepiece\.a"\)/    if(NOT APPLE)\n        target_link_options(\n            nemo_speech_asr PRIVATE "LINKER:--exclude-libs,libsentencepiece.a")\n    endif()/' "$SOURCE/src/asr/CMakeLists.txt"

cmake -G Ninja -S "$SOURCE" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=10.15 \
  -DNEMO_SPEECH_BUILD_ASR=ON \
  -DNEMO_SPEECH_BUILD_DIAR=OFF \
  -DNEMO_SPEECH_BUILD_TTS=OFF \
  -DNEMO_SPEECH_BUILD_NMT=OFF \
  -DNEMO_SPEECH_BUILD_HTTP=ON \
  -DNEMO_SPEECH_BUILD_GRPC=OFF \
  -DNEMO_SPEECH_WITH_GRPC=OFF \
  -DNEMO_SPEECH_BUILD_MIC_CAPTURE=OFF \
  -DNEMO_SPEECH_BUILD_EXAMPLES=OFF \
  -DNEMO_SPEECH_BUILD_TESTS=OFF \
  -DNEMO_SPEECH_BUILD_TOOLS=OFF \
  -DNEMO_SPEECH_GGML_PATCHED=OFF \
  -DGGML_METAL=ON \
  -DGGML_NATIVE=OFF \
  -DNEMO_SPEECH_DEPENDENCY_PREFIX="$ROOT/deps" \
  -DSENTENCEPIECE_STATIC_LIB="$SP_PREFIX/lib/libsentencepiece.a" \
  -DSENTENCEPIECE_INCLUDE_DIR="$SP_PREFIX/include"
cmake --build "$BUILD" -j 4

rm -rf "$STAGE"
mkdir -p \
  "$STAGE/licenses/NeMo-Speech.cpp" \
  "$STAGE/licenses/sentencepiece" \
  "$STAGE/licenses/ggml" \
  "$STAGE/licenses/cpp-httplib" \
  "$STAGE/licenses/miniaudio" \
  "$STAGE/licenses/Nemotron-model"
cp -a "$BUILD/bin/"* "$STAGE/"
cp "$SOURCE/LICENSE" "$STAGE/licenses/NeMo-Speech.cpp/LICENSE"
cp "$SP_SOURCE/LICENSE" "$STAGE/licenses/sentencepiece/LICENSE"
cp "$SOURCE/ggml/LICENSE" "$STAGE/licenses/ggml/LICENSE"
cp "$SOURCE/third_party/cpp-httplib/LICENSE" "$STAGE/licenses/cpp-httplib/LICENSE"
cp "$SOURCE/third_party/miniaudio/LICENSE" "$STAGE/licenses/miniaudio/LICENSE"
printf '%s\n' \
  'Nemotron 3.5 ASR Streaming 0.6B is licensed under OpenMDW-1.1.' \
  'https://openmdw.ai/license/1-1/' \
  > "$STAGE/licenses/Nemotron-model/NOTICE"

for file in "$STAGE/nemo-speech" "$STAGE/"*.dylib; do
  [[ -L "$file" ]] && continue
  old_rpath="$(otool -l "$file" | awk '/LC_RPATH/{found=1;next} found&&/path /{print $2; exit}')"
  [[ -z "$old_rpath" ]] || install_name_tool -delete_rpath "$old_rpath" "$file"
  install_name_tool -add_rpath @loader_path "$file"
  codesign --force --sign - "$file" >/dev/null
  if otool -L "$file" | tail -n +2 | grep -Eq '/opt/homebrew|/tmp/'; then
    echo "Non-relocatable dependency in $file" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$OUTPUT")"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUTPUT" .
echo "Wrote $OUTPUT"
shasum -a 256 "$OUTPUT"
stat -f 'size=%z' "$OUTPUT"
