#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# OpenAI-compatible local realtime surface, Gemini Live backend.
# Codex/Desktop connects to /v1/realtime using OpenAI-style websocket events;
# this script chooses Gemini Live as the backend engine.
export LOCAL_REALTIME_ENGINE="${LOCAL_REALTIME_ENGINE:-gemini-live}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-gemini-live}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-gemini-live}"
export LOCAL_REALTIME_GEMINI_MODEL="${LOCAL_REALTIME_GEMINI_MODEL:-gemini-3.1-flash-live-preview}"

exec "${SCRIPT_DIR}/run-gemini-live.sh" "$@"
