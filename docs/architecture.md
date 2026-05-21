# Architecture

## Official OpenAI Mode

```text
microphone
  -> Codex CLI /realtime
  -> official OpenAI realtime backend
  -> Codex agent
  -> voice response
```

Script:

```bash
./scripts/run-official-openai-realtime.sh
```

## Local Bridge Modes

```text
microphone
  -> Codex CLI /realtime websocket
  -> local bridge server
  -> STT provider or live voice provider
  -> intent / tool / handoff logic
  -> Codex background agent
  -> local or online voice output
```

For `openai-realtime`, the bridge connects to OpenAI Realtime for the live voice
conversation, but the Codex child process receives only a placeholder
`OPENAI_API_KEY`. That keeps normal Codex coding messages on the user's
existing Codex/ChatGPT auth.

Main bridge file:

```text
src/local-codex-realtime-server.mjs
```

Shared bridge runner:

```text
scripts/run-codex-realtime-bridge.sh
```

Provider scripts only set environment variables, then call the shared runner.

## Handoff

For coding tasks, the bridge sends a realtime handoff event back to Codex:

```json
{
  "type": "conversation.handoff.requested",
  "input_transcript": "Summarize this codebase"
}
```

Codex then starts a normal backend coding turn.

## Why `handoff-only` Transcript Mode Exists

Codex can include `transcript_delta` with the handoff. That is useful with the
official realtime model, but local bridge chatter can pollute it.

So bridge scripts default to:

```bash
LOCAL_REALTIME_TRANSCRIPT_MODE=handoff-only
```

That makes the Codex task cleaner.
