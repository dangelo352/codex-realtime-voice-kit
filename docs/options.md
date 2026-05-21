# Voice Options

This project has two kinds of modes.

1. **Official mode**
   - Codex talks directly to the official realtime endpoint.
   - This is closest to the real OpenAI behavior.

2. **Bridge modes**
   - Codex talks to `src/local-codex-realtime-server.mjs`.
   - The bridge handles speech-to-text, voice output, and handoff events.
   - Codex still does the real coding work.

## Option A: Official OpenAI Realtime

Script:

```bash
./scripts/run-official-openai-realtime.sh /path/to/project
```

Needs:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
```

Use when:

- you want closest official behavior
- you want to test the real OpenAI realtime path
- you are okay with direct API-key auth for that Codex session

## Option B: OpenAI Realtime Bridge

Script:

```bash
./scripts/run-openai-realtime-bridge.sh /path/to/project
```

Needs:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
```

What happens:

- OpenAI Realtime handles the live voice conversation
- the bridge passes Codex tasks back to the original Codex CLI
- the Codex child gets only a placeholder key, so normal Codex messages should
  keep using your existing Codex/ChatGPT auth

Default model:

```text
gpt-realtime-mini
```

Use when:

- you want OpenAI realtime behavior without making the whole Codex session use
  API-key auth

## Option C: Groq STT + Kokoro TTS

Script:

```bash
./scripts/run-groq-stt-kokoro.sh /path/to/project
```

Needs:

```bash
export GROQ_API_KEY="replace-with-groq-api-key"
```

What happens:

- Groq transcribes your microphone audio
- Kokoro speaks the assistant answer locally
- Codex CLI handles code tasks

Default Groq model:

```text
whisper-large-v3-turbo
```

This is the best practical bridge mode from testing so far.

## Option D: OpenAI STT + Kokoro TTS

Script:

```bash
./scripts/run-openai-stt-kokoro.sh /path/to/project
```

Needs:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
```

This is not the same as official OpenAI realtime. It only uses OpenAI for
speech-to-text. Kokoro still does local voice output.

## Option E: Local Whisper + Kokoro

Script:

```bash
./scripts/run-local-whisper-kokoro.sh /path/to/project
```

Default local STT model:

```text
Xenova/whisper-medium.en
```

Use when:

- you want no cloud STT
- privacy matters more than speed

Tradeoff:

- slower than Groq
- better than tiny

## Option F: Local Tiny Whisper + Kokoro

Script:

```bash
./scripts/run-local-tiny-kokoro.sh /path/to/project
```

Default local STT model:

```text
Xenova/whisper-tiny.en
```

Use when:

- you want a very fast local test

Tradeoff:

- worse accuracy
- more hallucinated or weird short transcripts

## Option G: Gemini Live

Script:

```bash
./scripts/run-gemini-live.sh /path/to/project
```

Needs:

```bash
export GEMINI_API_KEY="replace-with-gemini-api-key"
```

Gemini handles live audio and voice. Codex still receives delegated coding
requests through the bridge.

Tradeoff:

- can feel more realtime
- may not behave exactly like Codex/OpenAI realtime

## Option H: Moshi Bridge

Script:

```bash
./scripts/run-moshi-codex-bridge.sh /path/to/project
```

Moshi is local speech-to-speech. This is very experimental. It may be useful for
testing local realtime voice, but it is not as reliable for Codex task handoff.
