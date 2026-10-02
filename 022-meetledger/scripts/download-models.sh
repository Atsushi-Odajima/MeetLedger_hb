#!/usr/bin/env bash
# Downloads the on-device transcription / diarization models (sherpa-onnx) into ./models (gitignored).
# This is an EXPLICIT operator action: the server and desktop app never download models implicitly.
#
# Usage:
#   bash scripts/download-models.sh                    # sense-voice (ASR + VAD) and diarization
#   bash scripts/download-models.sh sense-voice        # only the ASR model
#   LOCAL_ASR_MODEL_DIR=/srv/meetledger/models bash scripts/download-models.sh
#
# Source of truth for URLs / sizes / licenses: packages/local-asr/src/catalog.ts
# Downloads come from https://github.com/k2-fsa/sherpa-onnx/releases (size-checked before extraction).
# Requires: node >= 22, npm dependencies installed (tsx), tar with bzip2 support.
# License notice: SenseVoiceSmall weights are under the FunASR Model License v1.1 (attribution required).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${LOCAL_ASR_MODEL_DIR:-$ROOT/models}"
TSX="$ROOT/node_modules/.bin/tsx"

if [ ! -x "$TSX" ]; then
  echo "tsx not found. Run 'npm install' in $ROOT first." >&2
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required to extract .tar.bz2 archives." >&2
  exit 1
fi

# Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21).
if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
  export NODE_USE_ENV_PROXY=1
fi

mkdir -p "$DIR"
if [ "$#" -eq 0 ]; then
  set -- sense-voice diarization
fi

"$TSX" "$ROOT/packages/local-asr/src/cli.ts" download --dir "$DIR" "$@"
"$TSX" "$ROOT/packages/local-asr/src/cli.ts" check --dir "$DIR" "$@"
echo "Models are in $DIR (set LOCAL_ASR_MODEL_DIR to this absolute path for the server)."
