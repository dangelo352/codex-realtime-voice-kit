# Run Against Any Project

From this repo:

```bash
cd /path/to/codex-realtime-voice-kit
```

Run Groq STT + Kokoro:

```bash
export GROQ_API_KEY="replace-with-groq-api-key"
./scripts/run-groq-stt-kokoro.sh /path/to/your/project
```

Inside Codex CLI:

```text
/realtime
```

Say:

```text
What is this codebase about?
```

Or:

```text
Check if there are any open pull requests.
```
