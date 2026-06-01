#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

if [[ -z "${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}" ]]; then
  if command -v security >/dev/null 2>&1; then
    GEMINI_API_KEY="$(security find-generic-password -w -s codex-realtime-voice-kit -a gemini-api-key 2>/dev/null || true)"
    export GEMINI_API_KEY
  fi
fi

export LOCAL_REALTIME_PORT="${LOCAL_REALTIME_PORT:-18787}"
export LOCAL_REALTIME_LOG="${LOCAL_REALTIME_LOG:-/tmp/codex-realtime-bridge.log}"
export LOCAL_REALTIME_ENGINE="${LOCAL_REALTIME_ENGINE:-gemini-live}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-gemini-live}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-gemini-live}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-off}"
export LOCAL_REALTIME_GEMINI_MODEL="${LOCAL_REALTIME_GEMINI_MODEL:-gemini-3.1-flash-live-preview}"
export LOCAL_REALTIME_GEMINI_VOICE="${LOCAL_REALTIME_GEMINI_VOICE:-Aoede}"

NODE_BIN="${NODE_BIN:-/Users/dantheman/.nvm/versions/node/v22.22.0/bin/node}"
exec "${NODE_BIN}" "${ROOT_DIR}/src/local-codex-realtime-server.mjs"
