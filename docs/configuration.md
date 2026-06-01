# Configuration

All config is done with environment variables.

## Common

```bash
export CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"
export CODEX_HOME="$HOME/.codex"
export LOCAL_REALTIME_PORT=18787
```

## OpenAI

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
```

Official realtime:

```bash
export CODEX_REALTIME_MODEL="gpt-realtime-1.5"
export CODEX_REALTIME_VOICE="marin"
./scripts/run-official-openai-realtime.sh /path/to/project
```

OpenAI realtime through the local bridge:

```bash
export LOCAL_REALTIME_OPENAI_REALTIME_MODEL="gpt-realtime-mini"
export LOCAL_REALTIME_OPENAI_REALTIME_VOICE="marin"
./scripts/run-openai-realtime-bridge.sh /path/to/project
```

With the wrapper:

```bash
codex-voice official --voice cedar --model gpt-realtime-1.5
codex-voice openai-realtime --voice marin --model gpt-realtime-mini
```

This keeps the OpenAI key inside the bridge and passes only a placeholder key to
the Codex child process.

OpenAI transcription only:

```bash
export LOCAL_REALTIME_TRANSCRIBE_MODEL="gpt-4o-mini-transcribe"
./scripts/run-openai-stt-kokoro.sh /path/to/project
```

## Groq

```bash
export GROQ_API_KEY="replace-with-groq-api-key"
export LOCAL_REALTIME_GROQ_TRANSCRIBE_MODEL="whisper-large-v3-turbo"
export LOCAL_REALTIME_GROQ_BASE_URL="https://api.groq.com/openai/v1"
```

Run:

```bash
./scripts/run-groq-stt-kokoro.sh /path/to/project
```

## Local Whisper

Medium:

```bash
export LOCAL_REALTIME_LOCAL_STT_MODEL="Xenova/whisper-medium.en"
./scripts/run-local-whisper-kokoro.sh /path/to/project
```

Tiny:

```bash
export LOCAL_REALTIME_LOCAL_STT_MODEL="Xenova/whisper-tiny.en"
./scripts/run-local-tiny-kokoro.sh /path/to/project
```

Useful knobs:

```bash
export LOCAL_REALTIME_LOCAL_STT_DTYPE="q8"
export LOCAL_REALTIME_LOCAL_STT_DEVICE="cpu"
export LOCAL_REALTIME_LOCAL_STT_MIN_RMS=90
```

## Kokoro Voice

```bash
export LOCAL_REALTIME_SPEAK="kokoro"
export LOCAL_REALTIME_KOKORO_VOICE="af_heart"
export LOCAL_REALTIME_KOKORO_DTYPE="q4"
```

Disable voice output:

```bash
export LOCAL_REALTIME_SPEAK="off"
```

Use macOS `say`:

```bash
export LOCAL_REALTIME_SPEAK="say"
export LOCAL_REALTIME_SAY_VOICE="Samantha"
export LOCAL_REALTIME_SAY_RATE=185
```

## Gemini Live

```bash
export GEMINI_API_KEY="replace-with-gemini-api-key"
export LOCAL_REALTIME_GEMINI_MODEL="gemini-3.1-flash-live-preview"
export LOCAL_REALTIME_GEMINI_VOICE="Aoede"
```

Run:

```bash
./scripts/run-gemini-live.sh /path/to/project
```

## Transcript Mode

Bridge modes default to:

```bash
export LOCAL_REALTIME_TRANSCRIPT_MODE="handoff-only"
```

This keeps delegation cleaner. Codex receives the current voice command, not all
local filler speech.

To send more context:

```bash
export LOCAL_REALTIME_TRANSCRIPT_MODE="full"
```
