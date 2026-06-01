#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as readlineKeys from "node:readline";
import readline from "node:readline/promises";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const scriptsDir = path.join(rootDir, "scripts");
const keychainService = "codex-realtime-voice-kit";
const defaultCodexBin = "/Applications/Codex.app/Contents/Resources/codex";
const defaultLocalRealtimePort = 18787;
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || process.cwd(), ".codex");
const codexConfigPath = path.join(codexHome, "config.toml");
const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || process.cwd(), ".config"),
  "codex-realtime-voice-kit",
);
const settingsPath = path.join(configDir, "settings.json");
const SETTINGS_QUIT = Symbol("settings_quit");
let pipedInputLines = null;

const modes = new Map([
  [
    "official",
    {
      script: "run-official-openai-realtime.sh",
      label: "Official OpenAI realtime",
      key: { env: ["OPENAI_API_KEY"], account: "openai-api-key", name: "OpenAI API key" },
    },
  ],
  [
    "openai-realtime",
    {
      script: "run-openai-realtime-bridge.sh",
      label: "OpenAI Realtime bridge",
      key: { env: ["OPENAI_API_KEY"], account: "openai-api-key", name: "OpenAI API key" },
    },
  ],
  [
    "realtime",
    {
      aliasFor: "openai-realtime",
    },
  ],
  [
    "openai-rt",
    {
      aliasFor: "openai-realtime",
    },
  ],
  [
    "xai",
    {
      script: "run-xai-realtime-bridge.sh",
      label: "xAI Grok Voice realtime bridge",
      key: { env: ["XAI_API_KEY"], account: "xai-api-key", name: "xAI API key" },
    },
  ],
  [
    "grok",
    {
      aliasFor: "xai",
    },
  ],
  [
    "groq",
    {
      script: "run-groq-stt-kokoro.sh",
      label: "Groq STT + Kokoro voice",
      key: { env: ["GROQ_API_KEY"], account: "groq-api-key", name: "Groq API key" },
    },
  ],
  [
    "openai-stt",
    {
      script: "run-openai-stt-kokoro.sh",
      label: "OpenAI STT + Kokoro voice",
      key: { env: ["OPENAI_API_KEY"], account: "openai-api-key", name: "OpenAI API key" },
    },
  ],
  [
    "local",
    {
      script: "run-local-whisper-kokoro.sh",
      label: "Local Whisper medium + Kokoro voice",
    },
  ],
  [
    "whisper",
    {
      aliasFor: "local",
    },
  ],
  [
    "medium",
    {
      aliasFor: "local",
    },
  ],
  [
    "tiny",
    {
      script: "run-local-tiny-kokoro.sh",
      label: "Local Whisper tiny + Kokoro voice",
    },
  ],
  [
    "gemini",
    {
      script: "run-gemini-live.sh",
      label: "Gemini Live",
      key: {
        env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        saveEnv: "GEMINI_API_KEY",
        account: "gemini-api-key",
        name: "Gemini API key",
      },
    },
  ],
  [
    "gemini-flash-live",
    {
      script: "run-gemini-openai-compatible-bridge.sh",
      label: "Gemini Flash Live OpenAI-compatible bridge",
      key: {
        env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        saveEnv: "GEMINI_API_KEY",
        account: "gemini-api-key",
        name: "Gemini API key",
      },
    },
  ],
  [
    "gemini-openai",
    {
      aliasFor: "gemini-flash-live",
    },
  ],
  [
    "gemini-openai-compatible",
    {
      aliasFor: "gemini-flash-live",
    },
  ],
  [
    "flash-live",
    {
      aliasFor: "gemini-flash-live",
    },
  ],
  [
    "google-live",
    {
      aliasFor: "gemini-flash-live",
    },
  ],
  [
    "moshi",
    {
      script: "run-moshi-codex-bridge.sh",
      label: "Moshi local speech-to-speech",
    },
  ],
]);

const keySpecs = [
  { env: ["OPENAI_API_KEY"], account: "openai-api-key", name: "OpenAI" },
  { env: ["XAI_API_KEY"], account: "xai-api-key", name: "xAI" },
  { env: ["GROQ_API_KEY"], account: "groq-api-key", name: "Groq" },
  { env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], account: "gemini-api-key", name: "Gemini" },
];

const openAIRealtimeVoices = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
];

const codexLegacyRealtimeVoices = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
];

const openAIRealtimeModels = [
  "gpt-realtime-2",
  "gpt-realtime-mini",
  "gpt-realtime-1.5",
  "gpt-realtime",
  "gpt-realtime-mini-2025-12-15",
  "gpt-realtime-mini-2025-10-06",
  "gpt-realtime-2025-08-28",
];

const geminiVoices = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];

const geminiLiveModels = [
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash-live-preview",
  "gemini-live-2.5-flash-preview",
  "gemini-2.0-flash-live-001",
];

const openAISttModels = [
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
];

const groqSttModels = [
  "whisper-large-v3-turbo",
  "whisper-large-v3",
];

const localWhisperModels = [
  "Xenova/whisper-tiny.en",
  "Xenova/whisper-base.en",
  "Xenova/whisper-small.en",
  "Xenova/whisper-medium.en",
];

const kokoroVoices = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
];

const settingsProviders = [
  {
    key: "official",
    label: "Official OpenAI realtime",
    script: "run-official-openai-realtime.sh",
    fields: [
      { key: "model", label: "Realtime model", env: "CODEX_REALTIME_MODEL", defaultValue: "gpt-realtime-1.5", choices: openAIRealtimeModels },
      {
        key: "voice",
        label: "Voice",
        env: "CODEX_REALTIME_VOICE",
        defaultValue: "marin",
        choices: [...openAIRealtimeVoices, ...codexLegacyRealtimeVoices],
      },
    ],
  },
  {
    key: "openai-realtime",
    label: "OpenAI realtime bridge",
    script: "run-openai-realtime-bridge.sh",
    fields: [
      { key: "model", label: "Realtime model", env: "LOCAL_REALTIME_OPENAI_REALTIME_MODEL", defaultValue: "gpt-realtime-mini", choices: openAIRealtimeModels },
      { key: "voice", label: "Voice", env: "LOCAL_REALTIME_OPENAI_REALTIME_VOICE", defaultValue: "marin", choices: openAIRealtimeVoices },
      { key: "bargeInMode", label: "Barge-in mode", env: "LOCAL_REALTIME_OPENAI_BARGE_IN_MODE", defaultValue: "safe", choices: ["safe", "official", "local", "off"] },
      { key: "bargeInRms", label: "Local barge-in RMS", env: "LOCAL_REALTIME_OPENAI_BARGE_IN_RMS", defaultValue: "3200" },
      { key: "bargeInFrames", label: "Local barge-in frames", env: "LOCAL_REALTIME_OPENAI_BARGE_IN_FRAMES", defaultValue: "8" },
    ],
  },
  {
    key: "xai",
    label: "xAI Grok Voice realtime bridge",
    script: "run-xai-realtime-bridge.sh",
    fields: [
      { key: "model", label: "Realtime model", env: "LOCAL_REALTIME_OPENAI_REALTIME_MODEL", defaultValue: "grok-voice-think-fast-1.0", choices: ["grok-voice-think-fast-1.0", "grok-voice-latest", "Custom"] },
      { key: "voice", label: "Voice", env: "LOCAL_REALTIME_OPENAI_REALTIME_VOICE", defaultValue: "eve", choices: ["eve", "Custom"] },
      { key: "bargeInMode", label: "Barge-in mode", env: "LOCAL_REALTIME_OPENAI_BARGE_IN_MODE", defaultValue: "safe", choices: ["safe", "official", "local", "off"] },
    ],
  },
  {
    key: "gemini",
    label: "Gemini Live",
    script: "run-gemini-live.sh",
    fields: [
      { key: "model", label: "Live model", env: "LOCAL_REALTIME_GEMINI_MODEL", defaultValue: "gemini-3.1-flash-live-preview", choices: geminiLiveModels },
      { key: "voice", label: "Voice", env: "LOCAL_REALTIME_GEMINI_VOICE", defaultValue: "Aoede", choices: geminiVoices },
      { key: "bargeIn", label: "Barge-in", env: "LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN", defaultValue: "1", type: "boolean" },
      { key: "bargeInRms", label: "Barge-in RMS", env: "LOCAL_REALTIME_GEMINI_BARGE_IN_RMS", defaultValue: "4200" },
      { key: "bargeInMinMs", label: "Barge-in min ms", env: "LOCAL_REALTIME_GEMINI_BARGE_IN_MIN_MS", defaultValue: "1500" },
    ],
  },
  {
    key: "groq",
    label: "Groq STT + Kokoro",
    script: "run-groq-stt-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_GROQ_TRANSCRIBE_MODEL", defaultValue: "whisper-large-v3-turbo", choices: groqSttModels },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart", choices: kokoroVoices },
    ],
  },
  {
    key: "openai-stt",
    label: "OpenAI STT + Kokoro",
    script: "run-openai-stt-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_TRANSCRIBE_MODEL", defaultValue: "gpt-4o-mini-transcribe", choices: openAISttModels },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart", choices: kokoroVoices },
    ],
  },
  {
    key: "local",
    label: "Local Whisper medium + Kokoro",
    script: "run-local-whisper-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_LOCAL_STT_MODEL", defaultValue: "Xenova/whisper-medium.en", choices: localWhisperModels },
      { key: "device", label: "STT device", env: "LOCAL_REALTIME_LOCAL_STT_DEVICE", defaultValue: "cpu", choices: ["cpu", "wasm"] },
      { key: "dtype", label: "STT dtype", env: "LOCAL_REALTIME_LOCAL_STT_DTYPE", defaultValue: "q8", choices: ["q8", "fp32", "fp16", "q4"] },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart", choices: kokoroVoices },
    ],
  },
  {
    key: "tiny",
    label: "Local Whisper tiny + Kokoro",
    script: "run-local-tiny-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_LOCAL_STT_MODEL", defaultValue: "Xenova/whisper-tiny.en", choices: localWhisperModels },
      { key: "device", label: "STT device", env: "LOCAL_REALTIME_LOCAL_STT_DEVICE", defaultValue: "cpu", choices: ["cpu", "wasm"] },
      { key: "dtype", label: "STT dtype", env: "LOCAL_REALTIME_LOCAL_STT_DTYPE", defaultValue: "q8", choices: ["q8", "fp32", "fp16", "q4"] },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart", choices: kokoroVoices },
    ],
  },
];

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    await launchMenu();
    return;
  }

  const command = argv[0].toLowerCase();

  if (command === "help" || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "status") {
    await printStatus({ json: argv.includes("--json") });
    return;
  }

  if (command === "stop") {
    await stopKnownProcesses();
    return;
  }

  if (command === "doctor") {
    await doctor();
    return;
  }

  if (command === "setup") {
    await setupCodexConfig(argv.slice(1));
    return;
  }

  if (command === "settings" || command === "config") {
    await settingsTui(argv.slice(1));
    return;
  }

  if (command === "uninstall") {
    await uninstall({ deleteKeys: argv.includes("--delete-keys") });
    return;
  }

  if (command === "key" || command === "keys") {
    await manageKeys(argv.slice(1));
    return;
  }

  if (command === "voices") {
    printGeminiVoices();
    return;
  }

  const mode = resolveMode(command);
  if (!mode) {
    console.error(`Unknown command or mode: ${command}`);
    console.error("Run: codex-voice help");
    process.exit(1);
  }

  const { childArgs, options } = parseLaunchArgs(argv.slice(1));
  await launchMode(mode, childArgs, options);
}

async function launchMenu() {
  while (true) {
    const settings = readSettings();
    const choice = await promptMenu({
      title: "Codex Voice",
      lines: [`Open Codex voice in: ${process.cwd()}`],
      items: [
        ...launchableModes().map(({ name, mode }) => ({
          label: mode.label,
          hint: launchModeDetails(name, mode, settings),
          value: { type: "mode", mode },
        })),
        { label: "Setup Codex realtime", hint: "Turn on realtime_conversation in ~/.codex/config.toml.", value: { type: "setup" } },
        { label: "Settings", hint: "Change model, voice, and provider defaults.", value: { type: "settings" } },
        { label: "Status", hint: "Check running bridges, Codex realtime clients, and saved keys.", value: { type: "status" } },
      ],
      hintLabel: "Mode",
      allowQuit: true,
    });

    if (choice === "quit" || choice === "back" || !choice) return;
    if (choice.type === "settings") {
      await settingsTui([]);
      continue;
    }
    if (choice.type === "setup") {
      clearScreen();
      await setupCodexConfig([]);
      await pauseForEnter();
      continue;
    }
    if (choice.type === "status") {
      clearScreen();
      await printStatus();
      await pauseForEnter();
      continue;
    }
    if (choice.type === "mode") {
      await launchMode(choice.mode, [], {});
      return;
    }
  }
}

function launchableModes() {
  return [
    "openai-realtime",
    "xai",
    "gemini-flash-live",
    "gemini",
    "groq",
    "openai-stt",
    "local",
    "tiny",
    "moshi",
    "official",
  ]
    .map((name) => ({ name, mode: resolveMode(name) }))
    .filter((item) => item.mode?.script);
}

function launchModeDetails(name, mode, settings) {
  const provider = providerForMode(mode);
  const detail = provider ? providerSummary(settings, provider) : "";
  const key = mode.key ? `${mode.key.name}: ${keySource(mode.key)}` : "No API key needed";
  const description = {
    official: "Uses Codex official realtime API support.",
    "openai-realtime": "Uses OpenAI realtime for voice, then delegates code work to Codex.",
    xai: "Uses xAI Grok Voice through the OpenAI-compatible realtime bridge.",
    gemini: "Uses Gemini Live for voice, then delegates code work to Codex.",
    "gemini-flash-live": "Uses Gemini Live behind the local OpenAI-compatible realtime bridge.",
    groq: "Uses Groq for speech-to-text and Kokoro for spoken replies.",
    "openai-stt": "Uses OpenAI transcription and Kokoro for spoken replies.",
    local: "Uses local Whisper medium and Kokoro. Slower, but local for voice.",
    tiny: "Uses local Whisper tiny and Kokoro. Faster, but less accurate.",
    moshi: "Runs local Moshi speech-to-speech test mode.",
  }[name] || mode.label;

  return detail ? [description, detail, key] : [description, key];
}

function resolveMode(name) {
  const seen = new Set();
  let modeName = name;
  while (modes.has(modeName)) {
    if (seen.has(modeName)) return null;
    seen.add(modeName);
    const mode = modes.get(modeName);
    if (!mode.aliasFor) return mode;
    modeName = mode.aliasFor;
  }
  return null;
}

async function launchMode(mode, childArgs, options = {}) {
  const scriptPath = path.join(scriptsDir, mode.script);
  if (!existsSync(scriptPath)) {
    console.error(`Missing script: ${scriptPath}`);
    process.exit(1);
  }

  const env = { ...process.env };
  applySavedSettings(mode, env, readSettings());
  await ensureKey(mode.key, env, options);
  applyLaunchOptions(mode, env, options);

  if (!env.CODEX_BIN) {
    env.CODEX_BIN = defaultCodexBin;
  }

  if (usesLocalBridge(mode)) {
    if (!env.LOCAL_REALTIME_PORT) {
      const preferredPort = Number(env.CODEX_VOICE_PORT_START || defaultLocalRealtimePort);
      const preferredHealth = await getHealth(`http://127.0.0.1:${preferredPort}/health`);
      env.LOCAL_REALTIME_PORT = preferredHealth.body.includes("local-codex-realtime")
        ? String(preferredPort)
        : String(await findFreePort(preferredPort));
      console.error(`Using local realtime bridge port ${env.LOCAL_REALTIME_PORT}`);
    }
    env.LOCAL_REALTIME_KILL_OLD_CODEX ??= "0";
  }

  const args = childArgs.length ? childArgs : [process.cwd()];

  console.log(`Starting: ${mode.label}`);
  if (process.stdin.isTTY) process.stdin.pause();
  const child = spawn(scriptPath, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function parseLaunchArgs(args) {
  const childArgs = [];
  const options = {
    replaceKey: false,
    voice: "",
    model: "",
    bargeInRms: "",
    bargeInMinMs: "",
    noBargeIn: false,
    bargeIn: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--replace-key") {
      options.replaceKey = true;
      continue;
    }
    if (arg === "--no-barge-in") {
      options.noBargeIn = true;
      continue;
    }
    if (arg === "--barge-in") {
      options.bargeIn = true;
      continue;
    }

    const parsed = parseOptionWithValue(args, index, {
      "--voice": "voice",
      "--model": "model",
      "--barge-in-rms": "bargeInRms",
      "--barge-rms": "bargeInRms",
      "--barge-in-min-ms": "bargeInMinMs",
      "--barge-min-ms": "bargeInMinMs",
    });
    if (parsed) {
      options[parsed.key] = parsed.value;
      index = parsed.index;
      continue;
    }

    childArgs.push(arg);
  }

  return { childArgs, options };
}

function parseOptionWithValue(args, index, keys) {
  const arg = args[index];
  for (const [name, key] of Object.entries(keys)) {
    if (arg === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${name} needs a value.`);
        process.exit(1);
      }
      return { key, value, index: index + 1 };
    }
    if (arg.startsWith(`${name}=`)) {
      return { key, value: arg.slice(name.length + 1), index };
    }
  }
  return null;
}

function applyLaunchOptions(mode, env, options = {}) {
  if (options.bargeIn) {
    env.LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN = "1";
  }
  if (options.noBargeIn) {
    env.LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN = "0";
  }
  if (options.bargeInRms) {
    env.LOCAL_REALTIME_GEMINI_BARGE_IN_RMS = options.bargeInRms;
    env.LOCAL_REALTIME_BARGE_IN_RMS = options.bargeInRms;
  }
  if (options.bargeInMinMs) {
    env.LOCAL_REALTIME_GEMINI_BARGE_IN_MIN_MS = options.bargeInMinMs;
    env.LOCAL_REALTIME_BARGE_IN_MIN_MS = options.bargeInMinMs;
  }
  if (mode.script === "run-gemini-live.sh" || mode.script === "run-gemini-openai-compatible-bridge.sh") {
    if (options.voice) env.LOCAL_REALTIME_GEMINI_VOICE = options.voice;
    if (options.model) env.LOCAL_REALTIME_GEMINI_MODEL = options.model;
  } else if (mode.script === "run-official-openai-realtime.sh") {
    if (options.voice) env.CODEX_REALTIME_VOICE = options.voice.toLowerCase();
    if (options.model) env.CODEX_REALTIME_MODEL = options.model;
  } else if (mode.script === "run-openai-realtime-bridge.sh" || mode.script === "run-xai-realtime-bridge.sh") {
    if (options.voice) env.LOCAL_REALTIME_OPENAI_REALTIME_VOICE = options.voice;
    if (options.model) env.LOCAL_REALTIME_OPENAI_REALTIME_MODEL = options.model;
  } else if (options.voice) {
    env.LOCAL_REALTIME_KOKORO_VOICE = options.voice;
    env.LOCAL_REALTIME_SAY_VOICE = options.voice;
  }
}

function usesLocalBridge(mode) {
  return mode.script !== "run-official-openai-realtime.sh";
}

function providerForMode(mode) {
  if (mode.script === "run-gemini-openai-compatible-bridge.sh") {
    return settingsProviders.find((provider) => provider.key === "gemini") || null;
  }
  return settingsProviders.find((provider) => provider.script === mode.script) || null;
}

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function applySavedSettings(mode, env, settings) {
  const provider = providerForMode(mode);
  if (!provider) return;
  const saved = settings[provider.key];
  if (!saved || typeof saved !== "object") return;

  for (const field of provider.fields) {
    const value = saved[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (env[field.env]) continue;
    env[field.env] = String(value);
  }
}

async function settingsTui(args = []) {
  const action = (args[0] || "").toLowerCase();
  if (action === "show" || action === "list" || action === "--json") {
    const settings = readSettings();
    if (action === "--json") {
      console.log(JSON.stringify(settings, null, 2));
    } else {
      printSettings(settings);
    }
    return;
  }
  if (action === "reset" || action === "clear") {
    if (existsSync(settingsPath)) rmSync(settingsPath);
    console.log(`Deleted settings: ${settingsPath}`);
    return;
  }

  let settings = readSettings();
  while (true) {
    const choice = await promptMenu({
      title: "Codex Voice Settings",
      lines: ["Choose a provider."],
      items: [
        ...settingsProviders.map((provider) => ({
          label: provider.label,
          hint: providerSummary(settings, provider),
          value: { type: "provider", provider },
        })),
        { label: "API keys", hint: keySettingsSummary(), value: { type: "keys" } },
        { label: "Show current settings", value: { type: "show" } },
        { label: "Reset all settings", value: { type: "reset" } },
      ],
      allowQuit: true,
    });

    if (choice === "quit" || choice === "back") return;
    if (choice?.type === "show") {
      clearScreen();
      printSettings(settings);
      await pauseForEnter();
      continue;
    }
    if (choice?.type === "reset") {
      const confirm = await promptMenu({
        title: "Reset Settings",
        lines: ["Delete all saved provider settings? API keys in Keychain are kept."],
        items: [
          { label: "No, keep settings", value: false },
          { label: "Yes, delete all settings", value: true },
        ],
        allowBack: true,
      });
      if (confirm === true) {
        settings = {};
        if (existsSync(settingsPath)) rmSync(settingsPath);
        console.log("Settings deleted.");
        await pauseForEnter();
      }
      continue;
    }

    if (choice?.type === "keys") {
      await settingsKeysTui();
      continue;
    }

    if (choice?.type === "provider") {
      const result = await editProviderSettings(settings, choice.provider);
      settings = result.settings;
      writeSettings(settings);
      if (result.quit) return;
    }
  }
}

async function settingsKeysTui() {
  while (true) {
    const choice = await promptMenu({
      title: "API Keys",
      lines: ["Keys are saved in macOS Keychain. Env vars override Keychain for this shell."],
      items: [
        ...keySpecs.map((spec) => ({
          label: `${spec.name} API key`,
          hint: keySettingHint(spec),
          value: { type: "key", spec },
        })),
        { label: "Show key status", hint: keySettingsSummary(), value: { type: "show" } },
      ],
      allowBack: true,
    });

    if (choice === "quit" || choice === "back") return;
    if (choice?.type === "show") {
      clearScreen();
      printKeySettings();
      await pauseForEnter();
      continue;
    }
    if (choice?.type === "key") {
      await editKeySetting(choice.spec);
    }
  }
}

async function editKeySetting(spec) {
  while (true) {
    const choice = await promptMenu({
      title: `${spec.name} API Key`,
      lines: [`Current: ${keySettingHint(spec)}`, "The full key is never printed."],
      items: [
        { label: "Set or replace Keychain key", value: "set" },
        { label: "Delete Keychain key", value: "delete" },
      ],
      allowBack: true,
    });

    if (choice === "quit" || choice === "back") return;
    if (choice === "set") {
      if (!hasSecurity()) {
        console.log("macOS Keychain is not available on this machine.");
        await pauseForEnter();
        continue;
      }
      const pasted = await promptKeyWithConfirmation(`${spec.name} API key`);
      if (!pasted) {
        console.log("No key saved.");
        await pauseForEnter();
        continue;
      }
      const ok = saveKeychain(spec.account, pasted);
      console.log(ok ? `Saved ${spec.name} key to macOS Keychain.` : `Could not save ${spec.name} key.`);
      await pauseForEnter();
      continue;
    }
    if (choice === "delete") {
      const confirm = await promptMenu({
        title: `Delete ${spec.name} Key`,
        lines: ["Remove this key from macOS Keychain? Env vars are not changed."],
        items: [
          { label: "No, keep key", value: false },
          { label: "Yes, delete Keychain key", value: true },
        ],
        allowBack: true,
      });
      if (confirm === true) {
        const ok = deleteKeychain(spec.account);
        console.log(`${spec.name} Keychain entry: ${ok ? "deleted or not present" : "could not delete"}`);
        await pauseForEnter();
      }
    }
  }
}

async function editProviderSettings(settings, provider) {
  if (!settings[provider.key] || typeof settings[provider.key] !== "object") {
    settings[provider.key] = {};
  }

  while (true) {
    const saved = settings[provider.key] || {};
    const choice = await promptMenu({
      title: provider.label,
      lines: ["Pick a setting to change. Esc or b goes back."],
      items: [
        ...provider.fields.map((field) => ({
          label: field.label,
          hint: settingDisplayValue(saved, field),
          value: { type: "field", field },
        })),
        { label: "Clear saved settings for this provider", value: { type: "clear" } },
      ],
      allowBack: true,
    });

    if (choice === "quit") return finishProviderEdit(settings, provider, true);
    if (choice === "back") break;
    if (choice?.type === "clear") {
      const confirm = await promptMenu({
        title: `Clear ${provider.label}`,
        lines: ["Remove only this provider's saved settings?"],
        items: [
          { label: "No, keep them", value: false },
          { label: "Yes, clear provider settings", value: true },
        ],
        allowBack: true,
      });
      if (confirm === true) {
        delete settings[provider.key];
        break;
      }
      continue;
    }

    if (choice?.type !== "field") continue;
    const field = choice.field;
    const current = settings[provider.key]?.[field.key] ?? field.defaultValue ?? "";
    const value = await editSettingField(field, current);
    if (value === SETTINGS_QUIT) return finishProviderEdit(settings, provider, true);
    if (value === undefined) continue;
    if (!settings[provider.key] || typeof settings[provider.key] !== "object") {
      settings[provider.key] = {};
    }
    if (value === "-") {
      delete settings[provider.key][field.key];
      continue;
    }
    settings[provider.key][field.key] = value;
  }

  return finishProviderEdit(settings, provider, false);
}

function finishProviderEdit(settings, provider, quit) {
  if (settings[provider.key] && !Object.keys(settings[provider.key]).length) {
    delete settings[provider.key];
  }
  return { settings, quit };
}

async function editSettingField(field, current) {
  if (field.type === "boolean") {
    const currentOn = String(current || "1") !== "0";
    return promptMenu({
      title: field.label,
      lines: [`Current: ${currentOn ? "On" : "Off"}`],
      items: [
        { label: "On", value: "1" },
        { label: "Off", value: "0" },
        { label: "Clear saved value", value: "-" },
      ],
      allowBack: true,
    }).then((value) => {
      if (value === "quit") return SETTINGS_QUIT;
      if (value === "back") return undefined;
      return value;
    });
  }

  if (field.choices?.length) {
    const value = await promptMenu({
      title: field.label,
      lines: [`Current: ${current || "(empty)"}`],
      items: [
        ...field.choices.map((choice) => ({ label: choice, value: choice })),
        { label: "Custom value", value: "__custom" },
        { label: "Clear saved value", value: "-" },
      ],
      allowBack: true,
    });
    if (value === "quit") return SETTINGS_QUIT;
    if (value === "back") return undefined;
    if (value === "__custom") {
      const custom = await askLine(`Custom ${field.label}: `);
      return custom.trim() || undefined;
    }
    return value;
  }

  const answer = await askLine(`${field.label} [${current || ""}]: `);
  if (!answer.trim()) return undefined;
  return answer.trim();
}

function printSettings(settings = readSettings()) {
  console.log("Codex Voice Settings");
  console.log("");
  for (const provider of settingsProviders) {
    console.log(provider.label);
    const saved = settings[provider.key] || {};
    for (const field of provider.fields) {
      const value = saved[field.key] || field.defaultValue || "";
      const source = saved[field.key] ? "saved" : "default";
      console.log(`  ${field.label}: ${value || "(empty)"} (${source})`);
    }
    console.log("");
  }
  printKeySettings();
}

function providerSummary(settings, provider) {
  const saved = settings[provider.key] || {};
  return provider.fields
    .slice(0, 2)
    .map((field) => `${field.label}: ${settingDisplayValue(saved, field)}`)
    .join(" | ");
}

function settingDisplayValue(saved, field) {
  const hasSaved = saved[field.key] !== undefined && saved[field.key] !== null && saved[field.key] !== "";
  const value = hasSaved ? saved[field.key] : field.defaultValue || "";
  if (field.type === "boolean") {
    return String(value || "1") === "0" ? "Off" : "On";
  }
  return `${value || "(empty)"}${hasSaved ? "" : " (default)"}`;
}

function printKeySettings() {
  console.log("API Keys");
  for (const spec of keySpecs) {
    console.log(`  ${spec.name}: ${keySettingHint(spec)}`);
  }
  console.log("");
}

function keySettingsSummary() {
  return keySpecs.map((spec) => `${spec.name}: ${keySource(spec)}`).join(" | ");
}

function keySettingHint(spec) {
  const envName = spec.env.find((name) => process.env[name]);
  if (envName) return `env ${envName} ${maskSecret(process.env[envName])}`;
  const loaded = readKeychain(spec.account);
  if (loaded) return `keychain ${maskSecret(loaded)}`;
  return "missing";
}

async function promptMenu({ title, lines = [], items = [], allowBack = false, allowQuit = false, hintLabel = "Current" }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return promptMenuFallback({ title, lines, items, allowBack, allowQuit });
  }

  return new Promise((resolve) => {
    let selected = 0;
    let digits = "";
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const wasPaused = stdin.isPaused();
    readlineKeys.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    const cleanup = () => {
      stdin.off("keypress", onKeypress);
      if (!wasRaw) stdin.setRawMode(false);
      if (wasPaused) stdin.pause();
      process.stdout.write("\n");
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };

    const chooseCurrent = () => {
      if (digits) {
        const index = Number(digits) - 1;
        digits = "";
        if (items[index]) {
          finish(items[index].value);
          return;
        }
        renderMenu({ title, lines, items, selected, digits, allowBack, allowQuit, hintLabel, error: "No item with that number." });
        return;
      }
      finish(items[selected]?.value);
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (key.name === "escape") {
        finish(allowBack ? "back" : "quit");
        return;
      }
      if (key.name === "return") {
        chooseCurrent();
        return;
      }
      if (key.name === "up") {
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        digits = "";
      } else if (key.name === "down") {
        selected = selected >= items.length - 1 ? 0 : selected + 1;
        digits = "";
      } else if (key.name === "backspace" || key.name === "delete") {
        digits = digits.slice(0, -1);
      } else if (/^[0-9]$/.test(str || "")) {
        digits = `${digits}${str}`.replace(/^0+/, "");
      } else if ((str || "").toLowerCase() === "b" && allowBack) {
        finish("back");
        return;
      } else if ((str || "").toLowerCase() === "q") {
        finish("quit");
        return;
      }

      renderMenu({ title, lines, items, selected, digits, allowBack, allowQuit, hintLabel });
    };

    stdin.on("keypress", onKeypress);
    renderMenu({ title, lines, items, selected, digits, allowBack, allowQuit, hintLabel });
  });
}

function renderMenu({ title, lines, items, selected, digits, allowBack, allowQuit, hintLabel = "Current", error = "" }) {
  clearScreen();
  console.log(title);
  console.log("");
  for (const line of lines) console.log(line);
  if (lines.length) console.log("");
  items.forEach((item, index) => {
    const marker = index === selected ? ">" : " ";
    console.log(`${marker} ${index + 1}. ${item.label}`);
  });
  console.log("");
  const selectedHint = items[selected]?.hint;
  if (selectedHint) {
    const hintLines = Array.isArray(selectedHint) ? selectedHint : [selectedHint];
    console.log(`${hintLabel}: ${hintLines[0]}`);
    for (const line of hintLines.slice(1)) {
      console.log(`  ${line}`);
    }
    console.log("");
  }
  const parts = ["number + Enter", "Up/Down"];
  if (allowBack) parts.push("Esc/b = Back");
  parts.push("q = Quit");
  console.log(parts.join("  |  "));
  if (digits) console.log(`Choice: ${digits}`);
  if (error) console.log(error);
}

async function promptMenuFallback({ title, lines, items, allowBack, allowQuit }) {
  clearScreen();
  console.log(title);
  console.log("");
  for (const line of lines) console.log(line);
  if (lines.length) console.log("");
  items.forEach((item, index) => {
    console.log(`${index + 1}. ${item.label}`);
  });
  if (allowBack) console.log("b. Back");
  console.log("q. Quit");
  const answer = (await askLine("Choose: ")).trim().toLowerCase();
  if (allowBack && (answer === "b" || answer === "back")) return "back";
  if (answer === "q" || answer === "quit") return "quit";
  return items[Number(answer) - 1]?.value;
}

async function askLine(prompt) {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt);
    if (!pipedInputLines) {
      pipedInputLines = readFileSync(0, "utf8").split(/\r?\n/);
    }
    const value = pipedInputLines.shift() ?? "";
    process.stdout.write(`${value}\n`);
    return value;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function pauseForEnter() {
  await askLine("\nPress Enter to continue...");
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
}

async function findFreePort(startPort) {
  const maxTries = Number(process.env.CODEX_VOICE_PORT_TRIES || 100);
  for (let offset = 0; offset < maxTries; offset += 1) {
    const port = startPort + offset;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Could not find a free local realtime port starting at ${startPort}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function ensureKey(key, env, options = {}) {
  if (!key) return;
  const existingEnv = key.env.find((name) => env[name]);
  if (existingEnv && !options.replaceKey) {
    console.error(`Using ${key.name} from env ${existingEnv}: ${maskSecret(env[existingEnv])}`);
    return;
  }

  if (existingEnv && options.replaceKey) {
    console.error(`Ignoring env ${existingEnv} because --replace-key was passed.`);
    for (const name of key.env) {
      delete env[name];
    }
  }

  if (options.replaceKey) {
    deleteKeychain(key.account);
  }

  const loaded = readKeychain(key.account);
  if (loaded) {
    console.error(`Using ${key.name} from macOS Keychain: ${maskSecret(loaded)}`);
    env[key.saveEnv || key.env[0]] = loaded;
    return;
  }

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`${key.name} is missing.`);
    console.error(`Set ${key.env[0]} first, or run this command in an interactive terminal.`);
    process.exit(1);
  }

  console.error(`${key.name} is missing.`);
  const pasted = await promptKeyWithConfirmation(key.name);
  if (!pasted) {
    console.error("No key entered.");
    process.exit(1);
  }

  env[key.saveEnv || key.env[0]] = pasted;

  if (hasSecurity()) {
    const save = await askYesNo("Save it to macOS Keychain for next time?", true);
    if (save) {
      const saved = saveKeychain(key.account, pasted);
      console.error(saved ? "Saved to macOS Keychain." : "Could not save to Keychain; using it for this run only.");
    }
  } else {
    console.error("Keychain is not available; using it for this run only.");
  }
}

async function promptKeyWithConfirmation(keyName) {
  while (true) {
    const pasted = promptSecret(`Paste ${keyName} (input hidden, press Enter): `).trim();
    if (!pasted) return "";
    console.error(`Received ${keyName}: ${maskSecret(pasted)}`);
    const useIt = await askYesNo("Use this key?", true);
    if (useIt) return pasted;
    const retry = await askYesNo("Paste again?", true);
    if (!retry) return "";
  }
}

function promptSecret(prompt) {
  const script = `
    printf '%s' "$1" >&2
    IFS= read -r -s value
    printf '\\n' >&2
    printf '%s' "$value"
  `;
  const result = spawnSync("bash", ["-lc", script, "bash", prompt], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout || "";
}

async function askYesNo(question, defaultYes) {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question + suffix)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function manageKeys(args) {
  const action = (args[0] || "list").toLowerCase();
  const keyName = args[1]?.toLowerCase();
  const spec = keyName ? findKeySpec(keyName) : null;

  if (action === "list" || action === "status") {
    console.log("Saved API keys:");
    for (const item of keySpecs) {
      const loaded = readKeychain(item.account);
      const envName = item.env.find((name) => process.env[name]);
      if (envName) {
        console.log(`  ${item.name}: env (${envName})`);
      } else if (loaded) {
        console.log(`  ${item.name}: keychain ${maskSecret(loaded)}`);
      } else {
        console.log(`  ${item.name}: missing`);
      }
    }
    return;
  }

  if (!spec) {
    console.error("Choose a key: openai, xai, groq, or gemini");
    console.error("Examples:");
    console.error("  codex-voice key set gemini");
    console.error("  codex-voice key delete gemini");
    process.exit(1);
  }

  if (action === "delete" || action === "remove" || action === "reset") {
    const ok = deleteKeychain(spec.account);
    console.log(`${spec.name} Keychain entry: ${ok ? "deleted or not present" : "could not delete"}`);
    return;
  }

  if (action === "set" || action === "replace") {
    const pasted = await promptKeyWithConfirmation(`${spec.name} API key`);
    if (!pasted) {
      console.error("No key saved.");
      process.exit(1);
    }
    const ok = saveKeychain(spec.account, pasted);
    console.log(ok ? `Saved ${spec.name} key to macOS Keychain.` : `Could not save ${spec.name} key.`);
    return;
  }

  console.error(`Unknown key action: ${action}`);
  console.error("Use: codex-voice key list | key set openai | key set xai | key set gemini | key delete gemini");
  process.exit(1);
}

function findKeySpec(name) {
  if (name === "openai" || name === "official" || name === "openai-realtime" || name === "realtime") return keySpecs[0];
  if (name === "xai" || name === "grok") return keySpecs[1];
  if (name === "groq") return keySpecs[2];
  if (name === "gemini" || name === "google") return keySpecs[3];
  return null;
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "(empty)";
  if (text.length <= 8) return `${"*".repeat(text.length)} (${text.length} chars)`;
  return `${text.slice(0, 4)}...${text.slice(-4)} (${text.length} chars)`;
}

async function printStatus({ json = false } = {}) {
  const localPort = Number(process.env.LOCAL_REALTIME_PORT || defaultLocalRealtimePort);
  const moshiPort = Number(process.env.MOSHI_PORT || 8999);
  const processes = listKnownProcesses();
  const localHealth = await getHealth(`http://127.0.0.1:${localPort}/health`);
  const moshiHealth = await getHealth(`http://127.0.0.1:${moshiPort}/health`);
  const localPortPids = pidsOnPort(localPort);
  const moshiPortPids = pidsOnPort(moshiPort);
  const keyStatus = keySpecs.map((spec) => ({
    name: spec.name,
    status: keySource(spec),
  }));

  const status = {
    localBridge: {
      port: localPort,
      health: localHealth,
      pids: unique([...processes.localBridge, ...localPortPids]),
    },
    moshiBridge: {
      port: moshiPort,
      health: moshiHealth,
      pids: unique([...processes.moshiBridge, ...moshiPortPids]),
    },
    codexRealtimeClients: {
      pids: unique(processes.codexRealtime),
    },
    keys: keyStatus,
  };

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("Codex realtime voice status");
  printServiceLine("Local bridge", status.localBridge, "local-codex-realtime");
  printServiceLine("Moshi bridge", status.moshiBridge, "moshi-codex-bridge");
  console.log(
    `Codex realtime clients: ${
      status.codexRealtimeClients.pids.length
        ? `running (${status.codexRealtimeClients.pids.join(", ")})`
        : "stopped"
    }`,
  );
  console.log("Keys:");
  for (const key of status.keys) {
    console.log(`  ${key.name}: ${key.status}`);
  }
}

function printServiceLine(label, service, expectedName) {
  const ok = service.health.ok && (!expectedName || service.health.body.includes(expectedName));
  if (ok) {
    console.log(`${label}: running on default port ${service.port} (${service.pids.join(", ") || "pid unknown"})`);
  } else if (service.pids.length) {
    console.log(`${label}: running process(es) ${service.pids.join(", ")}; default port ${service.port} not confirmed`);
  } else {
    console.log(`${label}: stopped`);
  }
}

async function stopKnownProcesses() {
  const localPort = Number(process.env.LOCAL_REALTIME_PORT || defaultLocalRealtimePort);
  const moshiPort = Number(process.env.MOSHI_PORT || 8999);
  const processes = listKnownProcesses();
  const targets = new Set([
    ...processes.localBridge,
    ...processes.moshiBridge,
    ...processes.codexRealtime,
  ]);

  const localHealth = await getHealth(`http://127.0.0.1:${localPort}/health`);
  if (localHealth.body.includes("local-codex-realtime")) {
    for (const pid of pidsOnPort(localPort)) targets.add(pid);
  }

  const moshiHealth = await getHealth(`http://127.0.0.1:${moshiPort}/health`);
  if (moshiHealth.body.includes("moshi-codex-bridge")) {
    for (const pid of pidsOnPort(moshiPort)) targets.add(pid);
  }

  targets.delete(String(process.pid));
  if (!targets.size) {
    console.log("Nothing to stop.");
    return;
  }

  for (const pid of targets) {
    try {
      process.kill(Number(pid), "SIGTERM");
      console.log(`Stopped ${pid}`);
    } catch {
      console.log(`Could not stop ${pid}`);
    }
  }
}

async function doctor() {
  console.log("Codex realtime voice doctor");
  console.log(`Node: ${process.version}`);
  console.log(`Package folder: ${rootDir}`);
  console.log(`Codex binary: ${process.env.CODEX_BIN || defaultCodexBin} ${existsSync(process.env.CODEX_BIN || defaultCodexBin) ? "ok" : "missing"}`);
  console.log(`Codex config: ${codexConfigPath}`);
  console.log(`Codex realtime feature: ${codexRealtimeConfigStatus()}`);
  console.log(`Dependencies: ${existsSync(path.join(rootDir, "node_modules")) ? "installed" : "missing, run npm install"}`);
  console.log(`macOS Keychain: ${hasSecurity() ? "available" : "not found"}`);
  console.log(`lsof: ${commandExists("lsof") ? "available" : "missing"}`);
  console.log(`ffplay: ${commandExists("ffplay") ? "available" : "missing, needed for some direct audio paths"}`);
  console.log(`say: ${commandExists("say") ? "available" : "missing"}`);
  console.log("Keys:");
  for (const spec of keySpecs) {
    console.log(`  ${spec.name}: ${keySource(spec)}`);
  }
  console.log("");
  await printStatus();
}

async function setupCodexConfig(args = []) {
  const dryRun = args.includes("--dry-run");
  const noSuppressWarning = args.includes("--no-suppress-warning");

  const before = existsSync(codexConfigPath) ? readFileSync(codexConfigPath, "utf8") : "";
  let after = before;
  after = ensureTomlSectionBoolean(after, "features", "realtime_conversation", true);
  if (!noSuppressWarning) {
    after = ensureTomlTopLevelBoolean(after, "suppress_unstable_features_warning", true);
  }

  console.log("Codex Voice setup");
  console.log(`Config: ${codexConfigPath}`);
  console.log("Will ensure:");
  if (!noSuppressWarning) {
    console.log("  suppress_unstable_features_warning = true");
  }
  console.log("  [features]");
  console.log("  realtime_conversation = true");
  console.log("");

  if (after === before) {
    console.log("Already configured.");
    return;
  }

  if (dryRun) {
    console.log("Dry run only. No files changed.");
    return;
  }

  mkdirSync(codexHome, { recursive: true });

  if (before) {
    const backupPath = `${codexConfigPath}.backup-codex-voice-${timestampForFile()}`;
    copyFileSync(codexConfigPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  }

  writeFileSync(codexConfigPath, after);
  console.log("Updated Codex config.");
  console.log("Restart any open Codex CLI sessions, then run `/realtime` inside Codex.");
}

function codexRealtimeConfigStatus() {
  if (!existsSync(codexConfigPath)) return "missing, run codex-voice setup";
  const text = readFileSync(codexConfigPath, "utf8");
  return tomlSectionBooleanValue(text, "features", "realtime_conversation") === true
    ? "enabled"
    : "missing, run codex-voice setup";
}

function ensureTomlTopLevelBoolean(text, key, value) {
  const lineValue = `${key} = ${value ? "true" : "false"}`;
  let lines = normalizeTomlText(text).split("\n");
  if (lines.length && lines.at(-1) === "") lines = lines.slice(0, -1);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const searchEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);

  for (let index = 0; index < searchEnd; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = lineValue;
      return `${lines.join("\n")}\n`;
    }
  }

  if (firstSectionIndex === -1) {
    lines.push(lineValue);
    return `${lines.join("\n")}\n`;
  }

  lines.splice(firstSectionIndex, 0, lineValue, "");
  return `${lines.join("\n")}\n`;
}

function ensureTomlSectionBoolean(text, section, key, value) {
  const lineValue = `${key} = ${value ? "true" : "false"}`;
  let lines = normalizeTomlText(text).split("\n");
  if (lines.length && lines.at(-1) === "") lines = lines.slice(0, -1);
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegex(section)}\\]\\s*$`);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const sectionIndex = lines.findIndex((line) => sectionPattern.test(line));

  if (sectionIndex === -1) {
    if (lines.length && lines.at(-1).trim()) lines.push("");
    lines.push(`[${section}]`, lineValue);
    return `${lines.join("\n")}\n`;
  }

  let endIndex = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      endIndex = index;
      break;
    }
    if (keyPattern.test(lines[index])) {
      lines[index] = lineValue;
      return `${lines.join("\n")}\n`;
    }
  }

  lines.splice(endIndex, 0, lineValue);
  return `${lines.join("\n")}\n`;
}

function tomlSectionBooleanValue(text, section, key) {
  const lines = normalizeTomlText(text).split("\n");
  const sectionPattern = new RegExp(`^\\s*\\[${escapeRegex(section)}\\]\\s*$`);
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "i");
  const sectionIndex = lines.findIndex((line) => sectionPattern.test(line));
  if (sectionIndex === -1) return undefined;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) return undefined;
    const match = lines[index].match(keyPattern);
    if (match) return match[1].toLowerCase() === "true";
  }
  return undefined;
}

function normalizeTomlText(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function uninstall({ deleteKeys = false } = {}) {
  await stopKnownProcesses();

  if (deleteKeys) {
    for (const spec of keySpecs) {
      const ok = deleteKeychain(spec.account);
      console.log(`${spec.name} Keychain entry: ${ok ? "deleted or not present" : "could not delete"}`);
    }
  }

  console.log("");
  console.log("To remove the global command, run the one that matches how you installed it:");
  console.log("  npm uninstall -g codex-realtime-voice-kit");
  console.log("  npm unlink -g codex-realtime-voice-kit");
  console.log("");
  console.log("To delete saved keys too:");
  console.log("  codex-voice uninstall --delete-keys");
  console.log("");
  console.log("After that, you can delete this folder if you no longer need the repo copy.");
}

function listKnownProcesses() {
  const output = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout || "";
  const result = {
    localBridge: [],
    moshiBridge: [],
    codexRealtime: [],
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (Number(pid) === process.pid) continue;
    if (command.includes("local-codex-realtime-server.mjs")) result.localBridge.push(pid);
    if (command.includes("moshi-codex-bridge.py")) result.moshiBridge.push(pid);
    if (
      command.includes("experimental_realtime_ws_model=\"local-codex-realtime\"") ||
      (command.includes("--enable realtime_conversation") && command.includes("/codex"))
    ) {
      result.codexRealtime.push(pid);
    }
  }

  result.localBridge = unique(result.localBridge);
  result.moshiBridge = unique(result.moshiBridge);
  result.codexRealtime = unique(result.codexRealtime);
  return result;
}

function pidsOnPort(port) {
  if (!commandExists("lsof")) return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return unique((result.stdout || "").split(/\s+/).filter(Boolean));
}

async function getHealth(url) {
  try {
    const timeoutMs = Number(process.env.CODEX_VOICE_HEALTH_TIMEOUT_MS || 250);
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.text();
    return { ok: response.ok, body };
  } catch {
    return { ok: false, body: "" };
  }
}

function keySource(spec) {
  if (spec.env.some((name) => process.env[name])) return "env";
  if (readKeychain(spec.account)) return "keychain";
  return "missing";
}

function readKeychain(account) {
  if (!hasSecurity()) return "";
  try {
    return execFileSync("security", ["find-generic-password", "-s", keychainService, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function saveKeychain(account, value) {
  if (!hasSecurity()) return false;
  const result = spawnSync("security", ["add-generic-password", "-U", "-s", keychainService, "-a", account, "-w", value], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function deleteKeychain(account) {
  if (!hasSecurity()) return false;
  const result = spawnSync("security", ["delete-generic-password", "-s", keychainService, "-a", account], {
    stdio: "ignore",
  });
  return result.status === 0 || result.status === 44;
}

function hasSecurity() {
  return process.platform === "darwin" && commandExists("security");
}

function commandExists(name) {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(name)} >/dev/null 2>&1`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function printGeminiVoices() {
  console.log("OpenAI/Codex realtime voice names:");
  console.log(openAIRealtimeVoices.join(", "));
  console.log("");
  console.log("Gemini voice names:");
  console.log(geminiVoices.join(", "));
  console.log("");
  console.log("Example:");
  console.log("  codex-voice official --voice cedar");
  console.log("  codex-voice openai-realtime --voice marin");
  console.log("  codex-voice gemini --voice Aoede");
  console.log("  codex-voice gemini --voice Leda");
}

function printHelp() {
  console.log(`Codex realtime voice kit

Usage:
  codex-voice
  codex-voice <mode> [options] [project-folder]
  codex-voice status
  codex-voice stop
  codex-voice setup [--dry-run] [--no-suppress-warning]
  codex-voice doctor
  codex-voice settings
  codex-voice settings show
  codex-voice settings reset
  codex-voice voices
  codex-voice key list
  codex-voice key set xai
  codex-voice key set gemini
  codex-voice key delete gemini
  codex-voice uninstall [--delete-keys]

Modes:
  official       Official OpenAI realtime API
  openai-realtime  OpenAI realtime API through local bridge
  xai            xAI Grok Voice via OpenAI-compatible realtime bridge
  groq           Groq speech-to-text + local Kokoro voice
  openai-stt     OpenAI speech-to-text + local Kokoro voice
  local          Local Whisper medium + local Kokoro voice
  tiny           Local Whisper tiny + local Kokoro voice
  gemini         Gemini Live voice model
  gemini-flash-live  Gemini Flash Live through local OpenAI-compatible bridge
  gemini-openai  Alias for Gemini Flash Live OpenAI-compatible bridge
  flash-live     Alias for Gemini Flash Live
  moshi          Moshi local speech-to-speech experiment

Voice model options:
  --voice <name>           Official/OpenAI/xAI/Gemini voice override
  --model <model>          Official/OpenAI/xAI/Gemini realtime model override
  --barge-in-rms <number>  Lower means easier interruption
  --barge-in-min-ms <ms>   How soon interruption can stop speech
  --barge-in               Turn automatic interruption on
  --no-barge-in            Turn automatic interruption off
  --replace-key            Paste and save a fresh API key

Setup options:
  --dry-run                Show what setup would change without writing files
  --no-suppress-warning    Do not add suppress_unstable_features_warning

Examples:
  codex-voice
  codex-voice groq
  codex-voice gemini
  codex-voice gemini-flash-live
  codex-voice flash-live
  codex-voice gemini --voice Leda
  codex-voice official --voice cedar --model gpt-realtime-1.5
  codex-voice openai-realtime --voice marin --model gpt-realtime-mini
  codex-voice xai --voice eve --model grok-voice-think-fast-1.0
  codex-voice gemini --barge-in --barge-in-rms 4200
  codex-voice openai-realtime
  codex-voice official
  codex-voice settings
  codex-voice gemini --replace-key
  codex-voice groq /path/to/project
  codex-voice status
  codex-voice stop
  codex-voice setup

If no project folder is passed, it uses the current terminal folder.
If a needed API key is missing, the CLI asks for it and can save it to macOS Keychain.
It only prints a masked preview, not the full key.`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
