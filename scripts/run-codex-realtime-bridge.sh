#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CODEX_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}"
LOCAL_REALTIME_PORT="${LOCAL_REALTIME_PORT:-8787}"
LOCAL_REALTIME_URL="http://127.0.0.1:${LOCAL_REALTIME_PORT}"
LOCAL_REALTIME_LOG="${LOCAL_REALTIME_LOG:-/tmp/codex-local-realtime-${LOCAL_REALTIME_PORT}.log}"
TARGET_DIR="${1:-$PWD}"

export LOCAL_REALTIME_SAY_VOICE="${LOCAL_REALTIME_SAY_VOICE:-Samantha}"
export LOCAL_REALTIME_SAY_RATE="${LOCAL_REALTIME_SAY_RATE:-185}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-kokoro}"
export LOCAL_REALTIME_KOKORO_VOICE="${LOCAL_REALTIME_KOKORO_VOICE:-af_heart}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-local}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-canned}"
export LOCAL_REALTIME_DELEGATION_MODE="${LOCAL_REALTIME_DELEGATION_MODE:-smart}"
export LOCAL_REALTIME_BARGE_IN_RMS="${LOCAL_REALTIME_BARGE_IN_RMS:-0}"
export LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS="${LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS:-1200}"

if [[ -z "${CODEX_HOME:-}" ]]; then
  export CODEX_HOME="${HOME}/.codex"
fi

if [[ "${LOCAL_REALTIME_KILL_OLD_CODEX:-0}" == "1" ]]; then
  while read -r old_codex_pid; do
    [[ -z "${old_codex_pid}" ]] && continue
    echo "Stopping old local realtime Codex client ${old_codex_pid}"
    kill "${old_codex_pid}" >/dev/null 2>&1 || true
  done < <(
    ps -axo pid=,command= \
      | awk '/experimental_realtime_ws_model="local-codex-realtime"/ { print $1 }'
  )
fi

# Codex currently requires an API-key-looking value before it starts the
# experimental realtime websocket. Keep the real OPENAI_API_KEY available to
# the local bridge process, but pass only a placeholder to the Codex child so
# normal Codex messages can keep using the user's existing Codex/ChatGPT auth.
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  export OPENAI_API_KEY="${LOCAL_REALTIME_PLACEHOLDER_API_KEY:-local-realtime-placeholder}"
fi
CODEX_REALTIME_PLACEHOLDER_API_KEY="${LOCAL_REALTIME_CODEX_PLACEHOLDER_API_KEY:-local-realtime-placeholder}"

started_server=0
existing_pid="$(lsof -tiTCP:"${LOCAL_REALTIME_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "${existing_pid}" ]]; then
  if curl -fsS "${LOCAL_REALTIME_URL}/health" 2>/dev/null | grep -q 'local-codex-realtime'; then
    echo "Restarting old local realtime server on ${LOCAL_REALTIME_URL}"
    kill "${existing_pid}" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! lsof -tiTCP:"${LOCAL_REALTIME_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        break
      fi
      sleep 0.05
    done
  else
    echo "Port ${LOCAL_REALTIME_PORT} is already in use by a different process."
    echo "Stop it first: lsof -ti tcp:${LOCAL_REALTIME_PORT} | xargs kill"
    exit 1
  fi
fi

: > "${LOCAL_REALTIME_LOG}"
echo "Local realtime log: ${LOCAL_REALTIME_LOG}"
LOCAL_REALTIME_LOG="${LOCAL_REALTIME_LOG}" node "${ROOT_DIR}/src/local-codex-realtime-server.mjs" \
  >/tmp/codex-local-realtime-${LOCAL_REALTIME_PORT}.stdout \
  2>/tmp/codex-local-realtime-${LOCAL_REALTIME_PORT}.stderr &
server_pid=$!
started_server=1

server_ready=0
for _ in {1..40}; do
  if curl -fsS "${LOCAL_REALTIME_URL}/health" 2>/dev/null | grep -q 'local-codex-realtime'; then
    server_ready=1
    break
  fi
  if ! kill -0 "${server_pid}" >/dev/null 2>&1; then
    echo "Local realtime server exited before it became ready."
    tail -n 80 /tmp/codex-local-realtime-${LOCAL_REALTIME_PORT}.stderr 2>/dev/null || true
    exit 1
  fi
  sleep 0.05
done

if [[ "${server_ready}" != "1" ]]; then
  echo "Local realtime server did not become ready quickly enough."
  tail -n 80 /tmp/codex-local-realtime-${LOCAL_REALTIME_PORT}.stderr 2>/dev/null || true
  exit 1
fi

cleanup() {
  if [[ -t 0 && -t 1 ]]; then
    printf '\033[?2004l\033[?1004l\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?25h\033[>4;0m\033[<u' || true
    stty sane 2>/dev/null || true
  fi
  if [[ "${started_server}" == "1" ]]; then
    kill "${server_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

OPENAI_API_KEY="${CODEX_REALTIME_PLACEHOLDER_API_KEY}" "${CODEX_BIN}" \
  --enable realtime_conversation \
  -c "experimental_realtime_ws_base_url=\"${LOCAL_REALTIME_URL}\"" \
  -c 'experimental_realtime_ws_model="local-codex-realtime"' \
  -c 'realtime.transport="websocket"' \
  -c 'realtime.version="v2"' \
  -c 'realtime.type="conversational"' \
  --cd "$TARGET_DIR"
