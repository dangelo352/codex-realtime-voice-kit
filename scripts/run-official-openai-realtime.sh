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

toml_string() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "${value}"
}

REALTIME_MODEL="${CODEX_REALTIME_MODEL:-${LOCAL_REALTIME_OPENAI_REALTIME_MODEL:-}}"
REALTIME_VOICE="${CODEX_REALTIME_VOICE:-${LOCAL_REALTIME_OPENAI_REALTIME_VOICE:-}}"

CODEX_ARGS=(
  --enable realtime_conversation
  --cd "${TARGET_DIR}"
)

if [[ -n "${REALTIME_MODEL}" ]]; then
  CODEX_ARGS+=(-c "experimental_realtime_ws_model=$(toml_string "${REALTIME_MODEL}")")
fi

if [[ -n "${REALTIME_VOICE}" ]]; then
  CODEX_ARGS+=(-c "realtime.voice=$(toml_string "${REALTIME_VOICE}")")
fi

exec "${CODEX_BIN}" "${CODEX_ARGS[@]}"
