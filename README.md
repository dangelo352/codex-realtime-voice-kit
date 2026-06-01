# Codex Realtime Voice Kit

Run voice/realtime experiments with the normal Codex CLI.

This project keeps **Codex** as the coding agent, then swaps the voice layer.
You can use OpenAI Realtime, Gemini Live, Groq speech-to-text, OpenAI
speech-to-text, local Whisper, Kokoro voice, or Moshi experiments.

> This is experimental. Codex realtime mode is still under development.

## What You Get

- `codex-voice`: a friendly command you can run from any project folder
- a setup menu for API keys, models, and voices
- macOS Keychain support for saved API keys
- multiple voice modes without editing config files
- `status`, `stop`, `doctor`, and `uninstall` commands

## Requirements

- macOS
- Node.js `20` or newer
- Codex app/CLI installed
- one API key for the mode you want to try

Default Codex binary path:

```bash
/Applications/Codex.app/Contents/Resources/codex
```

If your Codex binary is somewhere else:

```bash
export CODEX_BIN="/path/to/codex"
```

## Install

### Option 1: Install from GitHub

Use this when the project is in a GitHub repo.

```bash
git clone https://github.com/manikv12/codex-realtime-voice-kit.git
cd codex-realtime-voice-kit
npm install
npm link
```

`npm link` adds the global commands:

```bash
codex-voice
codex-rt
```

Check the install:

```bash
codex-voice doctor
```

Enable Codex realtime support:

```bash
codex-voice setup
```

### Option 2: Install from npm

Use this if the package has been published to npm.

```bash
npm install -g codex-realtime-voice-kit
codex-voice setup
codex-voice doctor
```

## First Setup

Run this once to turn on Codex realtime mode:

```bash
codex-voice setup
```

This updates `~/.codex/config.toml` and creates a backup first. It ensures:

```toml
suppress_unstable_features_warning = true

[features]
realtime_conversation = true
```

Then open the settings menu from a normal terminal:

```bash
codex-voice settings
```

Use the menu to:

- add API keys
- choose model and voice defaults
- change OpenAI/Gemini/Groq/local settings

API keys are saved in macOS Keychain. The CLI only shows masked previews, not
the full key.

You can also set keys directly:

```bash
codex-voice key set openai
codex-voice key set groq
codex-voice key set gemini
codex-voice key list
```

If you want to paste a fresh key for one provider:

```bash
codex-voice openai-realtime --replace-key
codex-voice gemini --replace-key
codex-voice groq --replace-key
```

Environment variables also work and are checked before Keychain:

```bash
export OPENAI_API_KEY="replace-with-openai-api-key"
export GROQ_API_KEY="replace-with-groq-api-key"
export GEMINI_API_KEY="replace-with-gemini-api-key"
```

## Start Voice Mode

Go to the project you want Codex to work on:

```bash
cd /path/to/your/project
codex-voice
```

Pick a mode from the menu.

The menu also has **Setup Codex realtime**, **Settings**, and **Status**.

Or start a mode directly:

```bash
codex-voice openai-realtime
codex-voice gemini
codex-voice groq
codex-voice local
```

When Codex opens, type:

```text
/realtime
```

That starts live voice mode.

The project path is optional. These two commands do the same thing:

```bash
cd /path/to/your/project
codex-voice openai-realtime
```

```bash
codex-voice openai-realtime /path/to/your/project
```

## Recommended Mode

For most testing, start with:

```bash
codex-voice openai-realtime
```

This mode uses the OpenAI Realtime API for voice, but keeps normal Codex for
coding work.

On laptop speakers, the OpenAI bridge defaults to safe speaker mode. This helps
stop the assistant from hearing its own voice and looping.

If you use headphones and want pure OpenAI interruption behavior:

```bash
LOCAL_REALTIME_OPENAI_BARGE_IN_MODE=official codex-voice openai-realtime
```

## Modes

| Mode | Command | Good For |
| --- | --- | --- |
| OpenAI Realtime bridge | `codex-voice openai-realtime` | Best OpenAI voice test while Codex still handles coding |
| xAI Grok Voice bridge | `codex-voice xai` | Grok Voice Agent through the OpenAI-compatible realtime bridge |
| Official OpenAI realtime | `codex-voice official` | Direct Codex-to-OpenAI realtime test |
| Gemini Live | `codex-voice gemini` | Google Gemini Live voice test |
| Groq STT + Kokoro | `codex-voice groq` | Fast cheaper speech-to-text plus local voice |
| OpenAI STT + Kokoro | `codex-voice openai-stt` | OpenAI transcription plus local voice |
| Local Whisper medium + Kokoro | `codex-voice local` | Local/private speech-to-text |
| Local Whisper tiny + Kokoro | `codex-voice tiny` | Fast local test with lower accuracy |
| Moshi | `codex-voice moshi` | Local speech-to-speech experiment |

## Change Model Or Voice

Use settings:

```bash
codex-voice settings
```

Or pass a value for one run:

```bash
codex-voice openai-realtime --model gpt-realtime-mini --voice marin
codex-voice xai --model grok-voice-think-fast-1.0 --voice eve
codex-voice official --model gpt-realtime-1.5 --voice cedar
codex-voice gemini --model gemini-3.1-flash-live-preview --voice Aoede
```

List known voices:

```bash
codex-voice voices
```

Show saved settings:

```bash
codex-voice settings show
```

Saved settings live here:

```text
~/.config/codex-realtime-voice-kit/settings.json
```

## Manage Running Sessions

Check status:

```bash
codex-voice status
```

Stop local voice bridges:

```bash
codex-voice stop
```

Run health checks:

```bash
codex-voice doctor
```

Reset saved provider settings:

```bash
codex-voice settings reset
```

Delete a saved key:

```bash
codex-voice key delete openai
codex-voice key delete groq
codex-voice key delete gemini
```

Uninstall helper files:

```bash
codex-voice uninstall
```

Delete saved keys too:

```bash
codex-voice uninstall --delete-keys
```

Then remove the global command using the install method you used:

```bash
npm unlink -g codex-realtime-voice-kit
```

or:

```bash
npm uninstall -g codex-realtime-voice-kit
```

## How API Usage Works

Opening Codex does not immediately connect to the online realtime model.

The online voice model connects when you type:

```text
/realtime
```

It closes when realtime mode closes.

The local bridge can stay open while idle. It is not meant to keep polling the
online voice model after realtime mode is closed.

## Common Problems

### `codex-voice: command not found`

Run this from the repo folder:

```bash
npm link
```

Or install globally from npm if published:

```bash
npm install -g codex-realtime-voice-kit
```

### Codex binary missing

Set `CODEX_BIN`:

```bash
export CODEX_BIN="/path/to/codex"
codex-voice doctor
```

### It opens Codex but voice does not start

First make sure the Codex realtime flag is enabled:

```bash
codex-voice setup
```

Inside Codex, type:

```text
/realtime
```

### It repeats itself or says the same word many times

That usually means the laptop mic is hearing the speaker.

Use the default safe mode:

```bash
codex-voice openai-realtime
```

For pure official barge-in, use headphones:

```bash
LOCAL_REALTIME_OPENAI_BARGE_IN_MODE=official codex-voice openai-realtime
```

### Wrong or old API key

Replace the saved key:

```bash
codex-voice openai-realtime --replace-key
codex-voice gemini --replace-key
codex-voice groq --replace-key
```

## Advanced: Scripts

The CLI wraps scripts in `scripts/`.

You can still run them directly:

```bash
./scripts/run-openai-realtime-bridge.sh /path/to/project
./scripts/run-gemini-live.sh /path/to/project
./scripts/run-groq-stt-kokoro.sh /path/to/project
./scripts/run-local-whisper-kokoro.sh /path/to/project
```

For normal users, prefer:

```bash
codex-voice
```

## More Docs

- [CLI guide](docs/cli.md)
- [Options](docs/options.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)

## Security

Do not commit real API keys.

Use Keychain through:

```bash
codex-voice settings
```

or environment variables in your local shell only.

## Development

Run checks:

```bash
npm run check
```

Package structure:

```text
.
├── bin/
│   └── codex-voice.mjs
├── src/
│   ├── local-codex-realtime-server.mjs
│   └── moshi-codex-bridge.py
├── scripts/
├── docs/
├── examples/
├── .env.example
└── package.json
```
