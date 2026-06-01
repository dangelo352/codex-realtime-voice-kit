# CLI Wrapper

`codex-voice` is a small launcher around the scripts in this repo.

It does three things:

- chooses the realtime mode
- asks for a missing API key and can save it to macOS Keychain
- checks, stops, or uninstalls the running voice-kit pieces

## Install Locally

From the repo folder:

```bash
npm install
npm link
```

Then test:

```bash
codex-voice doctor
```

Enable Codex realtime support once:

```bash
codex-voice setup
```

This updates `~/.codex/config.toml`, makes a backup first, and ensures:

```toml
suppress_unstable_features_warning = true

[features]
realtime_conversation = true
```

Use `--dry-run` to preview without changing files:

```bash
codex-voice setup --dry-run
```

## Run Modes

```bash
codex-voice
codex-voice official /path/to/project
codex-voice openai-realtime /path/to/project
codex-voice groq /path/to/project
codex-voice gemini /path/to/project
codex-voice gemini --voice Leda /path/to/project
codex-voice local /path/to/project
codex-voice tiny /path/to/project
codex-voice openai-stt /path/to/project
codex-voice moshi /path/to/project
```

The project path is optional. If you are already inside the project folder, run:

```bash
codex-voice
codex-voice gemini
codex-voice groq
codex-voice openai-realtime
codex-voice official
```

Plain `codex-voice` opens a launcher menu from the current terminal folder.
Each row is short, and the selected mode shows what provider/model/voice it will
use before it opens Codex.
The menu also includes setup, settings, and status.

Inside Codex CLI, start live voice with:

```text
/realtime
```

## Faster Startup

Gemini mode skips the slow network key pre-check by default. This makes Codex
open faster. If the key is wrong, Gemini will fail when realtime connects.

To force the old pre-check:

```bash
LOCAL_REALTIME_SKIP_GEMINI_KEY_CHECK=0 codex-voice gemini
```

The local bridge also waits only until its health endpoint is ready instead of
sleeping for a fixed second.

## Multiple Sessions

You can run voice mode in more than one project at the same time:

```bash
cd /path/to/project-a
codex-voice gemini

cd /path/to/project-b
codex-voice gemini
```

By default, `codex-voice` picks a free local bridge port for each session and
does not close older Codex clients.

If you want a fixed port:

```bash
LOCAL_REALTIME_PORT=8790 codex-voice gemini
```

To force the old behavior that closes other local realtime Codex clients:

```bash
LOCAL_REALTIME_KILL_OLD_CODEX=1 codex-voice gemini
```

## API Usage

Starting `codex-voice gemini` opens Codex and starts a local bridge, but it does
not connect to Gemini Live yet.

The online realtime model connects when you run:

```text
/realtime
```

When realtime mode closes, the bridge closes the Gemini websocket. The idle
local bridge can stay open without polling the model.

If the Codex thread was resumed, the bridge copies compact Codex session context
into Gemini at realtime startup. This gives Gemini enough memory for short
questions like “what were we doing before?” while Codex remains the source of
truth for real task work.

The bridge shows a short acknowledgement when it starts a Codex task. It does
not speak that acknowledgement by default, so it does not talk over Gemini.
When Codex finishes, the voice reads the full result by default.

## Speaker Echo And Barge-In

The bridge ignores likely speaker/output audio by default, so the assistant is
less likely to hear its own voice.

OpenAI realtime bridge defaults to `safe` barge-in mode. This is best for
laptop speakers because it blocks speaker echo. Pure OpenAI interruption is
available as `official`, but it is best with headphones or real echo
cancellation:

```bash
LOCAL_REALTIME_OPENAI_BARGE_IN_MODE=official codex-voice openai-realtime
```

Barge-in is on by default in safer `transcript` mode. The bridge waits for
Gemini to transcribe real user words before it stops the current voice. This is
less fragile than stopping just because the mic got loud.

```bash
codex-voice gemini
```

If the voice still cuts itself off, disable barge-in for that run:

```bash
codex-voice gemini --no-barge-in
```

Lower `--barge-in-rms` if interruption feels too hard. Raise it if speaker echo
still interrupts the assistant. The bridge also requires a few loud frames in a
row, so short speaker echo spikes should be ignored.

## Gemini Model And Voice

Gemini mode defaults to:

```text
gemini-3.1-flash-live-preview
```

Change the voice or model at launch:

```bash
codex-voice official --voice cedar --model gpt-realtime-1.5
codex-voice openai-realtime --voice marin --model gpt-realtime-mini
codex-voice gemini --voice Aoede
codex-voice gemini --voice Leda
codex-voice gemini --model gemini-3.1-flash-live-preview
```

Or pick from menus and save defaults:

```bash
codex-voice settings
```

The settings menu shows model and voice choices for OpenAI realtime, Gemini,
Groq STT, OpenAI STT, local Whisper, and Kokoro. It also has a custom option if
the provider adds a newer model before this package is updated.

List known voice names:

```bash
codex-voice voices
```

## Keys

The CLI checks environment variables first:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
export GROQ_API_KEY="replace-with-groq-api-key"
export GEMINI_API_KEY="replace-with-gemini-api-key"
```

If a key is missing, the CLI asks for it. On macOS, it can save the key to
Keychain under the service name:

```text
codex-realtime-voice-kit
```

The key is passed to the child process only for that run. It is not written to
this repo.

When you paste a key, input is hidden. After paste, the CLI prints a masked
preview so you know something was received:

```text
Received Gemini API key: masked-key-preview (39 chars)
Use this key? [Y/n]
```

If the saved key is wrong, replace it:

```bash
codex-voice gemini --replace-key
```

If `GEMINI_API_KEY` or `GOOGLE_API_KEY` is already exported in your terminal,
that env value wins over Keychain. The CLI prints a masked preview for env keys
too. To force a fresh paste:

```bash
unset GEMINI_API_KEY GOOGLE_API_KEY GOOGLE_GENAI_API_KEY
codex-voice gemini --replace-key
```

Or manage keys directly:

```bash
codex-voice key list
codex-voice key set gemini
codex-voice key delete gemini
```

## Status

```bash
codex-voice status
```

This checks:

- local realtime bridge on port `18787`
- Moshi bridge on port `8999`
- Codex realtime CLI processes
- whether API keys are available from env or Keychain

JSON output:

```bash
codex-voice status --json
```

## Stop

```bash
codex-voice stop
```

This stops known voice-kit processes:

- `local-codex-realtime-server.mjs`
- `moshi-codex-bridge.py`
- Codex CLI processes started with realtime flags

It only uses known process names or a confirmed health check before stopping a
port listener.

## Doctor

```bash
codex-voice doctor
```

This checks the common setup problems:

- Node version
- package dependencies
- Codex binary path
- Codex realtime feature config
- Keychain availability
- audio helper tools
- current realtime status

## Settings

```bash
codex-voice settings
codex-voice settings show
codex-voice settings reset
```

Saved settings live at
`~/.config/codex-realtime-voice-kit/settings.json`. Command flags and exported
environment variables still win over saved defaults.

## Uninstall

Stop running pieces and print uninstall commands:

```bash
codex-voice uninstall
```

Also remove saved keys:

```bash
codex-voice uninstall --delete-keys
```

Then remove the global command with the one that matches your install:

```bash
npm uninstall -g codex-realtime-voice-kit
npm unlink -g codex-realtime-voice-kit
```

## Optional `codex gemini`

Do this only after `codex-voice` works.

Add this shell function to your shell config:

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

Then this works:

```bash
codex gemini /path/to/project
codex status
codex stop
```

Normal Codex commands still go to the official Codex binary.
