#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const scriptsDir = path.join(rootDir, "scripts");
const keychainService = "codex-realtime-voice-kit";
const defaultCodexBin = "/Applications/Codex.app/Contents/Resources/codex";
const configDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || process.cwd(), ".config"),
  "codex-realtime-voice-kit",
);
const settingsPath = path.join(configDir, "settings.json");

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
    "moshi",
    {
      script: "run-moshi-codex-bridge.sh",
      label: "Moshi local speech-to-speech",
    },
  ],
]);

const keySpecs = [
  { env: ["OPENAI_API_KEY"], account: "openai-api-key", name: "OpenAI" },
  { env: ["GROQ_API_KEY"], account: "groq-api-key", name: "Groq" },
  { env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], account: "gemini-api-key", name: "Gemini" },
];

const openAIRealtimeVoices = [
  "alloy",
  "arbor",
  "ash",
  "ballad",
  "breeze",
  "cedar",
  "coral",
  "cove",
  "echo",
  "ember",
  "juniper",
  "maple",
  "marin",
  "sage",
  "shimmer",
  "sol",
  "spruce",
  "vale",
  "verse",
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

const settingsProviders = [
  {
    key: "official",
    label: "Official OpenAI realtime",
    script: "run-official-openai-realtime.sh",
    fields: [
      { key: "model", label: "Realtime model", env: "CODEX_REALTIME_MODEL", defaultValue: "gpt-realtime-1.5" },
      { key: "voice", label: "Voice", env: "CODEX_REALTIME_VOICE", defaultValue: "marin", choices: openAIRealtimeVoices },
    ],
  },
  {
    key: "openai-realtime",
    label: "OpenAI realtime bridge",
    script: "run-openai-realtime-bridge.sh",
    fields: [
      { key: "model", label: "Realtime model", env: "LOCAL_REALTIME_OPENAI_REALTIME_MODEL", defaultValue: "gpt-realtime-mini" },
      { key: "voice", label: "Voice", env: "LOCAL_REALTIME_OPENAI_REALTIME_VOICE", defaultValue: "marin", choices: openAIRealtimeVoices },
    ],
  },
  {
    key: "gemini",
    label: "Gemini Live",
    script: "run-gemini-live.sh",
    fields: [
      { key: "model", label: "Live model", env: "LOCAL_REALTIME_GEMINI_MODEL", defaultValue: "gemini-3.1-flash-live-preview" },
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
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_GROQ_TRANSCRIBE_MODEL", defaultValue: "whisper-large-v3-turbo" },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart" },
    ],
  },
  {
    key: "openai-stt",
    label: "OpenAI STT + Kokoro",
    script: "run-openai-stt-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_TRANSCRIBE_MODEL", defaultValue: "gpt-4o-mini-transcribe" },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart" },
    ],
  },
  {
    key: "local",
    label: "Local Whisper medium + Kokoro",
    script: "run-local-whisper-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_LOCAL_STT_MODEL", defaultValue: "Xenova/whisper-medium.en" },
      { key: "device", label: "STT device", env: "LOCAL_REALTIME_LOCAL_STT_DEVICE", defaultValue: "cpu" },
      { key: "dtype", label: "STT dtype", env: "LOCAL_REALTIME_LOCAL_STT_DTYPE", defaultValue: "q8" },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart" },
    ],
  },
  {
    key: "tiny",
    label: "Local Whisper tiny + Kokoro",
    script: "run-local-tiny-kokoro.sh",
    fields: [
      { key: "sttModel", label: "STT model", env: "LOCAL_REALTIME_LOCAL_STT_MODEL", defaultValue: "Xenova/whisper-tiny.en" },
      { key: "device", label: "STT device", env: "LOCAL_REALTIME_LOCAL_STT_DEVICE", defaultValue: "cpu" },
      { key: "dtype", label: "STT dtype", env: "LOCAL_REALTIME_LOCAL_STT_DTYPE", defaultValue: "q8" },
      { key: "voice", label: "Kokoro voice", env: "LOCAL_REALTIME_KOKORO_VOICE", defaultValue: "af_heart" },
    ],
  },
];

async function main() {
  const argv = process.argv.slice(2);
  const command = (argv[0] || "help").toLowerCase();

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
      env.LOCAL_REALTIME_PORT = String(await findFreePort(Number(env.CODEX_VOICE_PORT_START || 8787)));
      console.error(`Using local realtime bridge port ${env.LOCAL_REALTIME_PORT}`);
    }
    env.LOCAL_REALTIME_KILL_OLD_CODEX ??= "0";
  }

  const args = childArgs.length ? childArgs : [process.cwd()];

  console.log(`Starting: ${mode.label}`);
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
  if (mode.script === "run-gemini-live.sh") {
    if (options.voice) env.LOCAL_REALTIME_GEMINI_VOICE = options.voice;
    if (options.model) env.LOCAL_REALTIME_GEMINI_MODEL = options.model;
  } else if (mode.script === "run-official-openai-realtime.sh") {
    if (options.voice) env.CODEX_REALTIME_VOICE = options.voice.toLowerCase();
    if (options.model) env.CODEX_REALTIME_MODEL = options.model;
  } else if (mode.script === "run-openai-realtime-bridge.sh") {
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    let settings = readSettings();
    while (true) {
      clearScreen();
      console.log("Codex Voice Settings");
      console.log("");
      console.log(`Saved at: ${settingsPath}`);
      console.log("Press Enter to keep a value. Type - to clear a value.");
      console.log("");
      settingsProviders.forEach((provider, index) => {
        console.log(`${index + 1}. ${provider.label}`);
      });
      console.log("s. Show current settings");
      console.log("r. Reset all settings");
      console.log("q. Quit");
      console.log("");

      const choice = (await rl.question("Choose: ")).trim().toLowerCase();
      if (!choice || choice === "q" || choice === "quit" || choice === "exit") break;
      if (choice === "s" || choice === "show") {
        clearScreen();
        printSettings(settings);
        await rl.question("\nPress Enter to continue...");
        continue;
      }
      if (choice === "r" || choice === "reset") {
        const confirm = (await rl.question("Delete all saved settings? [y/N] ")).trim().toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          settings = {};
          if (existsSync(settingsPath)) rmSync(settingsPath);
          console.log("Settings deleted.");
          await rl.question("Press Enter to continue...");
        }
        continue;
      }

      const provider = settingsProviders[Number(choice) - 1];
      if (!provider) continue;
      settings = await editProviderSettings(rl, settings, provider);
      writeSettings(settings);
      console.log(`Saved ${provider.label} settings.`);
      await rl.question("Press Enter to continue...");
    }
  } finally {
    rl.close();
  }
}

async function editProviderSettings(rl, settings, provider) {
  clearScreen();
  console.log(provider.label);
  console.log("");
  if (!settings[provider.key] || typeof settings[provider.key] !== "object") {
    settings[provider.key] = {};
  }

  for (const field of provider.fields) {
    const current = settings[provider.key][field.key] ?? "";
    const shown = current || field.defaultValue || "";
    if (field.choices?.length) {
      console.log(`${field.label} choices: ${field.choices.join(", ")}`);
    }

    let value;
    if (field.type === "boolean") {
      value = await askBooleanSetting(rl, field.label, shown);
    } else {
      value = (await rl.question(`${field.label} [${shown}]: `)).trim();
    }

    if (!value) continue;
    if (value === "-") {
      delete settings[provider.key][field.key];
      continue;
    }
    settings[provider.key][field.key] = value;
  }

  if (!Object.keys(settings[provider.key]).length) delete settings[provider.key];
  return settings;
}

async function askBooleanSetting(rl, label, current) {
  const currentBool = String(current || "1") !== "0";
  const answer = (await rl.question(`${label} [${currentBool ? "Y" : "n"}]: `)).trim().toLowerCase();
  if (!answer) return "";
  if (answer === "-") return "-";
  if (["y", "yes", "true", "1", "on"].includes(answer)) return "1";
  if (["n", "no", "false", "0", "off"].includes(answer)) return "0";
  console.log("Please answer y or n. Keeping current value.");
  return "";
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
}

function clearScreen() {
  if (process.stdout.isTTY) process.stdout.write("\x1Bc");
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
    console.error("Choose a key: openai, groq, or gemini");
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
  console.error("Use: codex-voice key list | key set openai | key set gemini | key delete gemini");
  process.exit(1);
}

function findKeySpec(name) {
  if (name === "openai" || name === "official" || name === "openai-realtime" || name === "realtime") return keySpecs[0];
  if (name === "groq") return keySpecs[1];
  if (name === "gemini" || name === "google") return keySpecs[2];
  return null;
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "(empty)";
  if (text.length <= 8) return `${"*".repeat(text.length)} (${text.length} chars)`;
  return `${text.slice(0, 4)}...${text.slice(-4)} (${text.length} chars)`;
}

async function printStatus({ json = false } = {}) {
  const localPort = Number(process.env.LOCAL_REALTIME_PORT || 8787);
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
  const localPort = Number(process.env.LOCAL_REALTIME_PORT || 8787);
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
  codex-voice <mode> [options] [project-folder]
  codex-voice status
  codex-voice stop
  codex-voice doctor
  codex-voice settings
  codex-voice settings show
  codex-voice settings reset
  codex-voice voices
  codex-voice key list
  codex-voice key set gemini
  codex-voice key delete gemini
  codex-voice uninstall [--delete-keys]

Modes:
  official       Official OpenAI realtime API
  openai-realtime  OpenAI realtime API through local bridge
  groq           Groq speech-to-text + local Kokoro voice
  openai-stt     OpenAI speech-to-text + local Kokoro voice
  local          Local Whisper medium + local Kokoro voice
  tiny           Local Whisper tiny + local Kokoro voice
  gemini         Gemini Live voice model
  moshi          Moshi local speech-to-speech experiment

Voice model options:
  --voice <name>           Official/OpenAI/Gemini voice override
  --model <model>          Official/OpenAI/Gemini realtime model override
  --barge-in-rms <number>  Lower means easier interruption
  --barge-in-min-ms <ms>   How soon interruption can stop speech
  --barge-in               Turn automatic interruption on
  --no-barge-in            Turn automatic interruption off
  --replace-key            Paste and save a fresh API key

Examples:
  codex-voice groq
  codex-voice gemini
  codex-voice gemini --voice Leda
  codex-voice official --voice cedar --model gpt-realtime-1.5
  codex-voice openai-realtime --voice marin --model gpt-realtime-mini
  codex-voice gemini --barge-in --barge-in-rms 4200
  codex-voice openai-realtime
  codex-voice official
  codex-voice settings
  codex-voice gemini --replace-key
  codex-voice groq /path/to/project
  codex-voice status
  codex-voice stop

If no project folder is passed, it uses the current terminal folder.
If a needed API key is missing, the CLI asks for it and can save it to macOS Keychain.
It only prints a masked preview, not the full key.`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
