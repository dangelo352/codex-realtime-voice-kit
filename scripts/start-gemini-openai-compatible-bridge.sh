#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/codex-realtime-voice-kit"
ACTIVE_BACKEND_FILE="${CONFIG_DIR}/active-backend"
cd "${ROOT_DIR}"

backend="gemini"
if [[ -f "${ACTIVE_BACKEND_FILE}" ]]; then
  backend="$(tr '[:upper:]' '[:lower:]' < "${ACTIVE_BACKEND_FILE}" | tr -d '[:space:]')"
fi

load_keychain_key() {
  local account="$1"
  if command -v security >/dev/null 2>&1; then
    security find-generic-password -w -s codex-realtime-voice-kit -a "${account}" 2>/dev/null || true
  fi
}

export LOCAL_REALTIME_PORT="${LOCAL_REALTIME_PORT:-18787}"
export LOCAL_REALTIME_LOG="${LOCAL_REALTIME_LOG:-/tmp/codex-realtime-bridge.log}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-off}"

case "${backend}" in
  gemini|gemini-live|gemini-flash-live|gemini-openai|google|google-live|flash-live)
    if [[ -z "${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}" ]]; then
      GEMINI_API_KEY="$(load_keychain_key gemini-api-key)"
      export GEMINI_API_KEY
    fi
    export LOCAL_REALTIME_ENGINE="gemini-live"
    export LOCAL_REALTIME_STT="gemini-live"
    export LOCAL_REALTIME_CHAT_MODE="gemini-live"
    export LOCAL_REALTIME_GEMINI_MODEL="${LOCAL_REALTIME_GEMINI_MODEL:-gemini-3.1-flash-live-preview}"
    export LOCAL_REALTIME_GEMINI_VOICE="${LOCAL_REALTIME_GEMINI_VOICE:-Aoede}"
    ;;
  xai|grok|grok-voice)
    if [[ -z "${XAI_API_KEY:-}" ]]; then
      XAI_API_KEY="$(load_keychain_key xai-api-key)"
      export XAI_API_KEY
    fi
    export OPENAI_API_KEY="${OPENAI_API_KEY:-${XAI_API_KEY:-}}"
    export LOCAL_REALTIME_ENGINE="openai-realtime"
    export LOCAL_REALTIME_STT="openai-realtime"
    export LOCAL_REALTIME_CHAT_MODE="openai-realtime"
    export LOCAL_REALTIME_OPENAI_REALTIME_URL="${LOCAL_REALTIME_OPENAI_REALTIME_URL:-wss://api.x.ai/v1/realtime}"
    export LOCAL_REALTIME_OPENAI_REALTIME_MODEL="${LOCAL_REALTIME_OPENAI_REALTIME_MODEL:-grok-voice-think-fast-1.0}"
    export LOCAL_REALTIME_OPENAI_REALTIME_VOICE="${LOCAL_REALTIME_OPENAI_REALTIME_VOICE:-eve}"
    export LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE="${LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE:-1}"
    export LOCAL_REALTIME_OPENAI_REALTIME_TOOLS="${LOCAL_REALTIME_OPENAI_REALTIME_TOOLS:-1}"
    export LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO="${LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO:-1}"
    export LOCAL_REALTIME_OPENAI_BARGE_IN_MODE="${LOCAL_REALTIME_OPENAI_BARGE_IN_MODE:-safe}"
    ;;
  openai|openai-realtime|realtime)
    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
      OPENAI_API_KEY="$(load_keychain_key openai-api-key)"
      export OPENAI_API_KEY
    fi
    export LOCAL_REALTIME_ENGINE="openai-realtime"
    export LOCAL_REALTIME_STT="openai-realtime"
    export LOCAL_REALTIME_CHAT_MODE="openai-realtime"
    unset LOCAL_REALTIME_OPENAI_REALTIME_URL
    export LOCAL_REALTIME_OPENAI_REALTIME_MODEL="${LOCAL_REALTIME_OPENAI_REALTIME_MODEL:-gpt-realtime-mini}"
    export LOCAL_REALTIME_OPENAI_REALTIME_VOICE="${LOCAL_REALTIME_OPENAI_REALTIME_VOICE:-marin}"
    export LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE="${LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE:-1}"
    export LOCAL_REALTIME_OPENAI_REALTIME_TOOLS="${LOCAL_REALTIME_OPENAI_REALTIME_TOOLS:-1}"
    ;;
  *)
    echo "Unknown Codex realtime backend '${backend}'. Use gemini, xai, or openai." >&2
    exit 64
    ;;
esac

NODE_BIN="${NODE_BIN:-/Users/dantheman/.nvm/versions/node/v22.22.0/bin/node}"
exec "${NODE_BIN}" "${ROOT_DIR}/src/local-codex-realtime-server.mjs"
