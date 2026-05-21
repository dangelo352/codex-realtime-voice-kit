# Codex Realtime Voice Kit

Experimental launchers for testing voice/realtime modes with the Codex CLI.

This repo keeps the **real Codex CLI** as the coding agent, then swaps the
voice layer:

- official OpenAI realtime API
- OpenAI realtime API through the local bridge
- Groq speech-to-text + local Kokoro voice
- OpenAI speech-to-text + local Kokoro voice
- local Whisper speech-to-text + local Kokoro voice
- Gemini Live voice model
- Moshi local speech-to-speech experiment

> Note: this is a research/test kit. Codex realtime mode is still experimental.

## Setup

```bash
npm install
```

Optional global command while developing this repo:

```bash
npm link
```

After that you can run:

```bash
codex-voice groq /path/to/project
codex-voice openai-realtime /path/to/project
codex-voice gemini /path/to/project
codex-voice official /path/to/project
codex-voice official --voice cedar --model gpt-realtime-1.5
codex-voice openai-realtime --voice marin --model gpt-realtime-mini
codex-voice gemini --voice Leda
codex-voice gemini --model gemini-3.1-flash-live-preview
codex-voice settings
codex-voice status
codex-voice stop
codex-voice doctor
```

The project path is optional. If you run it inside a project folder, it uses the
current terminal folder:

```bash
cd /path/to/project
codex-voice gemini
```

If a needed API key is missing, `codex-voice` asks for it and can save it in
macOS Keychain. It prints only a masked preview like `masked-key-preview`, not the
full key.

If an API key is already exported in your terminal, that env key is used first.
To force a fresh paste, run the mode with `--replace-key`.

Gemini mode skips the slow network key pre-check by default now, so startup is
faster. If you want the pre-check back:

```bash
LOCAL_REALTIME_SKIP_GEMINI_KEY_CHECK=0 codex-voice gemini
```

Multiple Codex voice sessions can run at the same time. If you do not set
`LOCAL_REALTIME_PORT`, `codex-voice` picks a free local bridge port for each
new session and does not close older Codex clients.

The online realtime model is not connected just because Codex is open. It
connects after you run `/realtime`, and closes when realtime mode closes.

When you resume a Codex thread and start `/realtime`, the Gemini bridge passes a
compact Codex session memory into Gemini. That lets the voice layer answer
simple context questions like “what were we working on before?” without starting
from a blank voice session.

When Gemini hands a task to Codex, it shows a short acknowledgement in the
terminal. It does not speak that acknowledgement by default, so it does not talk
over Gemini or trigger speaker echo. Codex results are read fully by default.
Gemini barge-in is on in safer `transcript` mode: the bridge only stops the
voice after Gemini hears new user words, not just because the mic got loud.

If Codex is already working and you say something like “check this on the side”
or “do this while that runs,” the bridge keeps that request in a side-task queue.
It does not redirect the active Codex handoff. When the active task finishes, the
side task runs next and the voice layer gets a separate side-task result.

Gemini defaults to `gemini-3.1-flash-live-preview` with the
`Aoede` voice. Change it without editing files:

```bash
codex-voice official --voice cedar --model gpt-realtime-1.5
codex-voice openai-realtime --voice marin --model gpt-realtime-mini
codex-voice gemini --voice Leda
codex-voice gemini --voice Aoede
codex-voice gemini --no-barge-in
codex-voice gemini --model gemini-3.1-flash-live-preview
codex-voice voices
codex-voice settings
```

Codex app binary default:

```bash
/Applications/Codex.app/Contents/Resources/codex
```

Override it if needed:

```bash
export CODEX_BIN="/path/to/codex"
```

## Quick Start

Run from this repo folder.

### 1. Groq STT + Kokoro voice

Good default right now: fast STT, local voice, real Codex coding agent.

```bash
export GROQ_API_KEY="replace-with-groq-api-key"
./scripts/run-groq-stt-kokoro.sh /path/to/project
```

Then type this inside Codex CLI:

```text
/realtime
```

### 2. Official OpenAI realtime

This does not use the local bridge. Codex talks to the official realtime
backend/API path, so use it only when you intentionally want the whole session
to run with API-key auth.

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
export CODEX_REALTIME_MODEL="gpt-realtime-1.5"
export CODEX_REALTIME_VOICE="marin"
./scripts/run-official-openai-realtime.sh /path/to/project
```

Then:

```text
/realtime
```

### 3. OpenAI realtime bridge

This uses the OpenAI Realtime API only for the voice layer. Codex still starts
through the local bridge and should keep using your normal Codex/ChatGPT auth
for coding messages.

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
./scripts/run-openai-realtime-bridge.sh /path/to/project
```

Then:

```text
/realtime
```

### 4. Local Whisper + Kokoro

No cloud STT. Slower, but local.

```bash
./scripts/run-local-whisper-kokoro.sh /path/to/project
```

Then:

```text
/realtime
```

### 5. Gemini Live

Gemini handles live voice. Codex still handles delegated code tasks.

```bash
export GEMINI_API_KEY="replace-with-gemini-api-key"
./scripts/run-gemini-live.sh /path/to/project
```

Then:

```text
/realtime
```

## Which One Should I Try?

| Mode | Script | Best For | Notes |
| --- | --- | --- | --- |
| Official OpenAI realtime | `run-official-openai-realtime.sh` | Direct Codex-to-OpenAI test | May use API-key auth for the whole session |
| OpenAI realtime bridge | `run-openai-realtime-bridge.sh` | OpenAI voice with normal Codex auth | Uses OpenAI API key only in the bridge |
| Groq STT + Kokoro | `run-groq-stt-kokoro.sh` | Cheapest/faster STT test | Groq listens, Kokoro speaks |
| OpenAI STT + Kokoro | `run-openai-stt-kokoro.sh` | Comparing OpenAI STT only | Not full official realtime |
| Local Whisper medium + Kokoro | `run-local-whisper-kokoro.sh` | Local/private STT | Slower |
| Local Whisper tiny + Kokoro | `run-local-tiny-kokoro.sh` | Very fast local test | Lower accuracy |
| Gemini Live | `run-gemini-live.sh` | Full online live voice model | Behavior may differ from Codex/OpenAI |
| Moshi bridge | `run-moshi-codex-bridge.sh` | Local speech-to-speech research | Experimental |

More detail: [docs/options.md](docs/options.md)

## CLI Wrapper

Use `codex-voice` as the friendly front door:

```bash
codex-voice <mode> /path/to/project
```

Or from inside the project:

```bash
codex-voice <mode>
```

Open the settings TUI:

```bash
codex-voice settings
```

It saves provider defaults in
`~/.config/codex-realtime-voice-kit/settings.json`. Launch flags like
`--voice` and `--model` still override saved settings for that one run.

Modes:

- `official`: official OpenAI realtime API
- `openai-realtime`: OpenAI realtime API through local bridge
- `groq`: Groq speech-to-text + local Kokoro voice
- `openai-stt`: OpenAI speech-to-text + local Kokoro voice
- `local`: local Whisper medium + Kokoro voice
- `tiny`: local Whisper tiny + Kokoro voice
- `gemini`: Gemini Live voice model
- `moshi`: Moshi local speech-to-speech experiment

Management commands:

```bash
codex-voice status
codex-voice stop
codex-voice doctor
codex-voice settings
codex-voice settings show
codex-voice settings reset
codex-voice key list
codex-voice key set gemini
codex-voice key delete gemini
codex-voice gemini --replace-key
codex-voice voices
codex-voice uninstall
codex-voice uninstall --delete-keys
```

If you really want commands like `codex gemini`, add a shell function after
testing `codex-voice`:

```bash
codex() {
  case "$1" in
    gemini|groq|local|tiny|official|openai-realtime|realtime|openai-stt|moshi|status|stop|doctor)
      codex-voice "$@"
      ;;
    *)
      command /Applications/Codex.app/Contents/Resources/codex "$@"
      ;;
  esac
}
```

This keeps normal Codex commands working, and only routes voice-kit commands to
the wrapper.

More detail: [docs/cli.md](docs/cli.md)

## Folder Structure

```text
.
├── bin/
│   └── codex-voice.mjs
├── src/
│   ├── local-codex-realtime-server.mjs
│   └── moshi-codex-bridge.py
├── scripts/
│   ├── run-codex-realtime-bridge.sh
│   ├── run-official-openai-realtime.sh
│   ├── run-openai-realtime-bridge.sh
│   ├── run-groq-stt-kokoro.sh
│   ├── run-openai-stt-kokoro.sh
│   ├── run-local-whisper-kokoro.sh
│   ├── run-local-tiny-kokoro.sh
│   ├── run-gemini-live.sh
│   └── run-moshi-codex-bridge.sh
├── docs/
│   ├── cli.md
│   ├── options.md
│   ├── configuration.md
│   ├── architecture.md
│   └── troubleshooting.md
├── examples/
│   └── run-project.md
├── .env.example
├── .gitignore
└── package.json
```

## Important

Do not commit real API keys.

Use environment variables:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
export GROQ_API_KEY="replace-with-groq-api-key"
export GEMINI_API_KEY="replace-with-gemini-api-key"
```

## Make This a Repo

```bash
cd codex-realtime-voice-kit
git init
npm install
git add .
git commit -m "Initial Codex realtime voice kit"
```
