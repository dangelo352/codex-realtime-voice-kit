#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load xAI key
if [[ -f "${HOME}/.codex/.env" ]]; then
  set -a; source "${HOME}/.codex/.env"; set +a
fi
if [[ -f "${HOME}/codex-app/.env" ]]; then
  set -a; source "${HOME}/codex-app/.env"; set +a
fi
if [[ -f "${PWD}/.env" ]]; then
  set -a; source "${PWD}/.env"; set +a
fi

if [[ -z "${XAI_API_KEY:-}" ]]; then
  echo "XAI_API_KEY not set. Cannot start realtime bridge." >&2
  exit 1
fi

export OPENAI_API_KEY="${XAI_API_KEY}"
export LOCAL_REALTIME_OPENAI_REALTIME_URL="${LOCAL_REALTIME_OPENAI_REALTIME_URL:-wss://api.x.ai/v1/realtime}"
export LOCAL_REALTIME_OPENAI_REALTIME_MODEL="${LOCAL_REALTIME_OPENAI_REALTIME_MODEL:-grok-voice-think-fast-1.0}"
export LOCAL_REALTIME_OPENAI_REALTIME_VOICE="${LOCAL_REALTIME_OPENAI_REALTIME_VOICE:-eve}"
export LOCAL_REALTIME_ENGINE="${LOCAL_REALTIME_ENGINE:-openai-realtime}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-openai-realtime}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-openai-realtime}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-off}"
export LOCAL_REALTIME_OPENAI_REALTIME_TOOLS="${LOCAL_REALTIME_OPENAI_REALTIME_TOOLS:-1}"
export LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE="${LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE:-1}"
export LOCAL_REALTIME_OPENAI_BARGE_IN_MODE="${LOCAL_REALTIME_OPENAI_BARGE_IN_MODE:-safe}"
export LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO="${LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO:-1}"
export LOCAL_REALTIME_DELEGATION_MODE="${LOCAL_REALTIME_DELEGATION_MODE:-smart}"
export LOCAL_REALTIME_LOG="${LOCAL_REALTIME_LOG:-/tmp/codex-realtime-bridge.log}"
export LOCAL_REALTIME_PORT="${LOCAL_REALTIME_PORT:-8787}"

exec /Users/dantheman/.nvm/versions/node/v22.22.0/bin/node "${ROOT_DIR}/src/local-codex-realtime-server.mjs"
