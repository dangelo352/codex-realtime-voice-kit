#!/usr/bin/env bash
set -euo pipefail

CODEX_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}"
TARGET_DIR="${1:-$PWD}"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "Official OpenAI realtime mode needs OPENAI_API_KEY."
  echo "Run this first:"
  echo "  export OPENAI_API_KEY='replace-with-openai-api-key'"
  exit 1
fi

if [[ -z "${CODEX_HOME:-}" ]]; then
  export CODEX_HOME="${HOME}/.codex"
fi

exec "${CODEX_BIN}" \
  --enable realtime_conversation \
  --cd "${TARGET_DIR}"
