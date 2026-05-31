#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$PWD}"

load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${env_file}"
    set +a
  fi
}

load_env_file "${HOME}/.codex/.env"
load_env_file "${PWD}/.env"

if [[ -z "${XAI_API_KEY:-}" ]]; then
  echo "xAI realtime mode needs XAI_API_KEY."
  echo "Set it in ~/.codex/.env or export it before running this script."
  exit 1
fi

export OPENAI_API_KEY="${XAI_API_KEY}"
export LOCAL_REALTIME_ENGINE="${LOCAL_REALTIME_ENGINE:-openai-realtime}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-openai-realtime}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-openai-realtime}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-off}"
export LOCAL_REALTIME_OPENAI_REALTIME_URL="${LOCAL_REALTIME_OPENAI_REALTIME_URL:-wss://api.x.ai/v1/realtime}"
export LOCAL_REALTIME_OPENAI_REALTIME_MODEL="${LOCAL_REALTIME_OPENAI_REALTIME_MODEL:-grok-voice-think-fast-1.0}"
export LOCAL_REALTIME_OPENAI_REALTIME_VOICE="${LOCAL_REALTIME_OPENAI_REALTIME_VOICE:-eve}"
export LOCAL_REALTIME_OPENAI_REALTIME_TOOLS="${LOCAL_REALTIME_OPENAI_REALTIME_TOOLS:-1}"
export LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE="${LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE:-1}"
export LOCAL_REALTIME_OPENAI_BARGE_IN_MODE="${LOCAL_REALTIME_OPENAI_BARGE_IN_MODE:-safe}"
export LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO="${LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO:-1}"
export LOCAL_REALTIME_DELEGATION_MODE="${LOCAL_REALTIME_DELEGATION_MODE:-smart}"
export LOCAL_REALTIME_HANDOFF_ACK_SPEAK="${LOCAL_REALTIME_HANDOFF_ACK_SPEAK:-0}"
export LOCAL_REALTIME_SUPPRESS_SPEAKER_ECHO="${LOCAL_REALTIME_SUPPRESS_SPEAKER_ECHO:-1}"

exec "${SCRIPT_DIR}/run-codex-realtime-bridge.sh" "${TARGET_DIR}"
