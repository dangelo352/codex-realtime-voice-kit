#!/usr/bin/env node
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const port = Number(process.env.LOCAL_REALTIME_PORT || 18787);
const host = process.env.LOCAL_REALTIME_HOST || "127.0.0.1";
const logPath = process.env.LOCAL_REALTIME_LOG || `/tmp/codex-local-realtime-${port}.log`;
const hasApiKeyAvailable = await hasApiKey();
const sttMode = process.env.LOCAL_REALTIME_STT || (hasApiKeyAvailable ? "openai" : "fake");
const speakMode = process.env.LOCAL_REALTIME_SPEAK || "kokoro";
const delegationMode = process.env.LOCAL_REALTIME_DELEGATION_MODE || "smart";
const chatMode = process.env.LOCAL_REALTIME_CHAT_MODE || (hasApiKeyAvailable ? "openai" : "canned");
const realtimeEngine =
  process.env.LOCAL_REALTIME_ENGINE ||
  (sttMode === "gemini-live" || chatMode === "gemini-live" ? "gemini-live" : "local");
const handoffFallbackMs = Number(process.env.LOCAL_REALTIME_HANDOFF_FALLBACK_MS || 0);
let kokoroTtsPromise = null;
let localTranscriberPromise = null;
let currentSpeechProcess = null;
let speechCancelRevision = 0;
let cachedGroqKeychainApiKey = null;
const fakeTranscript =
  process.env.LOCAL_REALTIME_FAKE_TRANSCRIPT ||
  "Say hello briefly and confirm that local realtime is connected to the original Codex CLI.";

function localRealtimeHealth() {
  return {
    ok: true,
    service: "local-codex-realtime",
    engine: realtimeEngine,
    stt: sttMode,
    chat: chatMode,
    model:
      realtimeEngine === "gemini-live"
        ? geminiLiveModel()
        : realtimeEngine === "openai-realtime"
          ? openAIRealtimeModel()
          : realtimeEngine,
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(localRealtimeHealth()));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "local realtime server only supports websocket /v1/realtime" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (url.pathname !== "/v1/realtime") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, url);
  });
});

wss.on("connection", (ws, _req, url) => {
  const session = new LocalRealtimeSession(ws, url);
  session.start();
});

server.listen(port, host, () => {
  log(`Local Codex realtime server: ws://${host}:${port}/v1/realtime`);
  log(`Log file: ${logPath}`);
  log(`Speech-to-text: ${sttMode}`);
  if (sttMode === "local" || sttMode === "whisper") {
    log(`Local STT model: ${localTranscriptionModel()}`);
  } else if (sttMode === "groq") {
    log(`Groq STT model: ${groqTranscriptionModel()}`);
    log(`Groq STT endpoint: ${groqTranscriptionUrl()}`);
  }
  log(`Realtime engine: ${realtimeEngine}`);
  if (realtimeEngine === "openai-realtime") {
    log(`OpenAI Realtime model: ${openAIRealtimeModel()}`);
    log(`OpenAI Realtime voice: ${openAIRealtimeVoice()}`);
  }
  if (realtimeEngine === "gemini-live") {
    log(`Gemini Live model: ${geminiLiveModel()}`);
    log(`Gemini Live voice: ${geminiVoiceName() || "default"}`);
  }
  if (realtimeEngine === "moshi-live") {
    log(`Moshi bridge: ${moshiBridgeUrl()}`);
  }
  log(`Speech output: ${speakMode}`);
  log(`Delegation mode: ${delegationMode}`);
  log(`Local chat mode: ${chatMode}`);
  prewarmTranscription();
  prewarmSpeech();
});

class LocalRealtimeSession {
  constructor(ws, url) {
    this.ws = ws;
    this.url = url;
    this.sessionId = `sess_local_${Date.now()}`;
    this.sampleRate = 24000;
    this.bytesReceived = 0;
    this.activeSpeech = false;
    this.speechChunks = [];
    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.silenceTimer = null;
    this.audioStatsTimer = null;
    this.audioFrames = 0;
    this.maxRms = 0;
    this.responseCount = 0;
    this.handoffCount = 0;
    this.pendingHandoffs = new Map();
    this.queuedHandoffText = "";
    this.queuedSideTasks = [];
    this.busyNoticeSent = false;
    this.lastHandoffAckAt = 0;
    this.greeted = false;
    this.speaking = false;
    this.speechInterrupted = false;
    this.ignoreAudioUntil = 0;
    this.speechChain = Promise.resolve();
    this.lastSttFailure = "";
    this.lastSttFailureNoticeAt = 0;
    this.openaiRealtimeReadyPromise = null;
    this.openaiRealtimeWs = null;
    this.openaiRealtimeInputTranscript = "";
    this.openaiRealtimeOutputTranscript = "";
    this.openaiRealtimeAudioItemId = "";
    this.openaiRealtimeAudioMs = 0;
    this.openaiRealtimeActiveResponseId = "";
    this.openaiRealtimeResponseCreatePending = false;
    this.openaiRealtimeHandledFunctionCalls = new Set();
    this.openaiRealtimeQuiet = false;
    this.openaiRealtimeBargeInFrames = 0;
    this.openaiRealtimeBargeInUntil = 0;
    this.geminiReadyPromise = null;
    this.geminiSession = null;
    this.geminiVoiceSession = null;
    this.codexSessionInstructions = "";
    this.geminiInputTranscript = "";
    this.geminiOutputTranscript = "";
    this.geminiSuppressCurrentTurn = false;
    this.geminiDelegatedThisTurn = false;
    this.geminiAllowOutputThisTurn = false;
    this.geminiVoiceOnlyActive = false;
    this.geminiMissingKeyNoticeSent = false;
    this.geminiDisabledReason = "";
    this.lastGeminiFailureNoticeAt = 0;
    this.geminiAudioBuffers = [];
    this.geminiAudioItemId = "";
    this.geminiDropOutputUntil = 0;
    this.geminiBargeInFrames = 0;
    this.geminiBargeInListeningUntil = 0;
    this.lastBackendContextAt = 0;
    this.lastSpokenText = "";
    this.recentSpokenTexts = [];
    this.lastSpokenAt = 0;
    this.speechOutputStartedAt = 0;
    this.lastSpeakerEchoDropLogAt = 0;
    this.codexAudioOutputTimer = null;
    this.codexAudioPlaybackUntil = 0;
    this.codexAudioOutputUntil = 0;
    this.codexBargeInActive = false;
    this.codexBargeInItemId = "";
    this.codexBargeInStopTimer = null;
    this.pendingGeminiActivityStart = false;
    this.geminiActivityOpen = false;
    this.geminiOutputRate = Number(process.env.LOCAL_REALTIME_GEMINI_OUTPUT_RATE || 24000);
    this.geminiAudioPlayer = new PcmStreamPlayer(
      this.geminiOutputRate,
      (isSpeaking) => this.onGeminiPlaybackState(isSpeaking),
    );
    this.moshiClient = null;
    this.moshiOutputTranscript = "";
    this.moshiResponseId = "";
    this.moshiTextFlushTimer = null;
    this.moshiAudioItemId = "";
    this.moshiAudioStatsTimer = null;
    this.moshiAudioChunks = 0;
    this.moshiAudioBytes = 0;
    this.moshiAudioMaxRms = 0;
    this.moshiAudioPlayer = new PcmStreamPlayer(24000, (isSpeaking) =>
      this.onMoshiPlaybackState(isSpeaking),
    );
  }

  start() {
    log(`[ws] connected ${this.url.pathname}${this.url.search}`);
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", () => {
      clearTimeout(this.silenceTimer);
      clearTimeout(this.codexBargeInStopTimer);
      clearInterval(this.audioStatsTimer);
      this.stopCurrentSpeechOutput("websocket-close");
      this.closeOpenAIRealtime();
      this.closeGeminiLive();
      this.closeMoshiBridge();
      this.cancelPendingHandoffs("websocket-close");
      log("[ws] closed");
    });
    this.ws.on("error", (error) => {
      log(`[ws] error: ${error.message}`);
    });
  }

  async onMessage(payload) {
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }

    switch (message.type) {
      case "session.update":
        this.onSessionUpdate(message.session || {});
        break;
      case "input_audio_buffer.append":
        this.onAudio(message.audio || "");
        break;
      case "conversation.item.create":
        await this.onConversationItem(message.item || {});
        break;
      case "conversation.handoff.append":
        await this.onHandoffAppend(message);
        break;
      case "response.create":
        await this.onResponseCreate();
        break;
      default:
        break;
    }
  }

  onSessionUpdate(session) {
    this.sessionId = session.id || this.sessionId;
    this.sampleRate = session.audio?.input?.format?.rate || this.sampleRate;
    const sessionInstructions = String(session.instructions || "").trim();
    if (sessionInstructions) {
      this.codexSessionInstructions = sessionInstructions;
      log(
        `[session] instructions chars=${sessionInstructions.length} memoryChars=${codexSessionContextForGemini(sessionInstructions).length}`,
      );
    }
    log(`[session] updated id=${this.sessionId} sampleRate=${this.sampleRate}`);
    this.send({
      type: "session.updated",
      session: {
        id: this.sessionId,
        instructions:
          realtimeEngine === "gemini-live"
            ? "Local Codex realtime shim is connected to Gemini Live."
            : realtimeEngine === "openai-realtime"
              ? "Local Codex realtime shim is connected to OpenAI Realtime."
            : realtimeEngine === "moshi-live"
              ? "Local Codex realtime shim is connected to Moshi."
            : "Local Codex realtime shim is connected.",
      },
    });
    if (realtimeEngine === "gemini-live") {
      this.ensureGeminiLive().catch((error) => {
        log(`[gemini] connect failed: ${error.message}`);
      });
    }
    if (realtimeEngine === "openai-realtime") {
      if (this.openaiRealtimeWs?.readyState === WebSocket.OPEN) {
        this.sendOpenAIRealtimeSessionUpdate();
      } else {
        this.ensureOpenAIRealtime().catch((error) => {
          log(`[openai.realtime] connect failed: ${error.message}`);
        });
      }
    }
    if (realtimeEngine === "moshi-live") {
      this.ensureMoshiBridge().catch((error) => {
        log(`[moshi] connect failed: ${error.message}`);
      });
    }
    this.sendGreeting();
    if (process.env.LOCAL_REALTIME_STARTUP_HANDOFF) {
      setTimeout(() => {
        this.requestBackgroundAgent(process.env.LOCAL_REALTIME_STARTUP_HANDOFF).catch((error) => {
          log(`[handoff] startup handoff failed: ${error.message}`);
        });
      }, 250);
    }
  }

  sendGreeting() {
    const greeting = process.env.LOCAL_REALTIME_GREETING || "";
    if (this.greeted || !greeting || greeting === "off") return;
    this.greeted = true;
    setTimeout(() => {
      this.sendAssistantAnswer(greeting).catch((error) => {
        log(`[assistant] greeting failed: ${error.message}`);
      });
    }, 250);
  }

  onAudio(base64Audio) {
    if (!base64Audio) return;

    const chunk = Buffer.from(base64Audio, "base64");
    const rms = pcm16Rms(chunk);
    if (realtimeEngine === "openai-realtime") {
      this.onOpenAIRealtimeAudio(chunk, rms).catch((error) => {
        log(`[openai.realtime] audio send failed: ${error.message}`);
      });
      return;
    }
    if (realtimeEngine === "gemini-live") {
      this.onGeminiAudio(chunk, rms).catch((error) => {
        log(`[gemini] audio send failed: ${error.message}`);
      });
      return;
    }
    if (realtimeEngine === "moshi-live") {
      this.onMoshiAudio(chunk, rms).catch((error) => {
        log(`[moshi] audio send failed: ${error.message}`);
      });
      return;
    }

    if (this.shouldDropSpeakerEchoAudio(rms, "local")) return;

    if (this.speaking || Date.now() < this.ignoreAudioUntil) {
      const bargeInThreshold = Number(process.env.LOCAL_REALTIME_BARGE_IN_RMS || 1800);
      const bargeInMinMs = Number(process.env.LOCAL_REALTIME_BARGE_IN_MIN_MS || 1200);
      const speakingForMs = this.speechOutputStartedAt ? Date.now() - this.speechOutputStartedAt : 0;
      if (
        bargeInThreshold > 0 &&
        this.speaking &&
        speakingForMs >= bargeInMinMs &&
        rms >= bargeInThreshold
      ) {
        log(
          `[barge-in] cancelling speech rms=${Math.round(rms)} threshold=${bargeInThreshold} speakingForMs=${Math.round(speakingForMs)}`,
        );
        cancelCurrentSpeech("barge-in");
        this.speaking = false;
        this.speechInterrupted = true;
        this.ignoreAudioUntil = 0;
      } else {
        if (this.activeSpeech) this.cancelActiveSpeech("speaker-output");
        return;
      }
    }

    this.bytesReceived += chunk.length;
    this.audioFrames += 1;

    this.maxRms = Math.max(this.maxRms, rms);
    const threshold = Number(process.env.LOCAL_REALTIME_VAD_RMS || 800);
    const now = Date.now();
    const hasVoice = rms >= threshold;

    if (!this.audioStatsTimer) {
      this.audioStatsTimer = setInterval(() => {
        log(`[audio] frames=${this.audioFrames} kb=${Math.round(this.bytesReceived / 1024)} maxRms=${Math.round(this.maxRms)} active=${this.activeSpeech}`);
        this.audioFrames = 0;
        this.bytesReceived = 0;
        this.maxRms = 0;
      }, 2000);
    }

    if (hasVoice) {
      if (!this.activeSpeech) {
        this.activeSpeech = true;
        this.speechStartedAt = now;
        this.speechChunks = [];
        log(`[vad] speech started rms=${Math.round(rms)} threshold=${threshold}`);
        this.send({
          type: "input_audio_buffer.speech_started",
          item_id: `item_input_${now}`,
        });
      }
      this.lastVoiceAt = now;
      this.armSilenceTimer();
    }

    if (this.activeSpeech) {
      this.speechChunks.push(chunk);
      const silenceMs = Number(process.env.LOCAL_REALTIME_SILENCE_MS || 650);
      if (!hasVoice && now - this.lastVoiceAt >= silenceMs) {
        this.finishSpeech("silence").catch((error) => {
          log(`[vad] finish error: ${error.message}`);
        });
        return;
      }
      const maxSpeechMs = Number(process.env.LOCAL_REALTIME_MAX_SPEECH_MS || 6000);
      if (now - this.speechStartedAt >= maxSpeechMs) {
        this.finishSpeech("max-speech-time").catch((error) => {
          log(`[vad] finish error: ${error.message}`);
        });
      }
    }
  }

  async ensureOpenAIRealtime() {
    if (this.openaiRealtimeWs?.readyState === WebSocket.OPEN) return this.openaiRealtimeWs;
    if (this.openaiRealtimeReadyPromise) return this.openaiRealtimeReadyPromise;

    this.openaiRealtimeReadyPromise = (async () => {
      const apiKey = await readApiKey();
      if (!apiKey) {
        log("[openai.realtime] missing OPENAI_API_KEY");
        await this.sendAssistantAnswer(
          "OpenAI Realtime bridge needs OPENAI_API_KEY in the terminal before starting realtime.",
          { speak: false },
        );
        return null;
      }

      const startedAt = Date.now();
      const ws = new WebSocket(openAIRealtimeUrl(), {
        headers: openAIRealtimeHeaders(apiKey),
      });
      this.openaiRealtimeWs = ws;

      ws.on("open", () => {
        log(`[openai.realtime] websocket opened model=${openAIRealtimeModel()} elapsedMs=${Date.now() - startedAt}`);
        this.sendOpenAIRealtimeSessionUpdate();
      });
      ws.on("message", (data) => {
        this.onOpenAIRealtimeMessage(data.toString()).catch((error) => {
          log(`[openai.realtime] message handler failed: ${error.message}`);
        });
      });
      ws.on("error", (error) => {
        log(`[openai.realtime] websocket error: ${error.message}`);
      });
      ws.on("close", (_code, reason) => {
        log(`[openai.realtime] websocket closed: ${reason?.toString() || "no reason"}`);
        this.openaiRealtimeWs = null;
        this.openaiRealtimeReadyPromise = null;
      });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("OpenAI Realtime connection timed out")),
          Number(process.env.LOCAL_REALTIME_OPENAI_CONNECT_TIMEOUT_MS || 15000),
        );
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return ws;
    })();

    return this.openaiRealtimeReadyPromise;
  }

  sendOpenAIRealtimeSessionUpdate() {
    if (!this.openaiRealtimeWs || this.openaiRealtimeWs.readyState !== WebSocket.OPEN) return;
    this.sendOpenAIRealtimeEvent({
      type: "session.update",
      session: openAIRealtimeSessionConfig(this.codexSessionInstructions, {
        quiet: this.openaiRealtimeQuiet,
      }),
    });
  }

  async onOpenAIRealtimeAudio(chunk, rms) {
    const ws = await this.ensureOpenAIRealtime();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const outputActive =
      this.speaking || isSpeechOutputActive() || Date.now() < this.codexAudioOutputUntil;
    if (Date.now() >= this.openaiRealtimeBargeInUntil) {
      this.openaiRealtimeBargeInUntil = 0;
    }
    if (
      outputActive &&
      !this.openaiRealtimeBargeInUntil &&
      process.env.LOCAL_REALTIME_OPENAI_SUPPRESS_OUTPUT_ECHO === "1" &&
      this.shouldDropOpenAIRealtimeSpeakerAudio(rms)
    ) {
      return;
    }

    this.bytesReceived += chunk.length;
    this.audioFrames += 1;
    this.maxRms = Math.max(this.maxRms, rms);
    if (!this.audioStatsTimer) {
      this.audioStatsTimer = setInterval(() => {
        log(`[audio.openai] frames=${this.audioFrames} kb=${Math.round(this.bytesReceived / 1024)} maxRms=${Math.round(this.maxRms)}`);
        this.audioFrames = 0;
        this.bytesReceived = 0;
        this.maxRms = 0;
      }, 2000);
    }

    this.sendOpenAIRealtimeEvent({
      type: "input_audio_buffer.append",
      audio: chunk.toString("base64"),
    });
  }

  async onOpenAIRealtimeMessage(payload) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      log(`[openai.realtime] non-json message: ${payload.slice(0, 120)}`);
      return;
    }

    if (event.type === "error") {
      const message = event.error?.message || event.message || "OpenAI Realtime error";
      log(`[openai.realtime] error: ${message}`);
      if (/cancellation failed:\s*no active response found/i.test(message)) return;
      if (/active response in progress/i.test(message)) {
        this.openaiRealtimeResponseCreatePending = true;
        return;
      }
      await this.sendAssistantAnswer(message, { speak: false });
      return;
    }

    if (event.type === "session.created" || event.type === "session.updated") {
      log(`[openai.realtime] ${event.type}`);
      return;
    }

    if (event.type === "input_audio_buffer.speech_started") {
      log("[openai.realtime] speech started");
      if (openAIRealtimeBargeInMode() !== "off") {
        this.truncateOpenAIRealtimeAudio("openai-speech-started");
        this.stopCurrentSpeechOutput("openai-speech-started");
      }
      this.send(event);
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      this.send(event);
      return;
    }

    if (
      event.type === "conversation.item.input_audio_transcription.completed" ||
      event.type === "conversation.item.input_audio_transcription.delta"
    ) {
      const transcript = String(event.transcript || event.delta || "").trim();
      if (transcript) {
        if (await this.maybeHandleOpenAIRealtimeListeningTranscript(transcript)) return;
        if (
          event.type === "conversation.item.input_audio_transcription.completed" &&
          (await this.maybeHandleOpenAIRealtimeControlTranscript(transcript))
        ) {
          return;
        }
        this.openaiRealtimeInputTranscript = appendTranscriptChunk(
          this.openaiRealtimeInputTranscript,
          transcript,
        );
        log(`[openai.realtime.input] ${transcript}`);
      }
      this.send(event, { transcriptEvent: true });
      return;
    }

    if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
      const delta = String(event.delta || "");
      const itemId = event.item_id || this.openaiRealtimeAudioItemId || `item_openai_audio_${Date.now()}`;
      const audioChunk = delta ? Buffer.from(delta, "base64") : Buffer.alloc(0);
      if (this.openaiRealtimeAudioItemId !== itemId) {
        this.openaiRealtimeAudioItemId = itemId;
        this.openaiRealtimeAudioMs = 0;
      }
      this.send({
        ...event,
        type: "response.output_audio.delta",
        item_id: itemId,
        delta,
        sample_rate: 24000,
        channels: 1,
        samples_per_channel: Math.floor(audioChunk.length / 2),
      });
      if (audioChunk.length) {
        const samples = Math.floor(audioChunk.length / 2);
        this.openaiRealtimeAudioMs += Math.max(1, Math.round((samples * 1000) / 24000));
        this.markCodexAudioOutput(audioChunk);
      }
      return;
    }

    if (event.type === "response.output_audio.done" || event.type === "response.audio.done") {
      this.send({
        ...event,
        type: "response.output_audio.done",
        item_id: event.item_id || this.openaiRealtimeAudioItemId,
      });
      this.openaiRealtimeAudioItemId = "";
      this.openaiRealtimeAudioMs = 0;
      return;
    }

    if (
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.audio_transcript.delta"
    ) {
      const delta = String(event.delta || "");
      if (delta) {
        this.openaiRealtimeOutputTranscript = appendTranscriptChunk(
          this.openaiRealtimeOutputTranscript,
          delta,
        );
        log(`[openai.realtime.output] ${delta}`);
      }
      this.send({ ...event, type: "response.output_audio_transcript.delta" }, { transcriptEvent: true });
      return;
    }

    if (
      event.type === "response.output_audio_transcript.done" ||
      event.type === "response.audio_transcript.done"
    ) {
      const transcript = String(event.transcript || this.openaiRealtimeOutputTranscript || "").trim();
      if (transcript) this.rememberSpokenText(transcript);
      this.openaiRealtimeOutputTranscript = "";
      this.send({
        ...event,
        type: "response.output_audio_transcript.done",
        transcript,
      }, { transcriptEvent: true });
      return;
    }

    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await this.handleOpenAIRealtimeFunctionCall(event.item);
      return;
    }

    if (event.type === "response.done") {
      await this.handleOpenAIRealtimeResponseDone(event.response || {});
      this.openaiRealtimeActiveResponseId = "";
      this.openaiRealtimeAudioItemId = "";
      this.openaiRealtimeAudioMs = 0;
      this.send(event);
      this.flushOpenAIRealtimeResponseCreate();
      return;
    }

    if (event.type === "response.created") {
      this.openaiRealtimeActiveResponseId = event.response?.id || `active_${Date.now()}`;
      this.send(event);
      return;
    }

    if (
      event.type === "response.output_text.delta" ||
      event.type === "response.text.delta" ||
      event.type === "response.output_text.done" ||
      event.type === "response.text.done" ||
      event.type === "response.content_part.added" ||
      event.type === "response.content_part.done" ||
      event.type === "response.output_item.created" ||
      event.type === "conversation.item.added" ||
      event.type === "conversation.item.done" ||
      event.type === "rate_limits.updated"
    ) {
      this.send(normalizeRealtimeCompatibilityEvent(event));
    }
  }

  async handleOpenAIRealtimeResponseDone(response) {
    for (const item of response.output || []) {
      if (item?.type === "function_call") {
        await this.handleOpenAIRealtimeFunctionCall(item);
      }
    }
  }

  async handleOpenAIRealtimeFunctionCall(item) {
    if (item.name === "set_listening_mode") {
      await this.handleOpenAIRealtimeListeningModeCall(item);
      return;
    }
    if (item.name === "wait_for_user") {
      await this.handleOpenAIRealtimeWaitForUserCall(item);
      return;
    }
    if (item.name !== "background_agent") return;
    const callId = item.call_id || `call_openai_${++this.handoffCount}`;
    if (this.openaiRealtimeHandledFunctionCalls.has(callId)) {
      log(`[openai.realtime.tool] ignored duplicate function call_id=${callId}`);
      return;
    }
    this.openaiRealtimeHandledFunctionCalls.add(callId);
    if (this.openaiRealtimeHandledFunctionCalls.size > 100) {
      const [oldest] = this.openaiRealtimeHandledFunctionCalls;
      this.openaiRealtimeHandledFunctionCalls.delete(oldest);
    }
    if (this.pendingHandoffs.has(callId)) return;

    let prompt = "";
    try {
      const args = JSON.parse(item.arguments || "{}");
      prompt = String(args.prompt || args.task || "").trim();
    } catch {
      prompt = String(item.arguments || "").trim();
    }
    if (!prompt) prompt = this.openaiRealtimeInputTranscript.trim() || "Continue the user's requested coding task.";

    log(`[openai.realtime.tool] background_agent: ${prompt}`);
    const repairedPrompt = repairDelegationText(prompt);
    if (this.hasActiveHandoff()) {
      const sideTask = isSidetrackRequest(repairedPrompt);
      const queued = sideTask
        ? this.queueSideTask(repairedPrompt, { target: "openai-realtime-side", source: "openai-realtime" })
        : this.queueHandoff(repairedPrompt);
      const notice = queued
        ? sideTask
          ? "Queued as a side task. I will keep the current Codex task running and report back when the side task finishes."
          : "Codex is already working, so I queued this for after the current task."
        : "Codex is already working. I did not start a duplicate task.";
      await this.completeOpenAIRealtimeFunctionNotice(callId, notice);
      return;
    }

    await this.requestBackgroundAgent(repairedPrompt, {
      callId,
      externalCallId: callId,
      target: "openai-realtime",
    });
  }

  async handleOpenAIRealtimeListeningModeCall(item) {
    const callId = item.call_id || `call_openai_listening_${++this.handoffCount}`;
    if (this.openaiRealtimeHandledFunctionCalls.has(callId)) {
      log(`[openai.realtime.tool] ignored duplicate function call_id=${callId}`);
      return;
    }
    this.openaiRealtimeHandledFunctionCalls.add(callId);

    let mode = "";
    try {
      const args = JSON.parse(item.arguments || "{}");
      mode = String(args.mode || args.state || "").toLowerCase().trim();
    } catch {
      mode = String(item.arguments || "").toLowerCase().trim();
    }

    const quiet = /quiet|mute|pause|stop|off|not_listening|not listening/.test(mode);
    const active = /listen|active|resume|on|back/.test(mode);
    if (quiet) {
      await this.sendOpenAIRealtimeFunctionOutput(
        callId,
        `Quiet mode enabled. Wake phrase: ${quietWakePhraseDisplay()}.`,
        { createResponse: false },
      );
      await this.setOpenAIRealtimeQuiet(true, "openai-tool", { ack: true });
      return;
    }
    if (active) {
      await this.sendOpenAIRealtimeFunctionOutput(callId, "Listening mode enabled.", {
        createResponse: false,
      });
      await this.setOpenAIRealtimeQuiet(false, "openai-tool", { ack: true });
      return;
    }

    await this.sendOpenAIRealtimeFunctionOutput(callId, "Unknown listening mode.", {
      createResponse: false,
    });
  }

  async handleOpenAIRealtimeWaitForUserCall(item) {
    const callId = item.call_id || `call_openai_wait_${++this.handoffCount}`;
    if (this.openaiRealtimeHandledFunctionCalls.has(callId)) {
      log(`[openai.realtime.tool] ignored duplicate function call_id=${callId}`);
      return;
    }
    this.openaiRealtimeHandledFunctionCalls.add(callId);
    await this.sendOpenAIRealtimeFunctionOutput(callId, "Waiting silently for the user.", {
      createResponse: false,
    });
  }

  async maybeHandleOpenAIRealtimeListeningTranscript(transcript) {
    const normalized = normalizeForIntent(transcript);
    if (isQuietModeRequest(normalized)) {
      await this.setOpenAIRealtimeQuiet(true, "transcript", { ack: true });
      return true;
    }
    if (this.openaiRealtimeQuiet && isQuietWakeRequest(normalized)) {
      const followup = textAfterQuietWake(transcript);
      await this.setOpenAIRealtimeQuiet(false, "transcript-wake", { ack: false });
      await this.sendOpenAIRealtimeText(
        followup ||
          "[SYSTEM] The user came back after quiet mode. Briefly say you are listening again.",
      );
      return true;
    }
    return false;
  }

  async maybeHandleOpenAIRealtimeControlTranscript(transcript) {
    const normalized = repairLocalTranscript(normalizeForIntent(transcript));
    if (!normalized) return false;

    if (isStopOrDismissal(normalized)) {
      log(`[openai.realtime.control] stop: ${transcript}`);
      this.truncateOpenAIRealtimeAudio("transcript-stop");
      if (this.openaiRealtimeActiveResponseId) {
        this.sendOpenAIRealtimeEvent({ type: "response.cancel" });
        this.openaiRealtimeActiveResponseId = "";
      }
      this.cancelPendingHandoffs("transcript-stop");
      this.stopCurrentSpeechOutput("transcript-stop");
      this.openaiRealtimeInputTranscript = "";
      this.openaiRealtimeOutputTranscript = "";
      this.openaiRealtimeResponseCreatePending = false;
      this.send({ type: "output_audio_buffer.cleared" });
      return true;
    }

    if (!isExplicitQueueOrSteerRequest(normalized)) return false;

    const task = stripQueueOrSteerRequest(transcript);
    if (!task || shouldIgnoreBusyDelegationPrompt(task)) {
      log(`[openai.realtime.control] ignored queue/steer fragment: ${transcript}`);
      return true;
    }

    log(`[openai.realtime.control] queue/steer: ${task}`);
    this.truncateOpenAIRealtimeAudio("transcript-queue");
    if (this.openaiRealtimeActiveResponseId) {
      this.sendOpenAIRealtimeEvent({ type: "response.cancel" });
      this.openaiRealtimeActiveResponseId = "";
    }
    this.stopCurrentSpeechOutput("transcript-queue");

    if (this.hasActiveHandoff()) {
      const queued = this.queueHandoff(repairDelegationText(task));
      if (queued) this.scheduleHandoffAcknowledgement(task, { queued: true });
    } else {
      await this.requestBackgroundAgent(repairDelegationText(task), {
        target: "openai-realtime",
        source: "openai-realtime-control",
      });
    }
    this.openaiRealtimeInputTranscript = "";
    this.openaiRealtimeOutputTranscript = "";
    return true;
  }

  async setOpenAIRealtimeQuiet(quiet, reason, options = {}) {
    if (this.openaiRealtimeQuiet === quiet) return;

    this.openaiRealtimeQuiet = quiet;
    this.openaiRealtimeInputTranscript = "";
    this.openaiRealtimeOutputTranscript = "";
    this.openaiRealtimeResponseCreatePending = false;

    if (quiet) {
      this.truncateOpenAIRealtimeAudio(reason);
      if (this.openaiRealtimeActiveResponseId) {
        this.sendOpenAIRealtimeEvent({ type: "response.cancel" });
        this.openaiRealtimeActiveResponseId = "";
      }
      this.stopCurrentSpeechOutput(`quiet-${reason}`);
      log(`[quiet] enabled reason=${reason}`);
      this.sendOpenAIRealtimeSessionUpdate();
      if (options.ack !== false) {
        await this.sendAssistantAnswer(
          `Okay. Quiet mode is on. Say "${quietWakePhraseDisplay()}" when you want me again.`,
        );
      }
      return;
    }

    log(`[quiet] disabled reason=${reason}`);
    this.sendOpenAIRealtimeSessionUpdate();
    if (options.ack !== false) {
      await this.sendAssistantAnswer("I am back. Listening again.");
    }
  }

  sendOpenAIRealtimeEvent(event) {
    if (!this.openaiRealtimeWs || this.openaiRealtimeWs.readyState !== WebSocket.OPEN) return false;
    this.openaiRealtimeWs.send(JSON.stringify(event));
    return true;
  }

  async sendOpenAIRealtimeText(text) {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;
    const ws = await this.ensureOpenAIRealtime();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    this.sendOpenAIRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: cleanText,
          },
        ],
      },
    });
    this.requestOpenAIRealtimeResponseCreate();
  }

  async completeOpenAIRealtimeHandoff(pending, answer) {
    const cleanAnswer = String(answer || "").trim() || "Done.";
    const callId = pending.externalCallId || pending.callId;
    if (!callId) return;
    await this.completeOpenAIRealtimeFunctionNotice(callId, cleanAnswer);
  }

  async completeOpenAIRealtimeFunctionNotice(callId, output) {
    await this.sendOpenAIRealtimeFunctionOutput(callId, output, { createResponse: true });
  }

  async sendOpenAIRealtimeFunctionOutput(callId, output, options = {}) {
    const cleanOutput = String(output || "").trim() || "Done.";
    if (!callId) return;
    const ws = await this.ensureOpenAIRealtime();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    log(`[openai.realtime.tool] sending result call_id=${callId}`);
    this.sendOpenAIRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: cleanOutput,
      },
    });
    if (options.createResponse !== false) this.requestOpenAIRealtimeResponseCreate();
  }

  requestOpenAIRealtimeResponseCreate() {
    if (this.openaiRealtimeQuiet) {
      log("[openai.realtime] skipped response.create while quiet");
      return;
    }
    if (this.openaiRealtimeActiveResponseId) {
      this.openaiRealtimeResponseCreatePending = true;
      log(`[openai.realtime] delayed response.create active=${this.openaiRealtimeActiveResponseId}`);
      return;
    }
    this.sendOpenAIRealtimeEvent({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
      },
    });
  }

  flushOpenAIRealtimeResponseCreate() {
    if (!this.openaiRealtimeResponseCreatePending) return;
    this.openaiRealtimeResponseCreatePending = false;
    this.requestOpenAIRealtimeResponseCreate();
  }

  async sendOpenAIRealtimeSideTaskResult(answer) {
    const cleanAnswer = String(answer || "").trim() || "Side task finished.";
    await this.sendOpenAIRealtimeText(`[BACKEND side task finished]\n${cleanAnswer}`);
  }

  closeOpenAIRealtime() {
    if (!this.openaiRealtimeWs) return;
    const ws = this.openaiRealtimeWs;
    this.openaiRealtimeWs = null;
    this.openaiRealtimeReadyPromise = null;
    try {
      ws.close();
    } catch {
      // Ignore close errors.
    }
  }

  async onGeminiAudio(chunk, rms) {
    const now = Date.now();
    const outputActive = this.speaking || isSpeechOutputActive();

    if (outputActive || now < this.ignoreAudioUntil) {
      const allowBargeIn = process.env.LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN === "1";
      const bargeInMode = geminiBargeInMode();
      const bargeInThreshold = Number(process.env.LOCAL_REALTIME_GEMINI_BARGE_IN_RMS || 4200);
      const strongBargeInThreshold = Number(
        process.env.LOCAL_REALTIME_GEMINI_STRONG_BARGE_IN_RMS || 8500,
      );
      const bargeInMinFrames = Number(process.env.LOCAL_REALTIME_GEMINI_BARGE_IN_FRAMES || 6);
      const bargeInMinMs = Number(process.env.LOCAL_REALTIME_GEMINI_BARGE_IN_MIN_MS || 1500);
      const speakingForMs = this.speechOutputStartedAt ? now - this.speechOutputStartedAt : 0;
      const aboveBargeThreshold = rms >= bargeInThreshold;
      this.geminiBargeInFrames = aboveBargeThreshold ? this.geminiBargeInFrames + 1 : 0;
      const canBargeIn =
        allowBargeIn &&
        bargeInMode === "rms" &&
        aboveBargeThreshold &&
        (!outputActive || speakingForMs >= bargeInMinMs) &&
        (rms >= strongBargeInThreshold || this.geminiBargeInFrames >= bargeInMinFrames);
      if (canBargeIn) {
        log(
          `[gemini] barge-in rms=${Math.round(rms)} threshold=${bargeInThreshold} frames=${this.geminiBargeInFrames} outputActive=${outputActive}`,
        );
        this.geminiBargeInFrames = 0;
        this.notifyCodexBargeIn("barge-in", rms);
        this.geminiDropOutputUntil =
          now + Number(process.env.LOCAL_REALTIME_GEMINI_DROP_OUTPUT_AFTER_BARGE_MS || 1500);
        if (outputActive) {
          this.stopCurrentSpeechOutput("barge-in");
        } else {
          this.ignoreAudioUntil = 0;
        }
      } else if (
        allowBargeIn &&
        bargeInMode === "transcript" &&
        aboveBargeThreshold &&
        (!outputActive || speakingForMs >= bargeInMinMs) &&
        (rms >= strongBargeInThreshold || this.geminiBargeInFrames >= bargeInMinFrames)
      ) {
        this.geminiBargeInListeningUntil = Math.max(
          this.geminiBargeInListeningUntil,
          now + Number(process.env.LOCAL_REALTIME_GEMINI_BARGE_IN_LISTEN_MS || 1800),
        );
        if (now - this.lastSpeakerEchoDropLogAt > 1200) {
          this.lastSpeakerEchoDropLogAt = now;
          log(`[gemini] transcript barge-in candidate rms=${Math.round(rms)} frames=${this.geminiBargeInFrames}`);
        }
      } else {
        if (
          allowBargeIn &&
          bargeInMode === "transcript" &&
          now < this.geminiBargeInListeningUntil
        ) {
          // Keep a short candidate window open so Gemini can confirm whether
          // this was real user speech. Do not stop output from RMS alone.
        } else {
          if (this.shouldDropSpeakerEchoAudio(rms, "gemini")) return;
          if (this.activeSpeech) this.cancelActiveSpeech("speaker-output");
          return;
        }
      }
    } else {
      this.geminiBargeInFrames = 0;
    }

    this.bytesReceived += chunk.length;
    this.audioFrames += 1;
    this.maxRms = Math.max(this.maxRms, rms);

    if (!this.audioStatsTimer) {
      this.audioStatsTimer = setInterval(() => {
        log(`[audio.gemini] frames=${this.audioFrames} kb=${Math.round(this.bytesReceived / 1024)} maxRms=${Math.round(this.maxRms)} speaking=${this.speaking}`);
        this.audioFrames = 0;
        this.bytesReceived = 0;
        this.maxRms = 0;
      }, 2000);
    }

    if (process.env.LOCAL_REALTIME_GEMINI_AUDIO_GATE !== "0") {
      const threshold = Number(process.env.LOCAL_REALTIME_GEMINI_VAD_RMS || 650);
      const hasVoice = rms >= threshold;
      const silenceMs = Number(process.env.LOCAL_REALTIME_GEMINI_SILENCE_MS || 600);
      const maxSpeechMs = Number(process.env.LOCAL_REALTIME_GEMINI_MAX_SPEECH_MS || 9000);

      if (hasVoice) {
        if (!this.activeSpeech) {
          this.activeSpeech = true;
          this.speechStartedAt = now;
          this.pendingGeminiActivityStart = geminiUsesLocalVadSignals();
          log(`[gemini.vad] speech started rms=${Math.round(rms)} threshold=${threshold}`);
          this.send({
            type: "input_audio_buffer.speech_started",
            item_id: `item_gemini_input_${now}`,
          });
        }
        this.lastVoiceAt = now;
      }

      if (!this.activeSpeech) return;

      const session = await this.ensureGeminiLive();
      if (!session) return;
      this.sendGeminiActivityStartIfNeeded(session);
      this.sendGeminiAudioChunk(session, chunk);

      if (!hasVoice && now - this.lastVoiceAt >= silenceMs) {
        this.finishGeminiAudioTurn("silence").catch((error) => {
          log(`[gemini.vad] finish failed: ${error.message}`);
        });
        return;
      }

      if (now - this.speechStartedAt >= maxSpeechMs) {
        this.finishGeminiAudioTurn("max-speech-time").catch((error) => {
          log(`[gemini.vad] finish failed: ${error.message}`);
        });
      }
      return;
    }

    const session = await this.ensureGeminiLive();
    if (!session) return;
    this.sendGeminiAudioChunk(session, chunk);
  }

  async onMoshiAudio(chunk, rms) {
    const now = Date.now();
    const outputActive = this.speaking || isSpeechOutputActive();

    if (outputActive || now < this.ignoreAudioUntil) {
      const allowBargeIn = process.env.LOCAL_REALTIME_MOSHI_ALLOW_BARGE_IN === "1";
      const bargeInThreshold = Number(process.env.LOCAL_REALTIME_MOSHI_BARGE_IN_RMS || 2500);
      const bargeInMinMs = Number(process.env.LOCAL_REALTIME_MOSHI_BARGE_IN_MIN_MS || 900);
      const speakingForMs = this.speechOutputStartedAt ? now - this.speechOutputStartedAt : 0;
      const canBargeIn =
        allowBargeIn &&
        rms >= bargeInThreshold &&
        (!outputActive || speakingForMs >= bargeInMinMs);
      if (canBargeIn) {
        log(`[moshi] barge-in rms=${Math.round(rms)} threshold=${bargeInThreshold}`);
        if (outputActive) this.stopCurrentSpeechOutput("moshi-barge-in");
        this.ignoreAudioUntil = 0;
      } else {
        if (this.shouldDropSpeakerEchoAudio(rms, "moshi")) return;
        return;
      }
    }

    this.bytesReceived += chunk.length;
    this.audioFrames += 1;
    this.maxRms = Math.max(this.maxRms, rms);

    if (!this.audioStatsTimer) {
      this.audioStatsTimer = setInterval(() => {
        log(`[audio.moshi] frames=${this.audioFrames} kb=${Math.round(this.bytesReceived / 1024)} maxRms=${Math.round(this.maxRms)} speaking=${this.speaking}`);
        this.audioFrames = 0;
        this.bytesReceived = 0;
        this.maxRms = 0;
      }, 2000);
    }

    const client = await this.ensureMoshiBridge();
    client?.sendAudio(chunk, this.sampleRate);
  }

  sendGeminiAudioChunk(session, chunk) {
    const inputChunk = applyPcm16Gain(chunk, geminiInputGain());
    session.sendRealtimeInput({
      audio: {
        data: inputChunk.toString("base64"),
        mimeType: `audio/pcm;rate=${this.sampleRate}`,
      },
    });
  }

  async finishGeminiAudioTurn(reason) {
    if (!this.activeSpeech) return;
    const durationMs = Date.now() - this.speechStartedAt;
    this.activeSpeech = false;
    log(`[gemini.vad] speech ended reason=${reason} durationMs=${Math.round(durationMs)}`);
    this.send({
      type: "input_audio_buffer.speech_stopped",
      item_id: `item_gemini_input_done_${Date.now()}`,
    });
    const session = await this.ensureGeminiLive();
    if (!session) return;
    if (geminiUsesLocalVadSignals()) {
      this.sendGeminiActivityEndIfNeeded(session);
    } else if (process.env.LOCAL_REALTIME_GEMINI_SEND_STREAM_END === "1") {
      session.sendRealtimeInput({ audioStreamEnd: true });
    }
  }

  sendGeminiActivityStartIfNeeded(session) {
    if (!geminiUsesLocalVadSignals() || !this.pendingGeminiActivityStart) return;
    session.sendRealtimeInput({ activityStart: {} });
    this.pendingGeminiActivityStart = false;
    this.geminiActivityOpen = true;
    log("[gemini.vad] activity start sent");
  }

  sendGeminiActivityEndIfNeeded(session) {
    if (!geminiUsesLocalVadSignals() || !this.geminiActivityOpen) return;
    session.sendRealtimeInput({ activityEnd: {} });
    this.geminiActivityOpen = false;
    log("[gemini.vad] activity end sent");
  }

  async ensureGeminiLive() {
    if (this.geminiDisabledReason) {
      await this.sendGeminiFailureNotice(this.geminiDisabledReason);
      return null;
    }
    if (this.geminiSession) return this.geminiSession;
    if (this.geminiReadyPromise) return this.geminiReadyPromise;

    this.geminiReadyPromise = (async () => {
      const apiKey = readGeminiApiKey();
      if (!apiKey) {
        log("[gemini] missing API key; set GEMINI_API_KEY or GOOGLE_API_KEY");
        if (!this.geminiMissingKeyNoticeSent) {
          this.geminiMissingKeyNoticeSent = true;
          await this.sendAssistantAnswer(
            "Gemini Live needs a Gemini API key. Set GEMINI_API_KEY, then restart this script.",
            { speak: false },
          );
        }
        return null;
      }

      const startedAt = Date.now();
      const { GoogleGenAI, Modality } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });
      const model = geminiLiveModel();
      const session = await ai.live.connect({
        model,
        config: geminiLiveConfig(Modality, this.codexSessionInstructions),
        callbacks: {
          onopen: () => log("[gemini] websocket opened"),
          onmessage: (message) => {
            this.onGeminiLiveMessage(message).catch((error) => {
              log(`[gemini] message handler failed: ${error.message}`);
            });
          },
          onerror: (event) => {
            const message = event?.message || event?.error?.message || String(event);
            log(`[gemini] websocket error: ${message}`);
            this.maybeDisableGemini(message);
          },
          onclose: (event) => {
            const reason = event?.reason || "no reason";
            log(`[gemini] websocket closed: ${reason}`);
            this.maybeDisableGemini(reason);
            const interruptedInput = this.geminiInputTranscript.trim();
            this.activeSpeech = false;
            this.geminiSession = null;
            this.geminiReadyPromise = null;
            if (/internal error/i.test(reason) && interruptedInput) {
              this.geminiInputTranscript = "";
              this.geminiOutputTranscript = "";
              this.retryGeminiTextAfterClose(interruptedInput).catch((error) => {
                log(`[gemini] retry failed: ${error.message}`);
              });
            }
          },
        },
      });
      this.geminiSession = session;
      log(`[gemini] connected model=${model} elapsedMs=${Date.now() - startedAt}`);
      return session;
    })();

    return this.geminiReadyPromise;
  }

  async retryGeminiTextAfterClose(text) {
    const cleanText = text.trim();
    if (!cleanText || !this.ws || this.ws.readyState !== this.ws.OPEN) return;
    log(`[gemini.retry] ${cleanText}`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const session = await this.ensureGeminiLive();
    if (!session) return;
    session.sendRealtimeInput({ text: cleanText });
  }

  maybeDisableGemini(message) {
    if (/api key not valid|invalid api key|permission denied/i.test(message)) {
      this.geminiDisabledReason =
        "Gemini Live rejected the API key. Export a valid GEMINI_API_KEY, then restart Codex realtime.";
      this.sendGeminiFailureNotice(this.geminiDisabledReason).catch((error) => {
        log(`[gemini] failure notice failed: ${error.message}`);
      });
    }
  }

  async sendGeminiFailureNotice(message) {
    const now = Date.now();
    const throttleMs = Number(process.env.LOCAL_REALTIME_GEMINI_ERROR_THROTTLE_MS || 15000);
    if (now - this.lastGeminiFailureNoticeAt < throttleMs) return;
    this.lastGeminiFailureNoticeAt = now;
    await this.sendAssistantAnswer(message, { speak: false });
  }

  async onGeminiLiveMessage(message) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      this.closeGeminiLive();
      return;
    }

    if (message.setupComplete) {
      log(`[gemini] setup complete session=${message.setupComplete.sessionId || "unknown"}`);
      return;
    }

    if (message.goAway) {
      log(`[gemini] goAway timeLeft=${message.goAway.timeLeft || "unknown"}`);
    }

    if (message.toolCall?.functionCalls?.length) {
      await this.onGeminiToolCalls(message.toolCall.functionCalls);
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      log("[gemini] interrupted");
      this.stopCurrentSpeechOutput("gemini-interrupted");
      this.geminiOutputTranscript = "";
      this.geminiDropOutputUntil = 0;
      return;
    }

    const inputTranscript = String(content.inputTranscription?.text || "").trim();
    if (inputTranscript) {
      this.geminiInputTranscript = appendTranscriptChunk(
        this.geminiInputTranscript,
        inputTranscript,
      );
      log(`[gemini.input] ${inputTranscript}`);
      this.updateGeminiBusyOutputPermission();
      this.send({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: `item_gemini_input_${Date.now()}`,
        content_index: 0,
        transcript: this.geminiInputTranscript,
      });
      if (this.isLikelyAssistantEcho(this.geminiInputTranscript)) {
        const recovered = recoverUserRequestFromMixedEcho(this.geminiInputTranscript);
        if (recovered) {
          log(`[echo] recovered user request from mixed speaker echo: ${recovered}`);
          this.geminiInputTranscript = recovered;
          this.geminiSuppressCurrentTurn = true;
          this.stopCurrentSpeechOutput("assistant-echo-recovered");
          await this.maybeStartGeminiHandoffFromInput();
        } else {
          log(`[echo] suppressing Gemini response to assistant audio: ${this.geminiInputTranscript}`);
          this.geminiInputTranscript = "";
        }
      } else {
        this.maybeStopForTranscriptBargeIn(this.geminiInputTranscript);
        await this.maybeStartGeminiHandoffFromInput();
      }
      this.finishCodexBargeIn("input-transcript");
    }

    const suppressLiveGeminiOutput = this.shouldSuppressLiveGeminiOutput();
    const dropGeminiOutput = Date.now() < this.geminiDropOutputUntil;
    const outputTranscript = String(content.outputTranscription?.text || "").trim();
    if (outputTranscript) {
      if (dropGeminiOutput) {
        log(`[gemini.output] dropped after barge-in: ${outputTranscript}`);
      } else if (suppressLiveGeminiOutput) {
        log(`[gemini.output] dropped while Codex handoff is active: ${outputTranscript}`);
      } else {
        this.geminiOutputTranscript = appendTranscriptChunk(
          this.geminiOutputTranscript,
          outputTranscript,
        );
        log(`[gemini.output] ${outputTranscript}`);
        if (this.isUnverifiedGeminiWorkClaim()) {
          this.geminiSuppressCurrentTurn = true;
          this.stopCurrentSpeechOutput("unverified-work-claim");
          log(`[gemini] suppressed unverified work claim: ${this.geminiOutputTranscript}`);
        }
      }
    }

    for (const part of content.modelTurn?.parts || []) {
      if (part.text && !part.thought && !dropGeminiOutput && !suppressLiveGeminiOutput) {
        this.geminiOutputTranscript = appendTranscriptChunk(
          this.geminiOutputTranscript,
          String(part.text).trim(),
        );
      }
      if (
        part.inlineData?.data &&
        !this.geminiSuppressCurrentTurn &&
        !dropGeminiOutput &&
        !suppressLiveGeminiOutput
      ) {
        const audioChunk = Buffer.from(part.inlineData.data, "base64");
        if (process.env.LOCAL_REALTIME_GEMINI_AUDIO_PLAYBACK !== "0") {
          if (geminiAudioPlaybackMode() === "codex") {
            this.sendGeminiAudioDelta(audioChunk);
            this.markCodexAudioOutput(audioChunk);
          } else if (geminiAudioPlaybackMode() === "stream") {
            this.geminiAudioPlayer.write(audioChunk);
          } else {
            this.geminiAudioBuffers.push(audioChunk);
          }
        }
      }
    }

    if (content.turnComplete || content.generationComplete) {
      await this.finishGeminiTurn();
    }
  }

  async maybeStartGeminiHandoffFromInput() {
    if (this.geminiVoiceOnlyActive) return;
    if (this.geminiDelegatedThisTurn) return;
    if (delegationMode === "off") return;

    const input = this.geminiInputTranscript.trim();
    if (!input || !canEarlyHandoffTranscript(input)) return;

    const intent = classifyTranscript(input, this.hasActiveHandoff());
    if (intent.action === "delegate") {
      this.geminiSuppressCurrentTurn = true;
      this.geminiDelegatedThisTurn = true;
      this.stopCurrentSpeechOutput("early-handoff");
      await this.requestBackgroundAgent(repairDelegationText(input));
    } else if (intent.action === "queue") {
      this.geminiSuppressCurrentTurn = true;
      this.geminiDelegatedThisTurn = true;
      this.queueHandoff(repairDelegationText(input));
    }
  }

  updateGeminiBusyOutputPermission() {
    if (!this.hasActiveHandoff()) return;
    const normalized = normalizeForIntent(this.geminiInputTranscript);
    if (
      isSideQuestionWhileBusy(normalized) ||
      isCasualRealtimeQuestion(normalized)
    ) {
      this.geminiAllowOutputThisTurn = true;
      return;
    }
    this.geminiAllowOutputThisTurn = false;
  }

  shouldSuppressLiveGeminiOutput() {
    return (
      this.hasActiveHandoff() &&
      !this.geminiVoiceOnlyActive &&
      !this.geminiAllowOutputThisTurn
    );
  }

  async onGeminiToolCalls(functionCalls) {
    const responses = [];
    for (const call of functionCalls) {
      if (call.name !== "background_agent") continue;
      let prompt =
        this.geminiInputTranscript.trim() ||
        String(call.args?.prompt || "").trim() ||
        "Continue the user's requested coding task.";
      if (this.isLikelyAssistantEcho(prompt)) {
        const recovered = recoverUserRequestFromMixedEcho(prompt);
        if (recovered) {
          log(`[gemini.tool] recovered user request from mixed echo: ${recovered}`);
          prompt = recovered;
          this.geminiInputTranscript = recovered;
        } else {
          log(`[gemini.tool] ignored assistant echo: ${prompt}`);
          responses.push({
            id: call.id,
            name: call.name,
            response: {
              output: "Ignore that. It was speaker echo from the assistant, not a new user request.",
            },
          });
          continue;
        }
      }
      if (this.geminiDelegatedThisTurn && this.hasActiveHandoff()) {
        log(`[gemini.tool] ignored duplicate tool call after early handoff: ${prompt}`);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            output:
              "This request was already handed to Codex. Do not start another background task.",
          },
        });
        continue;
      }
      if (isCasualRealtimeQuestion(normalizeForIntent(prompt))) {
        this.geminiAllowOutputThisTurn = true;
        log(`[gemini.tool] ignored casual background_agent: ${prompt}`);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            output: "Answer this casual voice question directly. Do not start Codex.",
          },
        });
        continue;
      }
      if (this.hasActiveHandoff() && shouldIgnoreBusyDelegationPrompt(prompt)) {
        this.geminiAllowOutputThisTurn = false;
        log(`[gemini.tool] ignored busy fragment: ${prompt}`);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            output:
              "Codex is already working. Ignore this short fragment unless the user asks a clear new question.",
          },
        });
        continue;
      }
      log(`[gemini.tool] background_agent: ${prompt}`);
      if (this.hasActiveHandoff() && isSideQuestionWhileBusy(normalizeForIntent(prompt))) {
        this.geminiAllowOutputThisTurn = true;
        log(`[gemini.tool] rerouted busy side question: ${prompt}`);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            output:
              "Codex is already working. Treat this as a live side question. Answer briefly from known context only. If you are not sure, say Codex is still checking instead of guessing.",
          },
        });
        continue;
      }
      this.geminiSuppressCurrentTurn = true;
      this.geminiDelegatedThisTurn = true;
      this.stopCurrentSpeechOutput("tool-call");
      await this.requestBackgroundAgent(prompt);
      responses.push({
        id: call.id,
        name: call.name,
        response: {
          output: "Codex is handling this request. Wait for Codex result context before giving task details.",
        },
      });
    }

    if (responses.length && this.geminiSession) {
      this.geminiSession.sendToolResponse({ functionResponses: responses });
    }
  }

  async finishGeminiTurn() {
    this.geminiAudioPlayer.endTurn();
    const input = this.geminiInputTranscript.trim();
    const output = this.geminiOutputTranscript.trim();
    let allowGeminiOutputWhileBusy = false;

    if (this.geminiVoiceOnlyActive) {
      if (output) log(`[gemini.voice] ${output}`);
      this.playBufferedGeminiAudio(output).catch((error) => {
        log(`[gemini.audio] buffered playback failed: ${error.message}`);
      });
      this.geminiInputTranscript = "";
      this.geminiOutputTranscript = "";
      this.geminiSuppressCurrentTurn = false;
      this.geminiDelegatedThisTurn = false;
      this.geminiAllowOutputThisTurn = false;
      this.geminiVoiceOnlyActive = false;
      this.geminiAudioItemId = "";
      return;
    }

    if (input && this.isLikelyAssistantEcho(input)) {
      const recovered = recoverUserRequestFromMixedEcho(input);
      if (recovered) {
        log(`[echo] recovered user request at turn end: ${recovered}`);
        this.geminiInputTranscript = recovered;
        this.geminiSuppressCurrentTurn = true;
        if (!this.geminiDelegatedThisTurn && delegationMode !== "off") {
          const intent = classifyTranscript(recovered, this.hasActiveHandoff());
          if (intent.action === "delegate") {
            this.geminiDelegatedThisTurn = true;
            await this.requestBackgroundAgent(repairDelegationText(recovered));
          } else if (intent.action === "queue") {
            this.geminiDelegatedThisTurn = true;
            this.queueHandoff(repairDelegationText(recovered));
          }
        }
      } else {
        log(`[echo] ignored likely assistant audio: ${input}`);
        this.geminiAudioBuffers = [];
        this.geminiInputTranscript = "";
        this.geminiOutputTranscript = "";
        this.geminiSuppressCurrentTurn = false;
        this.geminiDelegatedThisTurn = false;
        this.geminiAllowOutputThisTurn = false;
        this.geminiAudioItemId = "";
        return;
      }
    }

    if (output && this.isUnverifiedGeminiWorkClaim()) {
      this.geminiSuppressCurrentTurn = true;
      const recovered = recoverUserRequestFromMixedEcho(input) || input;
      const repaired = repairDelegationText(recovered);
      const normalized = repairLocalTranscript(normalizeForIntent(repaired));
      if (normalized && !this.geminiDelegatedThisTurn && delegationMode !== "off") {
        const intent = classifyTranscript(repaired, this.hasActiveHandoff());
        if (intent.action === "delegate") {
          this.geminiDelegatedThisTurn = true;
          await this.requestBackgroundAgent(repaired);
        } else if (intent.action === "queue") {
          this.geminiDelegatedThisTurn = true;
          this.queueHandoff(repaired);
        }
      }
      if (!this.hasActiveHandoff() && !this.geminiDelegatedThisTurn) {
        await this.sendAssistantAnswer("I heard you, but I did not send a Codex task yet. Please repeat the task clearly.", {
          speak: false,
        });
      }
      log(`[gemini] blocked status claim without confirmed Codex task: ${output}`);
      this.geminiAudioBuffers = [];
      this.geminiInputTranscript = this.geminiDelegatedThisTurn ? this.geminiInputTranscript : "";
      this.geminiOutputTranscript = "";
      this.geminiSuppressCurrentTurn = true;
      this.geminiAudioItemId = "";
    }

    if (input && !this.geminiDelegatedThisTurn && delegationMode !== "off") {
      const intent = classifyTranscript(input, this.hasActiveHandoff());
      if (intent.action === "delegate") {
        this.geminiSuppressCurrentTurn = true;
        this.geminiDelegatedThisTurn = true;
        await this.requestBackgroundAgent(input);
      } else if (intent.action === "queue") {
        this.geminiSuppressCurrentTurn = true;
        this.queueHandoff(input);
      } else if (intent.action === "reply") {
        const isStopRequest = isStopOrDismissal(normalizeForIntent(input));
        if (isStopRequest) {
          this.geminiSuppressCurrentTurn = true;
          this.cancelPendingHandoffs("user-stop");
          this.stopCurrentSpeechOutput("user-stop");
          await this.sendAssistantAnswer(intent.reply, { speak: intent.speak !== false });
        } else if (output) {
          // Gemini already produced the natural realtime answer. Let that audio
          // play instead of injecting a second canned local answer.
          allowGeminiOutputWhileBusy = true;
          log(`[gemini] using native realtime reply for: ${input}`);
        } else {
          this.geminiSuppressCurrentTurn = true;
          await this.sendAssistantAnswer(intent.reply, { speak: intent.speak !== false });
        }
      } else if (intent.action === "local_chat") {
        allowGeminiOutputWhileBusy = true;
      }
    }

    const suppressGeminiOutput =
      this.geminiSuppressCurrentTurn ||
      (this.hasActiveHandoff() && !allowGeminiOutputWhileBusy);
    const followup = setupOnlyJokePunchline(input, output);
    if (output && !suppressGeminiOutput) {
      this.rememberSpokenText(output);
      await this.sendAssistantAnswer(output, { speak: false });
    } else if (output && suppressGeminiOutput) {
      this.rememberSpokenText(output);
      log(`[gemini] suppressed output while Codex handoff is active: ${output}`);
    }

    if (!suppressGeminiOutput) {
      this.playBufferedGeminiAudio(output).catch((error) => {
        log(`[gemini.audio] buffered playback failed: ${error.message}`);
      });
    } else {
      this.geminiAudioBuffers = [];
    }
    if (followup && !suppressGeminiOutput) {
      this.sendAssistantAnswerAfterAudio(followup).catch((error) => {
        log(`[assistant] joke followup failed: ${error.message}`);
      });
    }

    this.geminiInputTranscript = "";
    this.geminiOutputTranscript = "";
    this.geminiSuppressCurrentTurn = false;
    this.geminiDelegatedThisTurn = false;
    this.geminiAllowOutputThisTurn = false;
    this.geminiAudioItemId = "";
  }

  stopCurrentSpeechOutput(reason) {
    clearTimeout(this.codexAudioOutputTimer);
    this.codexAudioOutputTimer = null;
    this.codexAudioPlaybackUntil = 0;
    this.codexAudioOutputUntil = 0;
    this.geminiAudioPlayer.stop(reason);
    this.geminiAudioBuffers = [];
    this.closeGeminiVoiceSession(reason);
    this.sendGeminiAudioCancelEvents(reason);
    this.sendOpenAIRealtimeAudioCancelEvents(reason);
    cancelCurrentSpeech(reason);
    this.speaking = false;
    this.speechInterrupted = true;
    this.speechOutputStartedAt = 0;
    this.ignoreAudioUntil = 0;
    this.cancelActiveSpeech(reason);
  }

  maybeStopForTranscriptBargeIn(transcript) {
    if (!this.shouldUseTranscriptBargeIn()) return false;
    const now = Date.now();
    const outputActive = this.speaking || isSpeechOutputActive() || now < this.codexAudioOutputUntil;
    if (!outputActive) return false;
    const cleanText = String(transcript || "").trim();
    if (!cleanText || this.isLikelyAssistantEcho(cleanText)) return false;

    log(`[gemini] transcript barge-in: ${cleanText}`);
    this.geminiDropOutputUntil =
      now + Number(process.env.LOCAL_REALTIME_GEMINI_DROP_OUTPUT_AFTER_BARGE_MS || 1500);
    this.notifyCodexBargeIn("transcript-barge-in", 0);
    this.stopCurrentSpeechOutput("transcript-barge-in");
    return true;
  }

  shouldUseTranscriptBargeIn() {
    return (
      process.env.LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN === "1" &&
      geminiBargeInMode() === "transcript"
    );
  }

  notifyCodexBargeIn(reason, rms = 0) {
    if (this.codexBargeInActive) return;
    this.codexBargeInActive = true;
    this.codexBargeInItemId = `item_barge_${Date.now()}`;
    log(`[barge-in] notifying Codex reason=${reason} rms=${Math.round(rms)}`);
    this.send({
      type: "input_audio_buffer.speech_started",
      item_id: this.codexBargeInItemId,
    });
    this.send({ type: "output_audio_buffer.cleared" });

    clearTimeout(this.codexBargeInStopTimer);
    this.codexBargeInStopTimer = setTimeout(() => {
      this.finishCodexBargeIn("timeout");
    }, Number(process.env.LOCAL_REALTIME_BARGE_IN_STOP_TIMEOUT_MS || 1800));
  }

  finishCodexBargeIn(reason) {
    if (!this.codexBargeInActive) return;
    clearTimeout(this.codexBargeInStopTimer);
    this.codexBargeInStopTimer = null;
    const itemId = this.codexBargeInItemId || `item_barge_done_${Date.now()}`;
    this.codexBargeInActive = false;
    this.codexBargeInItemId = "";
    log(`[barge-in] speech stopped reason=${reason}`);
    this.send({
      type: "input_audio_buffer.speech_stopped",
      item_id: itemId,
    });
  }

  sendGeminiAudioCancelEvents(reason) {
    const itemId = this.geminiAudioItemId;
    if (!itemId) return;
    this.send({
      type: "response.output_audio.done",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
    });
    const transcript = this.geminiOutputTranscript.trim();
    if (transcript) {
      this.send({
        type: "response.output_audio_transcript.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        transcript,
      });
    }
    log(`[audio] cancelled output item=${itemId} reason=${reason}`);
    this.geminiAudioItemId = "";
  }

  sendOpenAIRealtimeAudioCancelEvents(reason) {
    const itemId = this.openaiRealtimeAudioItemId;
    if (!itemId) return;
    this.send({
      type: "response.output_audio.done",
      item_id: itemId,
      reason,
    });
    this.openaiRealtimeAudioItemId = "";
    this.openaiRealtimeAudioMs = 0;
  }

  truncateOpenAIRealtimeAudio(reason) {
    const itemId = this.openaiRealtimeAudioItemId;
    if (!itemId) return false;
    const audioEndMs = Math.max(0, Math.round(this.openaiRealtimeAudioMs || 0));
    const sent = this.sendOpenAIRealtimeEvent({
      type: "conversation.item.truncate",
      item_id: itemId,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });
    log(`[openai.realtime] truncate audio item=${itemId} audio_end_ms=${audioEndMs} reason=${reason}`);
    return sent;
  }

  onGeminiPlaybackState(isSpeaking) {
    this.speaking = isSpeaking;
    if (!isSpeaking) {
      this.ignoreAudioUntil =
        Date.now() + Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
    }
  }

  closeGeminiLive() {
    this.geminiAudioPlayer.stop("session-close");
    this.geminiAudioBuffers = [];
    this.closeGeminiVoiceSession("session-close");
    if (this.geminiSession) {
      try {
        this.geminiSession.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.geminiSession = null;
    this.geminiReadyPromise = null;
    this.pendingGeminiActivityStart = false;
    this.geminiActivityOpen = false;
    this.geminiVoiceOnlyActive = false;
    this.geminiAudioItemId = "";
    clearTimeout(this.codexAudioOutputTimer);
    this.codexAudioOutputTimer = null;
    this.codexAudioPlaybackUntil = 0;
    this.codexAudioOutputUntil = 0;
  }

  closeGeminiVoiceSession(reason) {
    if (!this.geminiVoiceSession) return;
    try {
      this.geminiVoiceSession.close();
      log(`[gemini.voice] closed reason=${reason}`);
    } catch {
      // Best-effort cleanup.
    }
    this.geminiVoiceSession = null;
    this.geminiVoiceOnlyActive = false;
  }

  async ensureMoshiBridge() {
    if (this.moshiClient) return this.moshiClient;
    this.moshiClient = new MoshiBridgeClient(this);
    await this.moshiClient.connect();
    return this.moshiClient;
  }

  closeMoshiBridge() {
    clearTimeout(this.moshiTextFlushTimer);
    this.moshiTextFlushTimer = null;
    this.moshiClient?.close();
    this.moshiClient = null;
    this.moshiAudioItemId = "";
    this.moshiResponseId = "";
    clearInterval(this.moshiAudioStatsTimer);
    this.moshiAudioStatsTimer = null;
    this.moshiAudioPlayer.stop("session-close");
  }

  onMoshiAudioOutput(audioChunk, sampleRate = 24000) {
    if (!audioChunk.length) return;
    const outputRms = pcm16Rms(audioChunk);
    this.trackMoshiAudioOutput(audioChunk, outputRms);
    this.ensureMoshiResponse();
    if (!this.moshiAudioItemId) {
      this.moshiAudioItemId = `item_moshi_audio_${Date.now()}`;
    }
    const audibleRms = Number(process.env.LOCAL_REALTIME_MOSHI_OUTPUT_MIN_RMS || 45);
    const directPlayback = process.env.LOCAL_REALTIME_MOSHI_DIRECT_PLAYBACK !== "0";
    if (directPlayback && outputRms >= audibleRms) {
      this.moshiAudioPlayer.write(audioChunk);
    }
    if (process.env.LOCAL_REALTIME_MOSHI_CODEX_AUDIO === "1") {
      this.send({
        type: "response.output_audio.delta",
        delta: audioChunk.toString("base64"),
        sample_rate: sampleRate,
        channels: 1,
        samples_per_channel: Math.floor(audioChunk.length / 2),
        item_id: this.moshiAudioItemId,
      });
    }
    if (outputRms >= audibleRms) {
      this.markCodexAudioOutput(audioChunk, sampleRate);
    }
    this.scheduleMoshiFlush();
  }

  onMoshiPlaybackState(isSpeaking) {
    this.speaking = isSpeaking;
    if (isSpeaking) {
      this.speechOutputStartedAt ||= Date.now();
      return;
    }
    this.speechOutputStartedAt = 0;
    this.ignoreAudioUntil =
      Date.now() + Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
  }

  onMoshiTextDelta(delta) {
    const cleanDelta = String(delta || "");
    if (!cleanDelta) return;
    this.ensureMoshiResponse();
    this.moshiOutputTranscript += cleanDelta;
    this.send({ type: "response.output_text.delta", delta: cleanDelta });
    this.scheduleMoshiFlush();
  }

  trackMoshiAudioOutput(audioChunk, outputRms) {
    this.moshiAudioChunks += 1;
    this.moshiAudioBytes += audioChunk.length;
    this.moshiAudioMaxRms = Math.max(this.moshiAudioMaxRms, outputRms);
    if (this.moshiAudioStatsTimer) return;
    this.moshiAudioStatsTimer = setInterval(() => {
      log(
        `[moshi.audio.out] chunks=${this.moshiAudioChunks} kb=${Math.round(this.moshiAudioBytes / 1024)} maxRms=${Math.round(this.moshiAudioMaxRms)}`,
      );
      this.moshiAudioChunks = 0;
      this.moshiAudioBytes = 0;
      this.moshiAudioMaxRms = 0;
    }, 2000);
  }

  scheduleMoshiFlush() {
    clearTimeout(this.moshiTextFlushTimer);
    const flushMs = Number(process.env.LOCAL_REALTIME_MOSHI_FLUSH_MS || 3500);
    this.moshiTextFlushTimer = setTimeout(() => this.flushMoshiText(), flushMs);
  }

  ensureMoshiResponse() {
    if (this.moshiResponseId) return;
    this.moshiResponseId = `resp_moshi_${++this.responseCount}`;
    this.send({ type: "response.created", response: { id: this.moshiResponseId } });
  }

  flushMoshiText() {
    const transcript = this.moshiOutputTranscript.trim();
    if (!this.moshiResponseId) return;
    if (process.env.LOCAL_REALTIME_MOSHI_DIRECT_PLAYBACK !== "0") {
      this.moshiAudioPlayer.endTurn();
    }
    if (transcript) {
      this.rememberSpokenText(transcript);
      log(`[moshi.output] ${transcript}`);
      this.send({ type: "response.output_text.done", text: transcript });
      this.send({ type: "response.output_audio_transcript.done", transcript });
    }
    this.send({ type: "response.done", response: { id: this.moshiResponseId, output: [] } });
    this.moshiOutputTranscript = "";
    this.moshiResponseId = "";
    this.moshiAudioItemId = "";
    this.moshiTextFlushTimer = null;
  }

  sendGeminiAudioDelta(audioChunk) {
    if (!audioChunk.length) return;
    if (!this.geminiAudioItemId) {
      this.geminiAudioItemId = `item_gemini_audio_${Date.now()}`;
    }
    this.send({
      type: "response.output_audio.delta",
      delta: audioChunk.toString("base64"),
      sample_rate: this.geminiOutputRate,
      channels: 1,
      samples_per_channel: Math.floor(audioChunk.length / 2),
      item_id: this.geminiAudioItemId,
    });
  }

  markCodexAudioOutput(audioChunk, sampleRate = this.geminiOutputRate) {
    const samples = Math.floor(audioChunk.length / 2);
    const durationMs = Math.max(40, Math.round((samples * 1000) / sampleRate));
    const now = Date.now();
    const ignoreMs = Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
    this.speaking = true;
    this.lastSpokenAt = now;
    this.speechOutputStartedAt ||= now;
    this.codexAudioPlaybackUntil = Math.max(this.codexAudioPlaybackUntil, now) + durationMs;
    this.codexAudioOutputUntil = this.codexAudioPlaybackUntil + ignoreMs;
    this.scheduleCodexAudioOutputEnd();
  }

  scheduleCodexAudioOutputEnd() {
    clearTimeout(this.codexAudioOutputTimer);
    const delayMs = Math.max(20, this.codexAudioOutputUntil - Date.now());
    this.codexAudioOutputTimer = setTimeout(() => {
      if (Date.now() + 5 < this.codexAudioOutputUntil) {
        this.scheduleCodexAudioOutputEnd();
        return;
      }
      this.speaking = false;
      this.speechOutputStartedAt = 0;
      this.codexAudioPlaybackUntil = 0;
      this.ignoreAudioUntil = Date.now() + Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
      this.codexAudioOutputTimer = null;
      log("[audio] codex playback window ended");
    }, delayMs);
  }

  async sendAssistantAnswerAfterAudio(text) {
    const waitMs = Math.max(80, this.codexAudioOutputUntil - Date.now() + 120);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    await this.sendAssistantAnswer(text);
  }

  async playBufferedGeminiAudio(speechHint = "") {
    const audio = Buffer.concat(this.geminiAudioBuffers);
    this.geminiAudioBuffers = [];
    if (!audio.length || process.env.LOCAL_REALTIME_GEMINI_AUDIO_PLAYBACK === "0") return;

    const wavPath = `/tmp/codex-gemini-live-${process.pid}-${Date.now()}.wav`;
    await writeFile(wavPath, pcm16ToWav(audio, this.geminiOutputRate));
    this.speaking = true;
    this.rememberSpokenText(speechHint || "");
    this.speechOutputStartedAt = this.lastSpokenAt;
    try {
      await new Promise((resolve) => {
        const child = spawn("afplay", [wavPath], { stdio: "ignore" });
        currentSpeechProcess = child;
        child.on("exit", resolve);
        child.on("error", resolve);
        child.on("close", () => {
          if (currentSpeechProcess === child) currentSpeechProcess = null;
        });
      });
    } finally {
      this.speaking = false;
      this.speechOutputStartedAt = 0;
      this.ignoreAudioUntil =
        Date.now() + Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
      unlink(wavPath).catch(() => {});
    }
  }

  isLikelyAssistantEcho(text) {
    const echoWindowMs = Number(process.env.LOCAL_REALTIME_ECHO_WINDOW_MS || 90000);
    if (Date.now() - this.lastSpokenAt > echoWindowMs) return false;
    return this.recentSpokenTexts.some((spokenText) => isLikelyEchoOf(text, spokenText));
  }

  shouldDropOpenAIRealtimeSpeakerAudio(rms) {
    if (process.env.LOCAL_REALTIME_SUPPRESS_SPEAKER_ECHO === "0") return false;
    if (openAIRealtimeBargeInMode() !== "local") {
      return this.shouldDropSpeakerEchoAudio(rms, "openai");
    }

    const threshold = Number(
      process.env.LOCAL_REALTIME_OPENAI_BARGE_IN_RMS ||
        process.env.LOCAL_REALTIME_BARGE_IN_RMS ||
        3200,
    );
    const minFrames = Number(process.env.LOCAL_REALTIME_OPENAI_BARGE_IN_FRAMES || 8);
    const passThroughMs = Number(process.env.LOCAL_REALTIME_OPENAI_BARGE_IN_PASS_MS || 2500);

    if (threshold > 0 && rms >= threshold) {
      this.openaiRealtimeBargeInFrames += 1;
    } else {
      this.openaiRealtimeBargeInFrames = Math.max(0, this.openaiRealtimeBargeInFrames - 1);
    }

    if (threshold > 0 && this.openaiRealtimeBargeInFrames >= minFrames) {
      log(
        `[openai.barge-in] allowing mic audio rms=${Math.round(rms)} threshold=${threshold} frames=${this.openaiRealtimeBargeInFrames}`,
      );
      this.openaiRealtimeBargeInFrames = 0;
      this.openaiRealtimeBargeInUntil = Date.now() + passThroughMs;
      this.truncateOpenAIRealtimeAudio("local-barge-in");
      if (this.openaiRealtimeActiveResponseId) {
        this.sendOpenAIRealtimeEvent({ type: "response.cancel" });
        this.openaiRealtimeActiveResponseId = "";
      }
      this.stopCurrentSpeechOutput("local-barge-in");
      return false;
    }

    return this.shouldDropSpeakerEchoAudio(rms, "openai");
  }

  shouldDropSpeakerEchoAudio(rms, source) {
    if (process.env.LOCAL_REALTIME_SUPPRESS_SPEAKER_ECHO === "0") return false;
    // Allow loud audio through during speech output for instant interruption.
    // Threshold 3000 ≈ normal speaking volume; drops quiet echo/hum.
    if (rms >= 3000) return false;
    const now = Date.now();
    const outputActive =
      this.speaking ||
      isSpeechOutputActive() ||
      now < this.codexAudioOutputUntil;
    if (!outputActive) return false;
    // During the ignore-after-speak window, drop quiet audio (echo) but
    // pass through loud audio (actual user command like "stop"):
    if (now < this.ignoreAudioUntil) {
      if (rms < 2000) return true;
      return false;
    }

    if (this.activeSpeech) this.cancelActiveSpeech("speaker-output");
    if (now - this.lastSpeakerEchoDropLogAt > 2000) {
      this.lastSpeakerEchoDropLogAt = now;
      log(`[echo.${source}] dropped speaker/output audio rms=${Math.round(rms)}`);
    }
    return true;
  }

  isUnverifiedGeminiWorkClaim() {
    const output = this.geminiOutputTranscript.trim();
    if (!claimsCodexWorkStatus(output)) return false;
    return !this.geminiDelegatedThisTurn && !this.hasActiveHandoff();
  }

  rememberSpokenText(text) {
    const cleanText = textForSpeech(text);
    if (!cleanText) return;
    this.lastSpokenText = cleanText;
    this.lastSpokenAt = Date.now();
    this.recentSpokenTexts = [
      cleanText,
      ...this.recentSpokenTexts.filter((entry) => entry !== cleanText),
    ].slice(0, 8);
  }

  armSilenceTimer() {
    clearTimeout(this.silenceTimer);
    const silenceMs = Number(process.env.LOCAL_REALTIME_SILENCE_MS || 650);
    this.silenceTimer = setTimeout(() => this.finishSpeechIfQuiet(), silenceMs);
  }

  async finishSpeechIfQuiet() {
    if (!this.activeSpeech) return;

    const silenceMs = Number(process.env.LOCAL_REALTIME_SILENCE_MS || 650);
    if (Date.now() - this.lastVoiceAt < silenceMs) {
      this.armSilenceTimer();
      return;
    }

    await this.finishSpeech("silence");
  }

  cancelActiveSpeech(reason) {
    if (!this.activeSpeech) return;
    log(`[vad] cancelled active speech reason=${reason}`);
    this.activeSpeech = false;
    this.speechChunks = [];
    clearTimeout(this.silenceTimer);
  }

  async finishSpeech(reason) {
    if (!this.activeSpeech) return;

    const audio = Buffer.concat(this.speechChunks);
    this.activeSpeech = false;
    this.speechChunks = [];
    clearTimeout(this.silenceTimer);

    const durationMs = (audio.length / 2 / this.sampleRate) * 1000;
    const minMs = Number(process.env.LOCAL_REALTIME_MIN_AUDIO_MS || 400);
    log(`[vad] speech ended reason=${reason} durationMs=${Math.round(durationMs)}`);
    if (durationMs < minMs) {
      log(`[vad] ignored short audio durationMs=${Math.round(durationMs)} minMs=${minMs}`);
      return;
    }

    const transcript = await this.transcribe(audio);
    if (!transcript) {
      await this.sendSttFailureNotice();
      return;
    }

    this.send({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `item_input_done_${Date.now()}`,
      content_index: 0,
      transcript,
    }, { transcriptEvent: true });
    await this.handleTranscript(transcript);
  }

  async transcribe(audio) {
    if (sttMode === "fake") {
      log(`[stt] using fake transcript (${Math.round(audio.length / 1024)} KB audio)`);
      return fakeTranscript;
    }

    if (sttMode === "local" || sttMode === "whisper") {
      return this.transcribeLocal(audio);
    }

    if (sttMode === "groq") {
      return this.transcribeGroq(audio);
    }

    if (sttMode !== "openai") {
      log(
        `[stt] unsupported mode ${sttMode}; set LOCAL_REALTIME_STT=local, openai, groq, or fake`,
      );
      return "";
    }

    const apiKey = await readApiKey();
    if (!apiKey) {
      log("[stt] no API key found; set OPENAI_API_KEY or use LOCAL_REALTIME_STT=fake");
      return "";
    }

    const wav = pcm16ToWav(audio, this.sampleRate);
    const form = new FormData();
    form.set("model", process.env.LOCAL_REALTIME_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    form.set("response_format", "json");
    form.set("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");

    try {
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        log(`[stt] transcription failed: ${response.status} ${text.slice(0, 200)}`);
        this.lastSttFailure = readableOpenAIError(response.status, text);
        return "";
      }
      const json = JSON.parse(text);
      const transcript = String(json.text || "").trim();
      log(`[stt] ${transcript || "(empty)"}`);
      return transcript;
    } catch (error) {
      log(`[stt] transcription error: ${error.message}`);
      this.lastSttFailure = `Speech-to-text failed: ${error.message}`;
      return "";
    }
  }

  async transcribeGroq(audio) {
    const startedAt = Date.now();
    const apiKey = readGroqApiKey();
    if (!apiKey) {
      this.lastSttFailure =
        "Groq speech-to-text needs GROQ_API_KEY in the terminal before starting realtime.";
      log("[stt.groq] missing GROQ_API_KEY");
      return "";
    }

    const wav = pcm16ToWav(audio, this.sampleRate);
    const form = new FormData();
    form.set("model", groqTranscriptionModel());
    form.set("response_format", "json");
    const language = process.env.LOCAL_REALTIME_GROQ_TRANSCRIBE_LANGUAGE || "en";
    if (language && language !== "auto") form.set("language", language);
    form.set("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");

    try {
      const response = await fetch(groqTranscriptionUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const text = await response.text();
      if (!response.ok) {
        log(`[stt.groq] transcription failed: ${response.status} ${text.slice(0, 200)}`);
        this.lastSttFailure = readableGroqError(response.status, text);
        return "";
      }
      const json = JSON.parse(text);
      const transcript = String(json.text || "").replace(/\s+/g, " ").trim();
      log(`[stt.groq] ${transcript || "(empty)"} elapsedMs=${Date.now() - startedAt}`);
      return transcript;
    } catch (error) {
      const message = `Groq speech-to-text failed: ${error.message}`;
      log(`[stt.groq] ${message}`);
      this.lastSttFailure = message;
      return "";
    }
  }

  async transcribeLocal(audio) {
    const startedAt = Date.now();
    try {
      const transcriber = await loadLocalTranscriber();
      const targetRate = Number(process.env.LOCAL_REALTIME_LOCAL_STT_SAMPLE_RATE || 16000);
      const waveform = pcm16ToFloat32Resampled(audio, this.sampleRate, targetRate);
      const options = {
        chunk_length_s: Number(process.env.LOCAL_REALTIME_LOCAL_STT_CHUNK_SECONDS || 0),
      };
      if (!localTranscriptionModel().includes(".en")) {
        options.task = process.env.LOCAL_REALTIME_LOCAL_STT_TASK || "transcribe";
        const language = process.env.LOCAL_REALTIME_LOCAL_STT_LANGUAGE || "english";
        if (language && language !== "auto") options.language = language;
      }

      const result = await transcriber(waveform, options);
      const transcript = String(result?.text || "").replace(/\s+/g, " ").trim();
      if (isLikelyLocalSttHallucination(transcript, audio, this.sampleRate)) {
        log(`[stt.local] ignored likely hallucination: ${transcript || "(empty)"}`);
        return "";
      }
      log(`[stt.local] ${transcript || "(empty)"} elapsedMs=${Date.now() - startedAt}`);
      return transcript;
    } catch (error) {
      const message = `Local speech-to-text failed: ${error.message}`;
      log(`[stt.local] ${message}`);
      this.lastSttFailure = message;
      return "";
    }
  }

  async sendSttFailureNotice() {
    if (!this.lastSttFailure) return;

    const now = Date.now();
    const throttleMs = Number(process.env.LOCAL_REALTIME_STT_ERROR_THROTTLE_MS || 30000);
    if (now - this.lastSttFailureNoticeAt < throttleMs) return;

    this.lastSttFailureNoticeAt = now;
    await this.sendAssistantAnswer(this.lastSttFailure, { speak: false });
  }

  async handleTranscript(text) {
    const intent = classifyTranscript(text, this.hasActiveHandoff());
    log(`[intent] ${intent.action}: ${text}`);

    if (intent.action === "delegate") {
      await this.requestBackgroundAgent(repairDelegationText(text));
      return;
    }

    if (intent.action === "queue") {
      const queued = this.queueHandoff(repairDelegationText(text));
      if (queued && !this.busyNoticeSent) {
        this.busyNoticeSent = true;
        this.scheduleHandoffAcknowledgement(text, { queued: true });
      }
      return;
    }

    if (intent.action === "local_chat") {
      const answer = await answerLocalChat(text, this.hasActiveHandoff());
      if (!answer) return;
      await this.sendAssistantAnswer(answer);
      return;
    }

    if (intent.reply && isStopOrDismissal(normalizeForIntent(text))) {
      this.cancelPendingHandoffs("user-stop");
      this.stopCurrentSpeechOutput("user-stop");
    }

    if (intent.reply) {
      await this.sendAssistantAnswer(intent.reply, { speak: intent.speak !== false });
    }
  }

  async onConversationItem(item) {
    if (item.type === "function_call_output") {
      const callId = item.call_id || "";
      const pending = this.pendingHandoffs.get(callId);
      const output = String(item.output || "");
      if (output.startsWith("Background agent finished")) {
        if (!pending) {
          log(`[handoff] ignored finish for unknown call_id=${callId}`);
          return;
        }
        const answer = pending?.backendText?.trim() || "Done.";
        clearTimeout(pending?.fallbackTimer);
        if (pending?.target === "openai-realtime") {
          if (!pending.answerSent) {
            pending.answerSent = true;
            await this.completeOpenAIRealtimeHandoff(pending, answer);
          } else {
            log(`[handoff] skipped duplicate OpenAI realtime result call_id=${callId}`);
          }
          this.pendingHandoffs.delete(callId);
          this.busyNoticeSent = false;
          this.scheduleNextQueuedWork();
          return;
        }
        if (pending?.target === "openai-realtime-side") {
          if (!pending.answerSent) {
            pending.answerSent = true;
            await this.sendOpenAIRealtimeSideTaskResult(answer);
          } else {
            log(`[handoff] skipped duplicate OpenAI realtime side result call_id=${callId}`);
          }
          this.pendingHandoffs.delete(callId);
          this.busyNoticeSent = false;
          this.scheduleNextQueuedWork();
          return;
        }
        if (!pending?.answerSent) {
          if (pending) pending.answerSent = true;
          await this.sendAssistantAnswer(answer, {
            speechText: backendSpeechSummary(answer),
          });
        } else {
          log(`[handoff] skipped duplicate finished answer call_id=${callId}`);
        }
        this.pendingHandoffs.delete(callId);
        this.busyNoticeSent = false;
        this.scheduleNextQueuedWork();
      }
      return;
    }

    const text = extractItemText(item).trim();
    if (!text) return;

    if (text.startsWith("[BACKEND]")) {
      const handoff = [...this.pendingHandoffs.values()].at(-1);
      if (handoff) {
        const stripped = text.replace(/^\[BACKEND\]\s*/, "");
        handoff.backendText = stripped;
        await this.syncGeminiContext("BACKEND", stripped);
      }
      return;
    }

    const userText = text.replace(/^\[USER\]\s*/, "");
    if (realtimeEngine === "openai-realtime") {
      await this.sendOpenAIRealtimeText(userText);
      return;
    }
    await this.requestBackgroundAgent(userText);
  }

  async onHandoffAppend(message) {
    const text = extractMessageText(message).trim();
    if (!text) {
      log(`[handoff.append] received keys=${Object.keys(message).join(",")}`);
      return;
    }

    const handoff =
      this.pendingHandoffs.get(message.handoff_id) ||
      [...this.pendingHandoffs.values()].at(-1);
    if (handoff) {
      handoff.backendText = appendHandoffText(handoff.backendText || "", text);
      log(`[handoff.append] ${text}`);
      await this.syncGeminiContext("BACKEND", text);
    }
  }

  async onResponseCreate() {
    const handoff = [...this.pendingHandoffs.values()].at(-1);
    if (handoff && realtimeEngine === "openai-realtime") {
      log("[handoff] response.create received while handoff is active; waiting for Background agent finished");
    } else if (handoff?.backendText && !handoff.answerSent) {
      handoff.answerSent = true;
      await this.sendAssistantAnswer(handoff.backendText, {
        speechText: backendSpeechSummary(handoff.backendText),
      });
    } else if (handoff?.backendText) {
      log("[handoff] skipped duplicate response.create answer");
    } else if (!handoff && realtimeEngine === "openai-realtime") {
      log("[openai.realtime] ignored bare response.create with no user input or handoff");
    }
  }

  async requestBackgroundAgent(text, options = {}) {
    const cleanText = text.trim();
    if (!cleanText) return;
    if (this.hasActiveHandoff()) {
      const sideTask = options.sideTask || isSidetrackRequest(cleanText);
      const queued = sideTask
        ? this.queueSideTask(cleanText, {
            source: options.source,
            target: options.target === "openai-realtime" ? "openai-realtime-side" : options.target,
          })
        : this.queueHandoff(cleanText);
      if (queued) {
        log(`[handoff] queued while active: ${cleanText}`);
        this.scheduleHandoffAcknowledgement(cleanText, { queued: true, sideTask });
      }
      return;
    }

    const sequence = ++this.handoffCount;
    const callId = options.callId || `call_local_${sequence}`;
    const itemId = `item_local_${sequence}`;
    const fallbackTimer =
      handoffFallbackMs > 0
        ? setTimeout(async () => {
            const pending = this.pendingHandoffs.get(callId);
            if (!pending || pending.backendText?.trim() || pending.answerSent) return;

            log("[handoff] no backend answer yet; speaking local fallback");
            pending.answerSent = true;
            await this.sendAssistantAnswer(`I heard: ${cleanText}`);
            this.pendingHandoffs.delete(callId);
            this.busyNoticeSent = false;
            this.scheduleNextQueuedWork();
          }, handoffFallbackMs)
        : null;
    this.pendingHandoffs.set(callId, {
      callId,
      externalCallId: options.externalCallId || callId,
      target: options.target || "local",
      sideTask: Boolean(options.sideTask),
      input: cleanText,
      backendText: "",
      answerSent: false,
      fallbackTimer,
    });
    this.busyNoticeSent = false;

    log(`[handoff] ${cleanText}`);
    this.send({
      type: "conversation.input_transcript.delta",
      delta: cleanText,
    });
    this.send({
      type: "conversation.handoff.requested",
      handoff_id: callId,
      item_id: itemId,
      input_transcript: cleanText,
    });
    this.send({
      type: "conversation.item.done",
      item: {
        id: itemId,
        type: "function_call",
        status: "completed",
        name: "background_agent",
        call_id: callId,
        arguments: JSON.stringify({ prompt: cleanText }),
      },
    });
    this.scheduleHandoffAcknowledgement(cleanText);
  }

  scheduleHandoffAcknowledgement(text, options = {}) {
    if (process.env.LOCAL_REALTIME_HANDOFF_ACK === "0") return;
    const now = Date.now();
    const minGapMs = Number(process.env.LOCAL_REALTIME_HANDOFF_ACK_MIN_GAP_MS || 1200);
    if (now - this.lastHandoffAckAt < minGapMs) return;
    this.lastHandoffAckAt = now;

    const message = handoffAcknowledgementFor(text, options);
    const delayMs = Number(process.env.LOCAL_REALTIME_HANDOFF_ACK_DELAY_MS || 120);
    const speak = process.env.LOCAL_REALTIME_HANDOFF_ACK_SPEAK === "1";
    setTimeout(() => {
      if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
      this.sendAssistantAnswer(message, { speak }).catch((error) => {
        log(`[handoff] acknowledgement failed: ${error.message}`);
      });
    }, delayMs);
  }

  hasActiveHandoff() {
    return this.pendingHandoffs.size > 0;
  }

  queueHandoff(text) {
    const cleanText = text.trim();
    if (!cleanText) return false;
    if (isSidetrackRequest(cleanText)) {
      return this.queueSideTask(cleanText);
    }
    if (this.hasActiveHandoff() && shouldIgnoreBusyDelegationPrompt(cleanText)) {
      log(`[handoff] ignored busy fragment: ${cleanText}`);
      return false;
    }
    if (this.isLikelyAssistantEcho(cleanText)) {
      log(`[handoff] ignored queued assistant echo: ${cleanText}`);
      return false;
    }
    const normalized = normalizeForIntent(cleanText);
    const alreadyActive = [...this.pendingHandoffs.values()].some(
      (handoff) => normalizeForIntent(handoff.input || "") === normalized,
    );
    if (alreadyActive) {
      log(`[handoff] ignored duplicate active request: ${cleanText}`);
      return false;
    }
    if (this.queuedHandoffText && normalizeForIntent(this.queuedHandoffText).includes(normalized)) {
      log(`[handoff] ignored duplicate queued request: ${cleanText}`);
      return false;
    }
    this.queuedHandoffText = this.queuedHandoffText
      ? `${this.queuedHandoffText}\n${cleanText}`
      : cleanText;
    log(`[handoff] queued: ${cleanText}`);
    return true;
  }

  queueSideTask(text, options = {}) {
    const cleanText = stripSidetrackRequest(text.trim());
    if (!cleanText) return false;
    if (this.hasActiveHandoff() && shouldIgnoreBusyDelegationPrompt(cleanText)) {
      log(`[side-task] ignored busy fragment: ${cleanText}`);
      return false;
    }
    if (this.isLikelyAssistantEcho(cleanText)) {
      log(`[side-task] ignored queued assistant echo: ${cleanText}`);
      return false;
    }

    const normalized = normalizeForIntent(cleanText);
    const alreadyActive = [...this.pendingHandoffs.values()].some(
      (handoff) => normalizeForIntent(handoff.input || "") === normalized,
    );
    if (alreadyActive) {
      log(`[side-task] ignored duplicate active request: ${cleanText}`);
      return false;
    }
    const alreadyQueued = this.queuedSideTasks.some(
      (task) => normalizeForIntent(task.text || "") === normalized,
    );
    if (alreadyQueued) {
      log(`[side-task] ignored duplicate queued request: ${cleanText}`);
      return false;
    }

    this.queuedSideTasks.push({
      text: cleanText,
      source: options.source || "voice",
      target: options.target || "local-side",
      requestedAt: Date.now(),
    });
    log(`[side-task] queued: ${cleanText}`);
    return true;
  }

  consumeQueuedHandoff() {
    const next = this.queuedHandoffText.trim();
    this.queuedHandoffText = "";
    return next;
  }

  consumeQueuedSideTask() {
    return this.queuedSideTasks.shift() || null;
  }

  scheduleNextQueuedWork() {
    const sideTask = this.consumeQueuedSideTask();
    if (sideTask) {
      setTimeout(() => {
        log(`[side-task] starting queued task: ${sideTask.text}`);
        this.requestBackgroundAgent(sideTask.text, {
          target: sideTask.target,
          source: sideTask.source,
          sideTask: true,
        }).catch((error) => {
          log(`[side-task] queued task failed: ${error.message}`);
        });
      }, 300);
      return;
    }

    const next = this.consumeQueuedHandoff();
    if (next) {
      setTimeout(() => {
        this.requestBackgroundAgent(next).catch((error) => {
          log(`[handoff] queued handoff failed: ${error.message}`);
        });
      }, 300);
    }
  }

  cancelPendingHandoffs(reason) {
    for (const handoff of this.pendingHandoffs.values()) {
      clearTimeout(handoff.fallbackTimer);
    }
    const count = this.pendingHandoffs.size;
    this.pendingHandoffs.clear();
    this.queuedHandoffText = "";
    this.queuedSideTasks = [];
    this.busyNoticeSent = false;
    if (count) log(`[handoff] cancelled pending=${count} reason=${reason}`);
  }

  async sendAssistantAnswer(text, options = {}) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      log(`[assistant] skipped closed websocket: ${String(text || "").slice(0, 120)}`);
      return;
    }

    const cleanText = text.trim();
    if (!cleanText) return;
    const speechText = textForSpeech(options.speechText || cleanText);

    const responseId = `resp_answer_${++this.responseCount}`;
    log(`[assistant] ${cleanText}`);
    if (speechText !== cleanText) log(`[assistant.speech] ${speechText}`);
    this.send({ type: "response.created", response: { id: responseId } });
    this.send(
      { type: "response.output_text.done", text: cleanText },
      { transcriptEvent: true },
    );
    this.send(
      { type: "response.output_audio_transcript.done", transcript: cleanText },
      { transcriptEvent: true },
    );
    this.send({ type: "response.done", response: { id: responseId, output: [] } });
    if (options.speak === false) return;

    if (this.shouldSpeakWithGemini()) {
      this.rememberSpokenText(speechText);
      await this.speakWithGeminiVoice(speechText);
      return;
    }

    this.speechChain = this.speechChain
      .catch(() => {})
      .then(async () => {
        this.speaking = true;
        this.rememberSpokenText(speechText);
        this.speechOutputStartedAt = this.lastSpokenAt;
        try {
          await speak(speechText);
        } finally {
          this.speaking = false;
          this.speechOutputStartedAt = 0;
          if (this.speechInterrupted) {
            this.speechInterrupted = false;
            this.ignoreAudioUntil = 0;
          } else {
            this.ignoreAudioUntil =
              Date.now() + Number(process.env.LOCAL_REALTIME_IGNORE_AFTER_SPEAK_MS || 1000);
          }
        }
      });
    await this.speechChain;
  }

  shouldSpeakWithGemini() {
    return (
      realtimeEngine === "gemini-live" &&
      process.env.LOCAL_REALTIME_GEMINI_VOICE_FOR_ALL !== "0" &&
      process.env.LOCAL_REALTIME_GEMINI_AUDIO_PLAYBACK !== "0"
    );
  }

  async speakWithGeminiVoice(text) {
    const cleanText = textForSpeech(text);
    if (!cleanText) return;

    log(`[gemini.voice] speak chars=${cleanText.length}`);
    await this.speakWithSeparateGeminiVoice(cleanText);
  }

  async speakWithSeparateGeminiVoice(cleanText) {
    const apiKey = readGeminiApiKey();
    if (!apiKey) {
      await this.sendGeminiFailureNotice(
        "Gemini Live needs a Gemini API key. Set GEMINI_API_KEY, then restart this script.",
      );
      return;
    }

    this.closeGeminiVoiceSession("replace-voice-session");
    const startedAt = Date.now();
    const cancelRevision = speechCancelRevision;
    const { GoogleGenAI, Modality } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    const audioBuffers = [];

    this.geminiVoiceOnlyActive = true;
    this.geminiSuppressCurrentTurn = false;
    this.geminiDelegatedThisTurn = false;
    this.geminiAllowOutputThisTurn = true;

    await new Promise((resolve, reject) => {
      let settled = false;
      let session = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.geminiVoiceSession === session) this.geminiVoiceSession = null;
        this.geminiVoiceOnlyActive = false;
        try {
          session?.close();
        } catch {
          // Best-effort cleanup.
        }
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error("Gemini voice session timed out"));
      }, Number(process.env.LOCAL_REALTIME_GEMINI_VOICE_TIMEOUT_MS || 30000));

      ai.live
        .connect({
          model: geminiLiveModel(),
          config: geminiVoiceReaderConfig(Modality),
          callbacks: {
            onopen: () => log("[gemini.voice] websocket opened"),
            onmessage: (message) => {
              if (speechCancelRevision !== cancelRevision) {
                finish();
                return;
              }
              const content = message.serverContent;
              if (!content) return;

              for (const part of content.modelTurn?.parts || []) {
                if (!part.inlineData?.data) continue;
                const audioChunk = Buffer.from(part.inlineData.data, "base64");
                if (!audioChunk.length) continue;
                if (process.env.LOCAL_REALTIME_GEMINI_AUDIO_PLAYBACK === "0") continue;
                if (geminiAudioPlaybackMode() === "codex") {
                  this.sendGeminiAudioDelta(audioChunk);
                  this.markCodexAudioOutput(audioChunk);
                } else if (geminiAudioPlaybackMode() === "stream") {
                  this.geminiAudioPlayer.write(audioChunk);
                } else {
                  audioBuffers.push(audioChunk);
                }
              }

              if (content.turnComplete || content.generationComplete || content.interrupted) {
                finish();
              }
            },
            onerror: (event) => {
              const message = event?.message || event?.error?.message || String(event);
              log(`[gemini.voice] websocket error: ${message}`);
              finish(new Error(message));
            },
            onclose: (event) => {
              log(`[gemini.voice] websocket closed: ${event?.reason || "no reason"}`);
              finish();
            },
          },
        })
        .then((connectedSession) => {
          session = connectedSession;
          this.geminiVoiceSession = session;
          log(`[gemini.voice] connected elapsedMs=${Date.now() - startedAt}`);
          sendGeminiReaderText(session, cleanText);
        })
        .catch(finish);
    });

    if (audioBuffers.length && speechCancelRevision === cancelRevision) {
      this.geminiAudioBuffers = audioBuffers;
      await this.playBufferedGeminiAudio(cleanText);
    }
  }

  async syncGeminiContext(label, text) {
    if (realtimeEngine !== "gemini-live") return;
    if (process.env.LOCAL_REALTIME_GEMINI_CONTEXT_SYNC !== "1") return;
    if (!this.geminiSession && !this.geminiReadyPromise) return;

    const cleanText = geminiContextText(text);
    if (!cleanText) return;

    const session = await this.ensureGeminiLive();
    if (!session) return;

    this.sendGeminiText(session, `[${label}] ${cleanText}`, { turnComplete: false });
    this.lastBackendContextAt = Date.now();
    log(`[gemini.context] ${label} chars=${cleanText.length}`);
  }

  sendGeminiText(session, text, options = {}) {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;

    if (isGemini31LiveModel()) {
      session.sendRealtimeInput({ text: cleanText });
      return;
    }

    session.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: cleanText }],
        },
      ],
      turnComplete: options.turnComplete !== false,
    });
  }

  send(message, options = {}) {
    if (options.transcriptEvent && transcriptForwardingMode() === "handoff-only") {
      log(`[transcript] suppressed ${message.type}`);
      return;
    }
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

function extractMessageText(message) {
  if (typeof message.text === "string") return message.text;
  if (typeof message.delta === "string") return message.delta;
  if (typeof message.output === "string") return message.output;
  if (typeof message.output_text === "string") return message.output_text;
  if (typeof message.content === "string") return message.content;
  if (message.item) return extractItemText(message.item);
  if (Array.isArray(message.content)) {
    return message.content
      .map((entry) => entry.text || entry.transcript || entry.delta || "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractItemText(item) {
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((entry) => entry.text || entry.transcript || "")
    .filter(Boolean)
    .join("\n");
}

function handoffAcknowledgementFor(text, options = {}) {
  const normalized = repairLocalTranscript(normalizeForIntent(text || ""));
  const phrase = handoffActionPhrase(normalized);
  if (options.sideTask) {
    return options.queued
      ? `I'm still working. I'll keep this as a side task.`
      : `I'll handle that as a side task.`;
  }
  if (options.queued) return `I'm still working. ${phrase.next}`;
  return phrase.now;
}

function isSidetrackRequest(text) {
  const normalized = repairLocalTranscript(normalizeForIntent(text || ""));
  return (
    /\b(on the side|as a side task|side task|side chat|side conversation|side thread|side check|side investigation|sidetrack|side track|side request)\b/.test(normalized) ||
    /\b(while you do that|while that runs|while it runs|while that's running|while that is running)\b/.test(normalized) ||
    /\b(in the background|separately|as a separate task|do not interrupt the current task|don't interrupt the current task)\b/.test(normalized)
  );
}

function stripSidetrackRequest(text) {
  return String(text || "")
    .replace(/^\s*(open|create|start|make)\s+(a\s+)?side\s+(chat|conversation|thread)\s+(to|for)\s+/i, "")
    .replace(/\b(as a side task|side task|sidetrack|side track|side request)\b/gi, "")
    .replace(/\b(on the side|in the background|separately|as a separate task)\b/gi, "")
    .replace(/\b(while you do that|while that runs|while it runs|while that's running|while that is running)\b/gi, "")
    .replace(/\b(do not interrupt the current task|don't interrupt the current task)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function handoffActionPhrase(normalized) {
  if (/\b(save|remember|note|store|write down)\b/.test(normalized)) {
    return { now: "I'll save that now.", next: "I'll save that next." };
  }
  if (/\b(run|execute)\b/.test(normalized)) {
    return { now: "I'll run that now.", next: "I'll run that next." };
  }
  if (/\b(test|verify)\b/.test(normalized)) {
    return { now: "I'll verify that now.", next: "I'll verify that next." };
  }
  if (/\b(build|compile)\b/.test(normalized)) {
    return { now: "I'll build that now.", next: "I'll build that next." };
  }
  if (/\b(fix|debug|repair)\b/.test(normalized)) {
    return { now: "I'll fix that now.", next: "I'll fix that next." };
  }
  if (/\b(commit|push|deploy)\b/.test(normalized)) {
    return { now: "I'll handle that now.", next: "I'll handle that next." };
  }
  if (
    /\b(open|launch|go to|pull up)\b/.test(normalized) &&
    !/\bopen (pull request|pr|issue|ticket)\b/.test(normalized)
  ) {
    return { now: "I'll open that now.", next: "I'll open that next." };
  }
  if (/\b(add|create|make|implement|write|edit|update|change|remove|delete|wire|connect|hook)\b/.test(normalized)) {
    return { now: "I'll update that now.", next: "I'll update that next." };
  }
  if (
    /\b(summarize|summary|explain)\b/.test(normalized) ||
    /\b(codebase|repo|repository|project|app)\b.*\babout\b/.test(normalized) ||
    /\babout\b.*\b(codebase|repo|repository|project|app)\b/.test(normalized)
  ) {
    return { now: "I'll summarize that now.", next: "I'll summarize that next." };
  }
  if (/\b(find|search|look up|inspect|check|review|read|compare)\b/.test(normalized)) {
    return { now: "I'll check that now.", next: "I'll check that next." };
  }
  if (/^(why|how|what|where|which)\b/.test(normalized)) {
    return { now: "I'll look into that now.", next: "I'll look into that next." };
  }
  return { now: "I'll handle that now.", next: "I'll handle that next." };
}

function isQuietModeRequest(normalized) {
  return (
    /\b(quiet mode|go quiet|be quiet|mute yourself|pause listening)\b/.test(normalized) ||
    /\b(stop|pause|disable|turn off)\b.*\b(listening|hearing|responding|replies|voice)\b/.test(normalized) ||
    /\b(don't|do not)\b.*\b(listen|hear|respond|reply)\b/.test(normalized)
  );
}

function isQuietWakeRequest(normalized) {
  const allowBareWake = process.env.LOCAL_REALTIME_OPENAI_ALLOW_BARE_WAKE === "1";
  const assistantName = /\b(codex|assistant|realtime|real time|voice)\b/;
  const backPhrase = /\b(i am back|i'm back|im back)\b/;
  return (
    (allowBareWake && /^(hey|hi|hello|ok|okay|yo)?\s*(i am back|i'm back|im back)$/.test(normalized)) ||
    (assistantName.test(normalized) &&
      /\b(i am back|i'm back|im back|start listening|resume listening|listen again)\b/.test(normalized)) ||
    (backPhrase.test(normalized) && assistantName.test(normalized)) ||
    /\b(hey|hi|hello|ok|okay|yo)\b.*\b(i am back|i'm back|im back)\b/.test(normalized) ||
    /\b(start|resume|enable|turn on)\b.*\b(listening|voice|replies|responding)\b/.test(normalized) ||
    /\b(you can listen|listen again|wake up)\b/.test(normalized)
  );
}

function quietWakePhraseDisplay() {
  return "Hey, I'm back; Codex, I'm back; start listening; or resume listening";
}

function textAfterQuietWake(text) {
  let clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";

  clean = clean.replace(
    /^(hey|hi|hello|ok|okay|yo)?[\s,]*(codex|assistant|realtime|real time|voice)?[\s,]*(i am back|i'm back|im back|start listening|resume listening|listen again|wake up)[\s,.!?-]*/i,
    "",
  );
  clean = clean.replace(
    /^(codex|assistant|realtime|real time|voice)?[\s,]*(you can listen|listen again|wake up)[\s,.!?-]*/i,
    "",
  );
  clean = clean.replace(
    /^(start|resume|enable|turn on)[\s,]*(listening|voice|replies|responding)[\s,.!?-]*/i,
    "",
  );
  return clean.trim();
}

function classifyTranscript(text, isBusy) {
  const cleanText = text.trim();
  const normalized = repairLocalTranscript(normalizeForIntent(cleanText));
  if (!normalized) return { action: "ignore" };

  if (isStopOrDismissal(normalized)) {
    return {
      action: "reply",
      reply: isBusy
        ? "Okay. I will not start another task."
        : "Okay. Tell me when you want Codex to do something.",
      speak: false,
    };
  }

  if (isSmallTalk(normalized)) {
    return {
      action: "reply",
      reply: smallTalkReply(normalized),
      speak: !isBusy,
    };
  }

  if (isConversationFollowupQuestion(normalized)) {
    return { action: "local_chat" };
  }

  if (delegationMode === "all") {
    return isBusy ? { action: "queue" } : { action: "delegate" };
  }

  if (delegationMode === "manual") {
    const manual = /^(codex|delegate|work on|please work on)\b/.test(normalized);
    if (manual) return isBusy ? { action: "queue" } : { action: "delegate" };
    if (isCasualRealtimeQuestion(normalized)) return { action: "local_chat" };
    return {
      action: "reply",
      reply: "Say what you want Codex to change, or start with Codex.",
      speak: !isBusy,
    };
  }

  if (isCasualRealtimeQuestion(normalized)) {
    return { action: "local_chat" };
  }

  if (looksLikeCodexTask(normalized)) {
    return isBusy ? { action: "queue" } : { action: "delegate" };
  }

  if (
    isBusy &&
    process.env.LOCAL_REALTIME_SIDE_QUESTIONS_DURING_HANDOFF !== "0" &&
    isSideQuestionWhileBusy(normalized)
  ) {
    return { action: "local_chat" };
  }

  if (isBusy) {
    return { action: "local_chat" };
  }

  return { action: "local_chat" };
}

function normalizeForIntent(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repairLocalTranscript(text) {
  return text
    .replace(/\bcode base\b/g, "codebase")
    .replace(/\bboard base\b/g, "codebase")
    .replace(/\bcore base\b/g, "codebase")
    .replace(/\bcoat base\b/g, "codebase")
    .replace(/\bways about\b/g, "codebase about")
    .trim();
}

function repairDelegationText(text) {
  const stripped = stripAssistantEchoFragments(text);
  const normalized = repairLocalTranscript(normalizeForIntent(stripped || text));
  if (/^codebase about$/.test(normalized)) {
    return "Summarize what this codebase is about.";
  }
  if (/\bcodebase\b.*\babout\b/.test(normalized)) {
    return "Summarize what this codebase is about.";
  }
  return stripped || text;
}

function stripAssistantEchoFragments(text) {
  return String(text || "")
    .replace(/\bhey there[,.]?\s*what'?s on your mind today[?]?\s*anything i can help you with[?]?/gi, " ")
    .replace(/\bjust here to help you with any coding\b/gi, " ")
    .replace(/\blet'?s hear to help you with any\b/gi, " ")
    .replace(/\bi can help you with information you provide\b/gi, " ")
    .replace(/\bhello there[!.]?\s*what can i do for you today[?]?/gi, " ")
    .replace(/\byep[,.]?\s*i'?m here[!.]?\s*what'?s on your mind[?]?/gi, " ")
    .replace(/\b(apps|applications)?[,\s]*could you clarify what you'?d like me to look into[?]?\s*notifications or installed applications[?]?/gi, " ")
    .replace(/\bi understand you'?re asking about notifications from x on brave browser[.]?\s*i'?m checking for that now[.]?\s*just a moment[.]?/gi, " ")
    .replace(/\byes[,.]?\s*i'?m still working on checking those notifications for you[.]?\s*it'?s taking a little longer than expected[.]?\s*i'?ll let you know as soon as i have an update[.]?/gi, " ")
    .replace(/\bmy apologies[,.]?\s*there was a bit of an echo and my last response was repeated[.]?\s*i am still checking on those notifications for you[.]?\s*one moment[.]?/gi, " ")
    .replace(/\bi'?ll let you know as soon as i have an update[.]?/gi, " ")
    .replace(/\bnotifications for you[.]?\s*one moment[.]?/gi, " ")
    .replace(/\bi'?m still waiting for the results from that check on your notifications[.]?\s*i'?ll let you know the moment i have any new information[.]?/gi, " ")
    .replace(/^(apps|applications)[,\s]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recoverUserRequestFromMixedEcho(text) {
  const stripped = stripAssistantEchoFragments(text);
  const normalized = repairLocalTranscript(normalizeForIntent(stripped));
  if (!normalized) return "";
  if (looksLikeExplicitUserRequestAfterEcho(normalized) && looksLikeCodexTask(normalized)) {
    return stripped;
  }
  return "";
}

function looksLikeExplicitUserRequestAfterEcho(text) {
  if (!text) return false;
  if (
    /^(can you|could you|please|try to|let'?s|lets|i want|we need|need to|do you|did you|why|how|what|where|which|open|check|inspect|search|find|read|review|explain|summarize|fix|add|run|test|debug|install|start|build)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(can you|could you|please|what is|what's|why is|why does|how do|how does|where is)\b/.test(
    text,
  );
}

function claimsCodexWorkStatus(text) {
  const normalized = normalizeForIntent(text);
  if (!normalized) return false;
  return /\b(codex is handling|codex is checking|i'?m checking|i am checking|checking for that|working on checking|still working|still waiting for the results|i'?ll let you know|one moment|just a moment|as soon as i have|as soon as i get|when it finishes)\b/.test(
    normalized,
  );
}

function isStopOrDismissal(text) {
  return [
    "stop",
    "codex stop",
    "codex cancel",
    "hey codex stop",
    "codex stop that",
    "stop that",
    "stop talking",
    "codex stop talking",
    "shut up",
    "shut up codex",
    "cancel",
    "never mind",
    "forget it",
    "nevermind",
    "that's all",
    "that is all",
    "all right you're done",
    "alright you're done",
    "all right you are done",
    "alright you are done",
    "you're done",
    "youre done",
    "you are done",
    "done",
    "quit",
    "exit",
  ].some((phrase) => text === phrase || text.startsWith(`${phrase} `));
}

function isExplicitQueueOrSteerRequest(text) {
  return (
    /^(queue|queued|cue|q)\b/.test(text) ||
    /^(steer|steer it|steer this|redirect|change direction|instead|actually)\b/.test(text) ||
    /\b(add this to the queue|queue this|do this next|next do|after that|after this)\b/.test(text)
  );
}

function stripQueueOrSteerRequest(text) {
  return String(text || "")
    .replace(/^\s*(queue|queued|cue|q)\s+(this|that|it|up|to|for)?\s*/i, "")
    .replace(/^\s*(steer|steer it|steer this|redirect|change direction)\s+(to|toward|into|so|and)?\s*/i, "")
    .replace(/^\s*(instead|actually)\s*/i, "")
    .replace(/^\s*(add this to the queue|queue this|do this next|next do|after that|after this)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSmallTalk(text) {
  return [
    "hi",
    "hello",
    "hej",
    "hey",
    "thanks",
    "thank you",
    "okay",
    "ok",
    "cool",
    "nice",
    "yes",
    "no",
    "about",
  ].includes(text);
}

function smallTalkReply(text) {
  if (text === "thanks" || text === "thank you") return "You are welcome.";
  if (text === "about") return "Tell me what you want to know about.";
  if (text === "yes" || text === "no" || text === "okay" || text === "ok") return "Okay.";
  return "Yes, I can hear you.";
}

function isCasualRealtimeQuestion(text) {
  return /\b(joke|funny|laugh|story|weather|time|date|who are you|how are you|what can you do|tell me about yourself|sing|poem)\b/.test(
    text,
  ) || isConversationFollowupQuestion(text);
}

function isConversationFollowupQuestion(text) {
  return (
    /\b(tell|say|read|repeat)\b.*\b(it|that|this|the answer|the result|what you said)\b.*\bagain\b/.test(
      text,
    ) ||
    /\b(tell|say|read|repeat)\b.*\bagain\b/.test(text) ||
    /\bwhat (were|was) (we|you) (talking about|discussing|saying|working on)\b/.test(text) ||
    /\bwhat did (we|you) (talk about|discuss|say)\b/.test(text) ||
    /\bcan you tell it to me again\b/.test(text)
  );
}

function isSideQuestionWhileBusy(text) {
  if (!text) return false;
  if (
    /\b(add|fix|change|update|remove|delete|create|make|implement|wire|connect|hook|run|test|debug|install|start|build|commit|push|deploy|rename|move|refactor|write|edit|patch|verify|clone|pull)\b/.test(
      text,
    )
  ) {
    return false;
  }

  return (
    /^(what|why|how|where|who|which|can you tell|tell me|explain|summarize)\b/.test(text) ||
    /\b(status|what are you doing|what you're doing|what you are doing|working on|progress|codebase|code base|repo|repository|project|app|current folder)\b/.test(
      text,
    )
  );
}

function shouldIgnoreBusyDelegationPrompt(text) {
  const normalized = repairLocalTranscript(
    normalizeForIntent(stripAssistantEchoFragments(text)),
  );
  if (!normalized) return true;
  if (isStopOrDismissal(normalized)) return false;
  if (isCasualRealtimeQuestion(normalized)) return false;
  if (isSideQuestionWhileBusy(normalized)) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (/^(up|about|it|this|that|there|here|yes|no|ok|okay|uh|um|hmm)$/.test(normalized)) {
    return true;
  }

  const clearAction =
    /\b(add|fix|change|update|remove|delete|create|make|implement|wire|connect|hook|run|test|debug|install|start|build|open|check|inspect|search|find|read|review|explain|summarize)\b/.test(
      normalized,
    );
  if (words.length <= 2 && !clearAction) return true;
  if (words.length <= 3 && !looksLikeCodexTask(normalized)) return true;
  return false;
}

function setupOnlyJokePunchline(input, output) {
  const normalizedInput = normalizeForIntent(input);
  const cleanOutput = String(output || "").trim();
  const normalizedOutput = normalizeForIntent(cleanOutput);
  if (!/\bjoke\b/.test(normalizedInput)) return "";
  if (!cleanOutput.endsWith("?")) return "";
  if (/\bscientists\b.*\btrust\b.*\batoms\b/.test(normalizedOutput)) {
    return "Because they make up everything.";
  }
  return "Because the punchline got stuck in the event loop.";
}

function looksLikeCodexTask(text) {
  if (isCasualRealtimeQuestion(text)) return false;

  if (
    /\b(codebase|repo|repository|project|app|current folder)\b.*\b(about|summary|summarize|explain)\b/.test(
      text,
    ) ||
    /\b(about|summary|summarize|explain)\b.*\b(codebase|repo|repository|project|app|current folder)\b/.test(
      text,
    )
  ) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/\b(fix|add|run|test|check|open|build)\b/.test(text)) {
    return false;
  }

  const actionPattern =
    /\b(add|fix|change|update|remove|delete|create|make|implement|wire|connect|hook|run|test|check|inspect|search|find|open|read|review|explain|summarize|debug|look|turn|enable|disable|install|start|build|commit|push|deploy|rename|move|refactor|write|edit|patch|verify|compare|clone|pull)\b/;
  if (actionPattern.test(text)) return true;

  const codeContextPattern =
    /\b(error|bug|file|code|codebase|test|build|app|repo|repository|project|folder|branch|terminal|cli|server|endpoint|api|config|toml|swift|typescript|javascript|python|rust|node|npm|package|workspace|worktree|diff|changes|realtime|real-time|hook|hooks|integration|implementation|browser|brave|chrome|website|webpage|post|x post|tweet|notification|notifications|feed)\b/;
  if (codeContextPattern.test(text)) return true;

  const askPattern = /^(can you|could you|please|try to|let's|lets|i want|we need|need to|why is|why it|why it's|why does|why doesn't|why isnt|why isn't|why did|how do|where is)\b/;
  return askPattern.test(text) && !/\b(weather|time|date)\b/.test(text);
}

function canEarlyHandoffTranscript(text) {
  const normalized = repairLocalTranscript(normalizeForIntent(stripAssistantEchoFragments(text)));
  if (!normalized) return false;
  if (
    /\b(codebase|repo|repository|file|code|app|browser|brave|chrome|website|webpage|x post|tweet|terminal|config|api|realtime|real-time)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return normalized.split(/\s+/).filter(Boolean).length >= 6 && looksLikeCodexTask(normalized);
}

async function answerLocalChat(text, isBusy = false) {
  if (chatMode === "off" || chatMode === "none") {
    return "I can chat, or you can ask Codex to work on a code change.";
  }

  if (chatMode === "openai") {
    const answer = await answerLocalChatWithOpenAI(text);
    if (answer) return answer;
  }

  return cannedLocalReply(text, isBusy);
}

async function answerLocalChatWithOpenAI(text) {
  const apiKey = await readApiKey();
  if (!apiKey) return "";

  const body = {
    model: process.env.LOCAL_REALTIME_CHAT_MODEL || "gpt-4o-mini",
    input: [
      {
        role: "system",
        content:
          "You are a short voice assistant inside Codex realtime mode. Answer casual or general questions directly. Keep replies under two short sentences. If the user asks for coding, debugging, file changes, terminal commands, or repo work, tell them to ask Codex to work on that task.",
      },
      { role: "user", content: text },
    ],
  };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      log(`[chat] local chat failed: ${response.status} ${responseText.slice(0, 200)}`);
      return "";
    }
    const json = JSON.parse(responseText);
    const answer = extractResponseText(json).trim();
    log(`[chat] ${answer || "(empty)"}`);
    return answer;
  } catch (error) {
    log(`[chat] local chat error: ${error.message}`);
    return "";
  }
}

function groqTranscriptionModel() {
  return (
    process.env.LOCAL_REALTIME_GROQ_TRANSCRIBE_MODEL ||
    process.env.LOCAL_REALTIME_GROQ_STT_MODEL ||
    "whisper-large-v3-turbo"
  );
}

function groqBaseUrl() {
  return (process.env.LOCAL_REALTIME_GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(
    /\/+$/,
    "",
  );
}

function groqTranscriptionUrl() {
  return `${groqBaseUrl()}/audio/transcriptions`;
}

function readGroqApiKey() {
  return (
    process.env.GROQ_API_KEY ||
    process.env.LOCAL_REALTIME_GROQ_API_KEY ||
    readGroqKeychainApiKey()
  ).trim();
}

function readGroqKeychainApiKey() {
  if (process.env.LOCAL_REALTIME_READ_GROQ_KEYCHAIN !== "1") return "";
  if (cachedGroqKeychainApiKey !== null) return cachedGroqKeychainApiKey;

  const service = process.env.LOCAL_REALTIME_GROQ_KEYCHAIN_SERVICE || "";
  const account = process.env.LOCAL_REALTIME_GROQ_KEYCHAIN_ACCOUNT || "";
  if (!service || !account) return "";

  const result = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    cachedGroqKeychainApiKey = "";
    return "";
  }
  cachedGroqKeychainApiKey = String(result.stdout || "").trim();
  return cachedGroqKeychainApiKey;
}

function readableOpenAIError(status, responseText) {
  let message = responseText;
  try {
    const json = JSON.parse(responseText);
    message = json?.error?.message || json?.message || responseText;
  } catch {
    // Keep the raw response text below.
  }

  if (status === 429 && /quota|billing|plan/i.test(message)) {
    return "Speech-to-text is failing because the OpenAI API key has no quota. Add billing or use a different API key, then restart realtime.";
  }

  return `Speech-to-text failed with HTTP ${status}. Check ${logPath}.`;
}

function readableGroqError(status, responseText) {
  let message = responseText;
  try {
    const json = JSON.parse(responseText);
    message = json?.error?.message || json?.message || responseText;
  } catch {
    // Keep the raw response text below.
  }

  if (status === 401 || status === 403) {
    return "Groq speech-to-text rejected the API key. Check GROQ_API_KEY, then restart realtime.";
  }
  if (status === 429) {
    return "Groq speech-to-text is rate limited or out of quota. Wait, upgrade, or use another key.";
  }

  return `Groq speech-to-text failed with HTTP ${status}: ${String(message).slice(0, 160)}`;
}

function extractResponseText(json) {
  if (typeof json.output_text === "string") return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((content) => content.text || content.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function cannedLocalReply(text, isBusy = false) {
  const normalized = repairLocalTranscript(normalizeForIntent(text));
  if (/^(hello|hi|hey|hello there|can you hear me|are you there)\b/.test(normalized)) {
    return "Yes, I can hear you.";
  }
  if (/^(okay|ok|yes|yeah|yep|no|nope)\b/.test(normalized)) {
    return "Okay.";
  }
  if (/\b(are you working|working on something|doing something|what are you doing|status|progress)\b/.test(normalized)) {
    return isBusy
      ? "Yes. Codex is working in the background. I will read the result when it finishes."
      : "No active Codex task right now. You can ask me a question, or ask Codex to work on code.";
  }
  if (/\bcodebase\b.*\babout\b/.test(normalized)) {
    return isBusy
      ? "Codex is already checking the codebase. I will read the result when it finishes."
      : "I can ask Codex to summarize the codebase.";
  }
  if (/^(what|huh|i|i-|i--|doing|typing|so this is|so this is the first step)\b/.test(normalized)) {
    if (/^what is that\b/.test(normalized) || /^what's that\b/.test(normalized)) {
      return isBusy ? "Codex is still working." : "Which thing?";
    }
    return "Say that again?";
  }
  if (/\bjoke\b/.test(normalized)) {
    return "Why did the function return early? Because it finally found its purpose.";
  }
  if (/\b(what can you do|who are you|how does this work)\b/.test(normalized)) {
    return "I am the local voice layer. I can answer simple questions, and I can hand coding tasks to Codex.";
  }
  if (/^(what|what happened)\b/.test(normalized)) {
    return "What do you mean?";
  }
  log(`[chat] no canned reply for: ${text}`);
  return "Say that again?";
}

function openAIRealtimeModel() {
  return process.env.LOCAL_REALTIME_OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
}

function openAIRealtimeVoice() {
  return (process.env.LOCAL_REALTIME_OPENAI_REALTIME_VOICE || "marin").trim();
}

function openAIRealtimeBargeInMode() {
  const mode = String(process.env.LOCAL_REALTIME_OPENAI_BARGE_IN_MODE || "safe")
    .toLowerCase()
    .trim();
  if (["safe", "speaker", "speaker-safe", "default"].includes(mode)) return "safe";
  if (["official", "server", "openai"].includes(mode)) return "official";
  if (["local", "rms"].includes(mode)) return "local";
  if (["off", "none", "disabled", "0", "false"].includes(mode)) return "off";
  return "safe";
}

function openAIRealtimeUrl() {
  const baseUrl = (process.env.LOCAL_REALTIME_OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime")
    .replace(/\/+$/, "");
  if (isXAIRealtimeUrl()) {
    return baseUrl;
  }
  const url = new URL(baseUrl);
  url.searchParams.set("model", openAIRealtimeModel());
  return url.toString();
}

function isXAIRealtimeUrl() {
  return /^wss:\/\/api\.x\.ai\/v1\/realtime\b/i.test(
    process.env.LOCAL_REALTIME_OPENAI_REALTIME_URL || "",
  );
}

function openAIRealtimeHeaders(apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (isXAIRealtimeUrl()) {
    headers["OpenAI-Beta"] = "realtime=v1";
  }
  if (process.env.OPENAI_ORG_ID) headers["OpenAI-Organization"] = process.env.OPENAI_ORG_ID;
  if (process.env.OPENAI_PROJECT_ID) headers["OpenAI-Project"] = process.env.OPENAI_PROJECT_ID;
  if (process.env.OPENAI_SAFETY_IDENTIFIER) {
    headers["OpenAI-Safety-Identifier"] = process.env.OPENAI_SAFETY_IDENTIFIER;
  }
  return headers;
}

function openAIRealtimeSessionConfig(codexSessionInstructions = "", options = {}) {
  const quiet = Boolean(options.quiet);
  const sessionContext = codexSessionContextForGemini(codexSessionInstructions);
  const instructions = [
    process.env.LOCAL_REALTIME_OPENAI_SYSTEM || defaultRealtimeBridgeInstructions(),
    sessionContext
      ? [
          "Codex resumed-session memory follows. Use it only to answer context or memory questions.",
          "Do not read this memory out loud unless the user asks.",
          sessionContext,
        ].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");

  const config = {
    type: "realtime",
    model: openAIRealtimeModel(),
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        noise_reduction: {
          type: process.env.LOCAL_REALTIME_OPENAI_NOISE_REDUCTION || "near_field",
        },
        turn_detection: {
          type: process.env.LOCAL_REALTIME_OPENAI_TURN_DETECTION || "semantic_vad",
          interrupt_response: quiet ? false : process.env.LOCAL_REALTIME_OPENAI_INTERRUPT_RESPONSE !== "0",
          create_response: !quiet,
        },
      },
      output: {
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        voice: openAIRealtimeVoice(),
      },
    },
  };

  if (process.env.LOCAL_REALTIME_OPENAI_TEMPERATURE) {
    config.temperature = Number(process.env.LOCAL_REALTIME_OPENAI_TEMPERATURE);
  }

  if (process.env.LOCAL_REALTIME_OPENAI_REALTIME_TRANSCRIBE === "1" || quiet || isXAIRealtimeUrl()) {
    config.audio.input.transcription = {
      model: process.env.LOCAL_REALTIME_OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      language: process.env.LOCAL_REALTIME_OPENAI_TRANSCRIBE_LANGUAGE || "en",
    };
  }

  if (process.env.LOCAL_REALTIME_OPENAI_REALTIME_TOOLS !== "0") {
    config.tools = [
      {
        type: "function",
        name: "wait_for_user",
        description:
          "Call this when the latest audio should not receive a spoken response, such as silence, background noise, speaker echo, a side conversation, or speech not addressed to Codex.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "set_listening_mode",
        description:
          "Switch the voice bridge between normal listening and quiet mode. Use quiet when the user asks you to stop listening, mute, pause, be quiet, or not respond.",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["quiet", "listening"],
              description: "quiet disables automatic listening and replies. listening resumes normal voice mode.",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "background_agent",
        description:
          "Hand coding, repository, terminal, file editing, app debugging, configuration, browser, or build tasks to Codex.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The exact coding or app task the user wants Codex to perform.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    ];
    config.tool_choice = "auto";
  }

  if (isXAIRealtimeUrl()) {
    return normalizeSessionConfigForXAI(config);
  }

  return config;
}

function normalizeSessionConfigForXAI(config) {
  const input = config.audio?.input || {};
  const output = config.audio?.output || {};
  const xaiConfig = {
    instructions: config.instructions,
    voice: output.voice || openAIRealtimeVoice(),
    turn_detection: {
      type: "server_vad",
      threshold: Number(process.env.LOCAL_REALTIME_XAI_VAD_THRESHOLD || 0.65),
      prefix_padding_ms: Number(process.env.LOCAL_REALTIME_XAI_PREFIX_PADDING_MS || 300),
      silence_duration_ms: Number(process.env.LOCAL_REALTIME_XAI_SILENCE_DURATION_MS || 900),
      create_response: true,
    },
  };

  if (config.tools) xaiConfig.tools = config.tools;
  if (config.tool_choice) xaiConfig.tool_choice = config.tool_choice;
  if (config.temperature != null) xaiConfig.temperature = config.temperature;
  if (input.transcription) xaiConfig.input_audio_transcription = input.transcription;
  return xaiConfig;
}

function normalizeRealtimeCompatibilityEvent(event) {
  if (event.type === "response.text.delta") {
    return { ...event, type: "response.output_text.delta" };
  }
  if (event.type === "response.text.done") {
    return { ...event, type: "response.output_text.done" };
  }
  return event;
}

function defaultRealtimeBridgeInstructions() {
  return [
    "# Role and Objective",
    "You are the realtime voice layer inside the original Codex CLI.",
    "Messages from Codex are authoritative. Present the system as one Codex assistant.",
    "",
    "# Voice Style",
    "Speak naturally, briefly, and clearly.",
    "For casual questions, answer directly in one or two short sentences.",
    "Do not read markdown symbols, XML tags, diffs, or asterisks out loud.",
    "",
    "# Listening Control",
    "If the user asks you to stop listening, mute, pause listening, go quiet, or stop responding, call set_listening_mode with mode quiet.",
    "If the user asks you to start listening again, resume listening, or says they are back after quiet mode, call set_listening_mode with mode listening.",
    "",
    "# Silence and Background Audio",
    "If the latest audio is silence, background noise, speaker echo, a side conversation, or speech not addressed to Codex, call wait_for_user.",
    "If the latest audio is only a one-word filler, acknowledgement, or false start such as \"ja\", \"yeah\", \"yep\", \"uh\", \"um\", or \"okay\", call wait_for_user.",
    "Do not respond conversationally after calling wait_for_user.",
    "Do not say \"I'm here,\" \"I didn't catch that,\" \"Take your time,\" or \"Let me know when you're ready.\"",
    "Resume normal responses only when the user clearly addresses Codex or asks for help.",
    "",
    "# Unclear Audio",
    "Only act on clear audio or text.",
    "Do not repeatedly ask the user to repeat themselves.",
    "If the latest audio is mostly unclear, silence, filler, or background noise, call wait_for_user instead of speaking.",
    "If part of the user's request is clear enough to act on, act on that clear part or call background_agent with the exact clear words.",
    "Ask for clarification only when the request is clearly addressed to Codex, important, and missing one specific detail.",
    "Do not use phrases like \"repeat clearly\", \"could you repeat that\", or \"I didn't catch that\" as a default response.",
    "Do not call tools, guess codebase details, or give a preamble when the audio is too unclear to act on.",
    "",
    "# Preambles",
    "Before calling background_agent for work that may take noticeable time, say one short preamble immediately, then call the tool.",
    "Good preambles: \"I'll check that now.\" \"I'll hand that to Codex now.\" \"I'll verify that before we change anything.\"",
    "Skip preambles for casual answers, unclear audio, quiet/listening mode commands, or tiny follow-up answers.",
    "Do not repeat the same preamble every turn.",
    "",
    "# Tools",
    "Use only the tools that are explicitly provided in this session.",
    "For coding, codebase, repo, app, terminal, debugging, install, file, realtime hook, local API, browser, computer, desktop app, website, external page, or configuration work, call background_agent with the user's exact request.",
    "If the user asks to open, check, inspect, or use their browser, computer, app, or a website, call background_agent.",
    "If the user says to do something on the side, in the background, separately, or while another task runs, still call background_agent and keep that wording in the prompt.",
    "After the preamble and background_agent call, wait for the function result before giving task details.",
    "Messages prefixed [BACKEND side task finished] are completed side-task results. Read the result briefly, then continue the main conversation.",
    "If Codex is already working and the user asks a small side question, answer briefly when you can.",
    "Do not invent codebase details.",
  ].join("\n");
}

function geminiLiveModel() {
  return (
    process.env.LOCAL_REALTIME_GEMINI_MODEL ||
    "gemini-3.1-flash-live-preview"
  );
}

function geminiVoiceName() {
  return (process.env.LOCAL_REALTIME_GEMINI_VOICE || "").trim();
}

function geminiBargeInMode() {
  const mode = String(process.env.LOCAL_REALTIME_GEMINI_BARGE_IN_MODE || "transcript")
    .toLowerCase()
    .trim();
  if (mode === "rms" || mode === "native") return mode;
  return "transcript";
}

function isGemini31LiveModel(model = geminiLiveModel()) {
  return /gemini-3\.1.*live/i.test(model);
}

function geminiAudioPlaybackMode() {
  return process.env.LOCAL_REALTIME_GEMINI_AUDIO_PLAYBACK_MODE || "buffered";
}

function geminiInputGain() {
  const gain = Number(process.env.LOCAL_REALTIME_GEMINI_INPUT_GAIN || 1);
  return Number.isFinite(gain) && gain > 0 ? gain : 1;
}

function geminiUsesLocalVadSignals() {
  return (
    process.env.LOCAL_REALTIME_GEMINI_EXPLICIT_VAD === "1" &&
    process.env.LOCAL_REALTIME_GEMINI_ENTERPRISE_AGENT === "1"
  );
}

function geminiLiveConfig(Modality, codexSessionInstructions = "") {
  const defaultSystemInstruction = [
      "You are the realtime voice layer inside the original Codex CLI.",
      "Assume the user is speaking English unless they explicitly ask to use another language.",
      "Keep spoken replies short, natural, and useful.",
      "Messages prefixed [USER] are the user's real requests. Messages prefixed [BACKEND] are Codex results and are authoritative.",
      "Do not say the word backend to the user. Present the system as one Codex assistant.",
      "For casual questions, answer directly in one or two short sentences, even while Codex is working in the background.",
      "While Codex is working in the background, answer short side questions directly when you can.",
      "For side questions about status or what is happening, keep the answer brief and do not start another tool call.",
      "If the user asks for a joke, finish the full joke in one turn. Do not stop after the setup or wait for the user to say why.",
      "If the user asks what the codebase, repo, project, current folder, or app is about, call background_agent. Do not ask what project they mean.",
      "For coding, codebase, repo, app, terminal, debugging, install, file, realtime hook, local API, browser, computer, desktop app, website, external page, or configuration work, call background_agent with the user's exact request.",
      "If the user asks you to open, check, inspect, or use their browser, computer, app, or a website, do not say you cannot access it. Codex has those tools. Call background_agent.",
      "If the user says to do something on the side, in the background, separately, or while another task runs, call background_agent and keep that wording in the prompt.",
      "After calling background_agent, do not answer the task yourself and do not ask the user for missing task details. Wait for [BACKEND] context before giving task details.",
      "If Codex is already working and the user asks a small side question, answer it briefly. Otherwise stay quiet until [BACKEND] context arrives.",
      "Do not invent codebase details. Do not read logs, diffs, markdown bullets, or asterisks out loud.",
    ].join(" ");
  const sessionContext = codexSessionContextForGemini(codexSessionInstructions);
  const systemInstruction = [
    process.env.LOCAL_REALTIME_GEMINI_SYSTEM || defaultSystemInstruction,
    sessionContext
      ? [
          "Codex resumed-session memory follows. Use it only to answer context or memory questions, like what the user was doing before.",
          "Do not read this memory out loud unless the user asks. If the memory is not enough, say you only have partial context.",
          sessionContext,
        ].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");

  const realtimeInputConfig = {
    automaticActivityDetection: {
      startOfSpeechSensitivity:
        process.env.LOCAL_REALTIME_GEMINI_START_SENSITIVITY || "START_SENSITIVITY_HIGH",
      endOfSpeechSensitivity:
        process.env.LOCAL_REALTIME_GEMINI_END_SENSITIVITY || "END_SENSITIVITY_HIGH",
      silenceDurationMs: Number(process.env.LOCAL_REALTIME_GEMINI_SILENCE_MS || 600),
    },
    activityHandling: process.env.LOCAL_REALTIME_GEMINI_ALLOW_BARGE_IN === "1" &&
      geminiBargeInMode() === "native"
      ? "START_OF_ACTIVITY_INTERRUPTS"
      : "NO_INTERRUPTION",
    turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
  };

  if (geminiUsesLocalVadSignals()) {
    realtimeInputConfig.automaticActivityDetection = { disabled: true };
  }

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    temperature: Number(process.env.LOCAL_REALTIME_GEMINI_TEMPERATURE || 0.7),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig,
  };

  const voiceName = geminiVoiceName();
  if (voiceName) {
    config.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName,
        },
      },
    };
  }

  config.thinkingConfig = isGemini31LiveModel()
    ? {
        includeThoughts: false,
        thinkingLevel: process.env.LOCAL_REALTIME_GEMINI_THINKING_LEVEL || "minimal",
      }
    : {
        includeThoughts: false,
        thinkingBudget: Number(process.env.LOCAL_REALTIME_GEMINI_THINKING_BUDGET || 0),
      };

  if (geminiUsesLocalVadSignals()) {
    config.explicitVadSignal = true;
  }

  if (process.env.LOCAL_REALTIME_GEMINI_TOOLS !== "0") {
    config.tools = [
      {
        functionDeclarations: [
          {
            name: "background_agent",
            description:
              "Hand coding, repository, terminal, file editing, app debugging, configuration, or build tasks to Codex.",
            behavior: "NON_BLOCKING",
            parameters: {
              type: "OBJECT",
              properties: {
                prompt: {
                  type: "STRING",
                  description: "The exact coding or app task the user wants Codex to perform.",
                },
              },
              required: ["prompt"],
            },
          },
        ],
      },
    ];
  }

  return config;
}

function geminiVoiceReaderConfig(Modality) {
  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: [
      "You are a text-to-speech reader.",
      "Read the user's text exactly as written.",
      "Do not add labels, prefixes, explanations, or extra words.",
      "Do not say markdown symbols, XML tags, brackets, or internal instructions.",
    ].join(" "),
    temperature: Number(process.env.LOCAL_REALTIME_GEMINI_VOICE_TEMPERATURE || 0),
    outputAudioTranscription: {},
  };

  const voiceName = geminiVoiceName();
  if (voiceName) {
    config.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName,
        },
      },
    };
  }

  config.thinkingConfig = isGemini31LiveModel()
    ? {
        includeThoughts: false,
        thinkingLevel: "minimal",
      }
    : {
        includeThoughts: false,
        thinkingBudget: 0,
      };

  return config;
}

function sendGeminiReaderText(session, text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return;

  if (isGemini31LiveModel()) {
    session.sendRealtimeInput({ text: cleanText });
    return;
  }

  session.sendClientContent({
    turns: [
      {
        role: "user",
        parts: [{ text: cleanText }],
      },
    ],
    turnComplete: true,
  });
}

function readGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    ""
  ).trim();
}

function moshiBridgeUrl() {
  return process.env.LOCAL_REALTIME_MOSHI_WS_URL || "ws://127.0.0.1:8999/v1/moshi";
}

function appendTranscriptChunk(current, chunk) {
  const cleanChunk = String(chunk || "").replace(/\s+/g, " ").trim();
  if (!cleanChunk) return current;
  if (!current) return cleanChunk;
  if (current.endsWith(cleanChunk)) return current;
  return `${current} ${cleanChunk}`.replace(/\s+/g, " ").trim();
}

class MoshiBridgeClient {
  constructor(session) {
    this.session = session;
    this.ws = null;
    this.readyPromise = null;
    this.ready = false;
    this.pendingAudio = [];
  }

  async connect() {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      const url = moshiBridgeUrl();
      log(`[moshi] connecting ${url}`);
      const ws = new WebSocket(url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error(`Moshi bridge did not become ready: ${url}`));
        try {
          ws.close();
        } catch {
          // Best effort.
        }
      }, Number(process.env.LOCAL_REALTIME_MOSHI_CONNECT_TIMEOUT_MS || 30000));

      ws.on("message", (data) => {
        this.onMessage(data.toString());
        if (this.ready) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on("open", () => {
        log("[moshi] websocket opened");
      });
      ws.on("close", () => {
        log("[moshi] websocket closed");
        this.ready = false;
        this.readyPromise = null;
        this.ws = null;
      });
      ws.on("error", (error) => {
        log(`[moshi] websocket error: ${error.message}`);
        clearTimeout(timeout);
        reject(error);
      });
    });

    await this.readyPromise;
    for (const item of this.pendingAudio.splice(0)) {
      this.sendAudio(item.chunk, item.sampleRate);
    }
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      log(`[moshi] ignored non-json message ${data.slice(0, 80)}`);
      return;
    }

    if (message.type === "ready") {
      this.ready = true;
      log(`[moshi] ready sampleRate=${message.sample_rate || "unknown"}`);
      return;
    }

    if (message.type === "audio") {
      const audio = Buffer.from(String(message.data || ""), "base64");
      this.session.onMoshiAudioOutput(audio, Number(message.sample_rate || 24000));
      return;
    }

    if (message.type === "text_delta") {
      this.session.onMoshiTextDelta(message.text || "");
      return;
    }

    if (message.type === "lag") {
      log("[moshi] lag");
    }
  }

  sendAudio(chunk, sampleRate) {
    if (!chunk.length) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingAudio.push({ chunk, sampleRate });
      this.pendingAudio = this.pendingAudio.slice(-25);
      return;
    }
    this.ws.send(
      JSON.stringify({
        type: "audio",
        sample_rate: sampleRate,
        data: chunk.toString("base64"),
      }),
    );
  }

  close() {
    this.ready = false;
    this.pendingAudio = [];
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // Best-effort close.
    }
    this.ws = null;
  }
}

class PcmStreamPlayer {
  constructor(sampleRate, onStateChange) {
    this.sampleRate = sampleRate;
    this.onStateChange = onStateChange;
    this.child = null;
  }

  write(buffer) {
    if (!buffer.length) return;
    this.start();
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(buffer);
    } catch (error) {
      log(`[pcm] write failed: ${error.message}`);
      this.stop("write-failed");
    }
  }

  start() {
    if (this.child && !this.child.killed) return;

    const command = process.env.LOCAL_REALTIME_PCM_PLAYER || "ffplay";
    const args = [
      "-v",
      "quiet",
      "-nodisp",
      "-autoexit",
      "-f",
      "s16le",
      "-ar",
      String(this.sampleRate),
      "-ac",
      "1",
      "-",
    ];
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    this.child = child;
    currentSpeechProcess = child;
    this.onStateChange?.(true);

    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        log(`[pcm] stdin error: ${error.message}`);
      }
      if (this.child === child) this.child = null;
      if (currentSpeechProcess === child) currentSpeechProcess = null;
      this.onStateChange?.(false);
    });

    child.on("error", (error) => {
      log(`[pcm] player failed: ${error.message}`);
      if (this.child === child) this.child = null;
      if (currentSpeechProcess === child) currentSpeechProcess = null;
      this.onStateChange?.(false);
    });
    child.on("close", () => {
      if (this.child === child) this.child = null;
      if (currentSpeechProcess === child) currentSpeechProcess = null;
      this.onStateChange?.(false);
    });
  }

  endTurn() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      // The player may have already closed.
    }
  }

  stop(reason) {
    if (!this.child || this.child.killed) return;
    const child = this.child;
    log(`[pcm] stop reason=${reason}`);
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort stop.
    }
    this.child = null;
    if (currentSpeechProcess === child) currentSpeechProcess = null;
    this.onStateChange?.(false);
  }
}

function textForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/[*_#>`~|[\]{}]/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " link ")
    .replace(/\s+/g, " ")
    .trim();
}

function backendSpeechSummary(text) {
  const spoken = textForSpeech(text);
  const maxChars = Number(process.env.LOCAL_REALTIME_BACKEND_SPEECH_MAX_CHARS || 0);
  if (!Number.isFinite(maxChars) || maxChars <= 0) return spoken;
  if (spoken.length <= maxChars) return spoken;
  const preview = spoken.slice(0, maxChars);
  const sentenceBreak = Math.max(
    preview.lastIndexOf(". "),
    preview.lastIndexOf("? "),
    preview.lastIndexOf("! "),
  );
  const cleanPreview = preview
    .slice(0, sentenceBreak > 160 ? sentenceBreak + 1 : maxChars)
    .replace(/[,;:\s]+$/, "")
    .trim();
  return cleanPreview;
}

function geminiContextText(text) {
  const maxChars = Number(process.env.LOCAL_REALTIME_GEMINI_CONTEXT_MAX_CHARS || 4000);
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function codexSessionContextForGemini(instructions) {
  if (process.env.LOCAL_REALTIME_GEMINI_SESSION_CONTEXT === "0") return "";
  const raw = String(instructions || "").trim();
  if (!raw) return "";

  const startupMatch = raw.match(/<startup_context>([\s\S]*?)<\/startup_context>/i);
  const source = startupMatch?.[1]?.trim() || raw;
  const maxChars = Number(process.env.LOCAL_REALTIME_GEMINI_SESSION_CONTEXT_MAX_CHARS || 7000);

  return source
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function transcriptForwardingMode() {
  return (
    process.env.LOCAL_REALTIME_TRANSCRIPT_FORWARDING ||
    process.env.LOCAL_REALTIME_TRANSCRIPT_MODE ||
    "full"
  );
}

function appendHandoffText(current, next) {
  const cleanNext = String(next || "");
  if (!cleanNext) return current;
  if (!current) return cleanNext;
  if (current.endsWith(cleanNext)) return current;
  return `${current}${cleanNext}`;
}

function isSpeechOutputActive() {
  return Boolean(currentSpeechProcess && !currentSpeechProcess.killed);
}

function isLikelyEchoOf(inputText, spokenText) {
  const input = normalizeEchoText(inputText);
  const spoken = normalizeEchoText(spokenText);
  if (input.length < 12 || spoken.length < 12) return false;
  if (spoken.includes(input)) return true;

  const inputWords = input.split(/\s+/).filter((word) => word.length > 2);
  if (inputWords.length < 3) return false;
  const matches = inputWords.filter((word) => spoken.includes(word)).length;
  return matches / inputWords.length >= 0.75;
}

function normalizeEchoText(text) {
  return normalizeForIntent(text)
    .replace(/\b(sources|source)\s+open\s+assist\b/g, "sources openassist")
    .replace(/\bweb\s+\/\s+/g, "web/")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyLocalSttHallucination(text, audio, sampleRate) {
  const normalized = normalizeForIntent(text);
  if (!normalized) return true;

  const durationMs = (audio.length / 2 / sampleRate) * 1000;
  const rms = pcm16Rms(audio);
  const minRms = Number(process.env.LOCAL_REALTIME_LOCAL_STT_MIN_RMS || 300);
  if (rms < minRms) {
    log(
      `[stt.local] ignored low-rms transcript="${text}" rms=${Math.round(rms)} minRms=${minRms} durationMs=${Math.round(durationMs)}`,
    );
    return true;
  }

  const shortNoiseHallucinations = new Set([
    "blank audio",
    "clicking",
    "clicking sound",
    "you",
    "thank you",
    "thanks",
    "thanks for watching",
    "bye",
  ]);
  const isNoise = shortNoiseHallucinations.has(normalized);
  if (isNoise) {
    log(
      `[stt.local] ignored known hallucination transcript="${text}" rms=${Math.round(rms)} durationMs=${Math.round(durationMs)}`,
    );
  }
  return isNoise;
}

function pcm16Rms(buffer) {
  if (buffer.length < 2) return 0;
  let sum = 0;
  let samples = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const value = buffer.readInt16LE(i);
    sum += value * value;
    samples += 1;
  }
  return Math.sqrt(sum / Math.max(samples, 1));
}

function applyPcm16Gain(buffer, gain) {
  if (gain === 1 || !buffer.length) return buffer;
  const amplified = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    const sample = buffer.readInt16LE(index);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    amplified.writeInt16LE(scaled, index);
  }
  if (buffer.length % 2 === 1) amplified[buffer.length - 1] = buffer[buffer.length - 1];
  return amplified;
}

function pcm16ToFloat32Resampled(buffer, sourceRate, targetRate) {
  const inputLength = Math.floor(buffer.length / 2);
  if (inputLength === 0) return new Float32Array();

  const outputLength = Math.max(1, Math.round((inputLength * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.min(inputLength - 1, Math.floor(sourceIndex));
    const rightIndex = Math.min(inputLength - 1, leftIndex + 1);
    const fraction = sourceIndex - leftIndex;
    const left = buffer.readInt16LE(leftIndex * 2);
    const right = buffer.readInt16LE(rightIndex * 2);
    output[i] = (left + (right - left) * fraction) / 32768;
  }

  return output;
}

function pcm16ToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function speak(text) {
  if (!text || speakMode === "off" || speakMode === "none") return;
  const startedAt = Date.now();
  log(`[speak] start mode=${speakMode} chars=${text.length}`);
  if (speakMode === "kokoro") {
    await speakWithKokoro(text);
    log(`[speak] done mode=${speakMode} elapsedMs=${Date.now() - startedAt}`);
    return;
  }
  if (speakMode !== "say") {
    log(`[speak] unsupported mode ${speakMode}; use say, kokoro, or off`);
    return;
  }
  await new Promise((resolve) => {
    const args = [];
    if (process.env.LOCAL_REALTIME_SAY_VOICE) {
      args.push("-v", process.env.LOCAL_REALTIME_SAY_VOICE);
    }
    if (process.env.LOCAL_REALTIME_SAY_RATE) {
      args.push("-r", process.env.LOCAL_REALTIME_SAY_RATE);
    }
    args.push(text);
    const child = spawn("say", args, { stdio: "ignore" });
    currentSpeechProcess = child;
    child.on("exit", resolve);
    child.on("error", resolve);
    child.on("close", () => {
      if (currentSpeechProcess === child) currentSpeechProcess = null;
    });
  });
  log(`[speak] done mode=${speakMode} elapsedMs=${Date.now() - startedAt}`);
}

async function speakWithKokoro(text) {
  const tts = await loadKokoro();
  const voice = process.env.LOCAL_REALTIME_KOKORO_VOICE || "af_heart";
  const cancelRevision = speechCancelRevision;
  const wavPath = `/tmp/codex-kokoro-${process.pid}-${Date.now()}.wav`;
  const audio = await tts.generate(text, { voice });
  if (speechCancelRevision !== cancelRevision) return;
  await audio.save(wavPath);
  if (speechCancelRevision !== cancelRevision) {
    unlink(wavPath).catch(() => {});
    return;
  }
  await new Promise((resolve) => {
    const child = spawn("afplay", [wavPath], { stdio: "ignore" });
    currentSpeechProcess = child;
    child.on("exit", resolve);
    child.on("error", resolve);
    child.on("close", () => {
      if (currentSpeechProcess === child) currentSpeechProcess = null;
    });
  });
  unlink(wavPath).catch(() => {});
}

function cancelCurrentSpeech(reason) {
  speechCancelRevision += 1;
  if (!currentSpeechProcess || currentSpeechProcess.killed) {
    log(`[speak] cancelled pending reason=${reason}`);
    return;
  }
  log(`[speak] cancelled reason=${reason}`);
  currentSpeechProcess.kill("SIGTERM");
}

async function loadKokoro() {
  if (!kokoroTtsPromise) {
    kokoroTtsPromise = (async () => {
      const startedAt = Date.now();
      log("[kokoro] loading Kokoro TTS. First run may download the model...");
      const { KokoroTTS } = await import("kokoro-js");
      const tts = await KokoroTTS.from_pretrained(
        process.env.LOCAL_REALTIME_KOKORO_MODEL ||
          "onnx-community/Kokoro-82M-v1.0-ONNX",
        {
          dtype: process.env.LOCAL_REALTIME_KOKORO_DTYPE || "q8",
          device: "cpu",
        },
      );
      log(`[kokoro] ready elapsedMs=${Date.now() - startedAt}`);
      return tts;
    })();
  }
  return kokoroTtsPromise;
}

function prewarmSpeech() {
  if (speakMode !== "kokoro") return;
  loadKokoro().catch((error) => {
    log(`[kokoro] prewarm failed: ${error.message}`);
  });
}

function prewarmTranscription() {
  if (sttMode !== "local" && sttMode !== "whisper") return;
  if (process.env.LOCAL_REALTIME_LOCAL_STT_PREWARM === "0") return;
  loadLocalTranscriber().catch((error) => {
    log(`[stt.local] prewarm failed: ${error.message}`);
  });
}

function localTranscriptionModel() {
  return process.env.LOCAL_REALTIME_LOCAL_STT_MODEL || "Xenova/whisper-tiny.en";
}

async function loadLocalTranscriber() {
  if (!localTranscriberPromise) {
    localTranscriberPromise = (async () => {
      const startedAt = Date.now();
      const model = localTranscriptionModel();
      log(`[stt.local] loading ${model}. First run may download the model...`);
      const { pipeline, env } = await import("@huggingface/transformers");
      if (process.env.LOCAL_REALTIME_LOCAL_STT_LOCAL_ONLY === "1") {
        env.allowRemoteModels = false;
      }
      const options = {
        device: process.env.LOCAL_REALTIME_LOCAL_STT_DEVICE || "cpu",
      };
      options.dtype = process.env.LOCAL_REALTIME_LOCAL_STT_DTYPE || "q8";
      const transcriber = await pipeline("automatic-speech-recognition", model, options);
      log(`[stt.local] ready elapsedMs=${Date.now() - startedAt}`);
      return transcriber;
    })();
  }
  return localTranscriberPromise;
}

async function hasApiKey() {
  return Boolean(await readApiKey());
}

async function readApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  const candidates = [
    process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : "",
    join(process.env.HOME || "", ".codex", "auth.json"),
  ].filter(Boolean);

  for (const path of candidates) {
    try {
      const auth = JSON.parse(await readFile(path, "utf8"));
      if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
        return auth.OPENAI_API_KEY.trim();
      }
    } catch {
      // Ignore missing or non-JSON auth files.
    }
  }
  return "";
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFile(logPath, `${line}\n`).catch(() => {});
}

// ── WebRTC signaling endpoint ─────────────────────────────────────────────
// Accepts SDP offers from Codex Desktop's native mic button and relays
// audio through the xAI Grok Voice realtime WebSocket.

import wrtc from "@roamhq/wrtc";

let currentWebRTCSession = null;

function handleWebRTCOffer(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const { sdp: offerSdp, conversation_id, model } = JSON.parse(body);
      const targetModel = model || openAIRealtimeModel();

      log(`[webrtc] accepting offer for model=${targetModel}`);

      // Create WebRTC peer connection
      const pc = new wrtc.RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // Set up data channel for events
      const dc = pc.createDataChannel("oai-events");
      dc.onmessage = (event) => {
        log(`[webrtc] data channel: ${event.data.substring(0, 100)}`);
      };

      // Connect to xAI realtime WebSocket
      const xaiKey = process.env.OPENAI_API_KEY || process.env.XAI_API_KEY || "";
      const xaiUrl = openAIRealtimeUrl();
      const xaiWs = new WebSocket(xaiUrl, {
        headers: openAIRealtimeHeaders(xaiKey),
      });

      xaiWs.on("open", () => {
        log(`[webrtc] xAI websocket opened`);
        // Send session config
        const sessionConfig = openAIRealtimeSessionConfig("", { quiet: true });
        xaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
      });

      xaiWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Forward xAI response audio to WebRTC
          if (msg.type === "response.audio.delta" && msg.delta) {
            const audioBuffer = Buffer.from(msg.delta, "base64");
            // Send via data channel to desktop
            if (dc.readyState === "open") {
              dc.send(JSON.stringify({ type: "output_audio_buffer.started", response_id: msg.response_id }));
            }
          }
        } catch (e) {
          log(`[webrtc] xai message error: ${e.message}`);
        }
      });

      xaiWs.on("error", (err) => {
        log(`[webrtc] xAI websocket error: ${err.message}`);
      });

      // Handle incoming audio from desktop mic
      pc.ontrack = (event) => {
        log(`[webrtc] received audio track from desktop`);
        // We don't forward desktop mic audio to xAI here because
        // xAI handles its own VAD/STT through the WebSocket.
        // The desktop audio goes through WebRTC → we capture it
        // and send via the xAI WebSocket.
      };

      // Set remote description (the offer from Desktop)
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });

      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      log(`[webrtc] answering with SDP type=${answer.type}`);

      // Update current session reference
      if (currentWebRTCSession) {
        try { currentWebRTCSession.pc.close(); } catch {}
        try { currentWebRTCSession.xaiWs.close(); } catch {}
      }
      currentWebRTCSession = { pc, xaiWs, dc, conversationId: conversation_id };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "answer", sdp: answer.sdp }));
    } catch (err) {
      log(`[webrtc] offer handling error: ${err.message}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// Register WebRTC route
const origOnRequest = server.listeners("request")[0];
server.removeListener("request", origOnRequest);
server.on("request", (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === "POST" && url.pathname === "/v1/realtime/webrtc-offer") {
    handleWebRTCOffer(req, res);
  } else if (url.pathname === "/health" || url.pathname === "/v1/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(localRealtimeHealth()));
  } else {
    origOnRequest(req, res);
  }
});
