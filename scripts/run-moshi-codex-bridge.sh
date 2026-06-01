#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_DIR="${1:-$PWD}"

MOSHI_PYTHON="${MOSHI_PYTHON:-}"
if [[ -z "${MOSHI_PYTHON}" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    MOSHI_PYTHON="$(command -v python3.12)"
  elif command -v python3.13 >/dev/null 2>&1; then
    MOSHI_PYTHON="$(command -v python3.13)"
  else
    MOSHI_PYTHON="$(command -v python3)"
  fi
fi

MOSHI_VENV="${MOSHI_VENV:-${ROOT_DIR}/.venv-moshi}"
MOSHI_HOST="${MOSHI_HOST:-127.0.0.1}"
MOSHI_PORT="${MOSHI_PORT:-8999}"
MOSHI_QUANTIZED="${MOSHI_QUANTIZED:-4}"
MOSHI_HF_REPO="${MOSHI_HF_REPO:-kyutai/moshika-mlx-q4}"
MOSHI_STDOUT="${MOSHI_STDOUT:-/tmp/codex-moshi-bridge-${MOSHI_PORT}.stdout}"
MOSHI_STDERR="${MOSHI_STDERR:-/tmp/codex-moshi-bridge-${MOSHI_PORT}.stderr}"

if [[ -d "/opt/homebrew/opt/coreutils/libexec/gnubin" ]]; then
  export PATH="/opt/homebrew/opt/coreutils/libexec/gnubin:${PATH}"
fi
export CMAKE_POLICY_VERSION_MINIMUM="${CMAKE_POLICY_VERSION_MINIMUM:-3.5}"

if [[ ! -x "${MOSHI_VENV}/bin/python" ]]; then
  echo "Creating Moshi Python environment at ${MOSHI_VENV}"
  "${MOSHI_PYTHON}" -m venv "${MOSHI_VENV}"
fi

MOSHI_PY="${MOSHI_VENV}/bin/python"

if [[ "${MOSHI_SKIP_INSTALL:-0}" != "1" ]]; then
  echo "Checking Moshi MLX dependencies."
  "${MOSHI_PY}" -m pip install -U pip wheel setuptools >/dev/null
  "${MOSHI_PY}" -m pip install -U moshi_mlx sounddevice >/dev/null
fi

existing_pid="$(lsof -tiTCP:"${MOSHI_PORT}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "${existing_pid}" ]]; then
  if curl -fsS "http://${MOSHI_HOST}:${MOSHI_PORT}/health" 2>/dev/null | grep -q 'moshi-codex-bridge'; then
    echo "Restarting old Moshi bridge on ${MOSHI_HOST}:${MOSHI_PORT}"
    kill "${existing_pid}" >/dev/null 2>&1 || true
    sleep 1
  else
    echo "Port ${MOSHI_PORT} is already in use by another process."
    exit 1
  fi
fi

: > "${MOSHI_STDOUT}"
: > "${MOSHI_STDERR}"
echo "Starting Moshi bridge. First start can take a while while the model warms up."
"${MOSHI_PY}" "${ROOT_DIR}/src/moshi-codex-bridge.py" \
  --host "${MOSHI_HOST}" \
  --port "${MOSHI_PORT}" \
  -q "${MOSHI_QUANTIZED}" \
  --hf-repo "${MOSHI_HF_REPO}" \
  >"${MOSHI_STDOUT}" \
  2>"${MOSHI_STDERR}" &
moshi_pid=$!

cleanup() {
  kill "${moshi_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..240}; do
  if ! kill -0 "${moshi_pid}" >/dev/null 2>&1; then
    echo "Moshi bridge exited early."
    tail -n 80 "${MOSHI_STDOUT}" || true
    tail -n 80 "${MOSHI_STDERR}" || true
    exit 1
  fi
  if curl -fsS "http://${MOSHI_HOST}:${MOSHI_PORT}/health" 2>/dev/null | grep -q 'moshi-codex-bridge'; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://${MOSHI_HOST}:${MOSHI_PORT}/health" 2>/dev/null | grep -q 'moshi-codex-bridge'; then
  echo "Moshi bridge did not become ready in time."
  tail -n 80 "${MOSHI_STDOUT}" || true
  tail -n 80 "${MOSHI_STDERR}" || true
  exit 1
fi

export LOCAL_REALTIME_ENGINE="${LOCAL_REALTIME_ENGINE:-moshi-live}"
export LOCAL_REALTIME_MOSHI_WS_URL="${LOCAL_REALTIME_MOSHI_WS_URL:-ws://${MOSHI_HOST}:${MOSHI_PORT}/v1/moshi}"
export LOCAL_REALTIME_STT="${LOCAL_REALTIME_STT:-fake}"
export LOCAL_REALTIME_CHAT_MODE="${LOCAL_REALTIME_CHAT_MODE:-canned}"
export LOCAL_REALTIME_SPEAK="${LOCAL_REALTIME_SPEAK:-off}"
export LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS="${LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS:-1200}"
export LOCAL_REALTIME_MOSHI_ALLOW_BARGE_IN="${LOCAL_REALTIME_MOSHI_ALLOW_BARGE_IN:-0}"
export LOCAL_REALTIME_MOSHI_DIRECT_PLAYBACK="${LOCAL_REALTIME_MOSHI_DIRECT_PLAYBACK:-1}"
export LOCAL_REALTIME_MOSHI_CODEX_AUDIO="${LOCAL_REALTIME_MOSHI_CODEX_AUDIO:-0}"

if [[ -z "${LOCAL_REALTIME_PCM_PLAYER:-}" ]]; then
  LOCAL_REALTIME_PCM_PLAYER="$(command -v ffplay || true)"
fi
export LOCAL_REALTIME_PCM_PLAYER="${LOCAL_REALTIME_PCM_PLAYER:-ffplay}"

exec "${SCRIPT_DIR}/run-codex-realtime-bridge.sh" "${TARGET_DIR}"
