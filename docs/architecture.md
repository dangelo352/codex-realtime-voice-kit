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

## Side Tasks

The local bridge does not start a second parallel Codex agent yet. Instead, it
protects the active handoff.

If the user says “on the side,” “in the background,” “separately,” or “while
that runs,” the bridge stores that request in `queuedSideTasks`. The current
Codex turn keeps running. After it finishes, the bridge starts the side task as
the next handoff and sends the side result back to the voice layer.

## Why `handoff-only` Transcript Mode Exists

Codex can include `transcript_delta` with the handoff. That is useful with the
official realtime model, but local bridge chatter can pollute it.

So bridge scripts default to:

```bash
LOCAL_REALTIME_TRANSCRIPT_MODE=handoff-only
```

That makes the Codex task cleaner.
