# Troubleshooting

## `/realtime` says API key auth is required

Official realtime needs:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
```

Bridge modes set a placeholder key only so Codex starts the websocket. The
bridge itself handles STT.

## Groq says missing key

Run:

```bash
export GROQ_API_KEY="replace-with-groq-api-key"
./scripts/run-groq-stt-kokoro.sh /path/to/project
```

## No response after talking

Check the local log:

```bash
tail -n 120 /tmp/codex-local-realtime-8787.log
```

Look for:

```text
[stt.groq] ... elapsedMs=...
[stt.local] ... elapsedMs=...
[intent] ...
[handoff] ...
```

## It keeps hearing dots or empty text

That usually means the mic threshold is too sensitive or speaker output is being
captured.

Try:

```bash
export LOCAL_REALTIME_VAD_RMS=400
export LOCAL_REALTIME_MIN_AUDIO_MS=650
```

Headphones help a lot.

## Assistant cuts itself off

Disable barge-in:

```bash
export LOCAL_REALTIME_BARGE_IN_RMS=0
```

## Local Whisper is slow

Use Groq STT if speed matters:

```bash
./scripts/run-groq-stt-kokoro.sh /path/to/project
```

Local medium is slower but private. Local tiny is faster but less accurate.

## Terminal looks broken after closing

Run:

```bash
stty sane
printf '\033[?2004l\033[?1004l\033[?25h'
```

The shared bridge runner also tries to restore terminal state on exit.
