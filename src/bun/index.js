import { join } from "node:path";
import { BrowserView, BrowserWindow, PATHS, Utils } from "electrobun/bun";
import {
  TTS_ERROR_CODES,
  createTtsError,
  serializeTtsError,
} from "../shared/tts-errors.js";
import {
  chooseHostedVoiceForRequest,
  getHostedVoices,
  synthesizeSpeech,
} from "./tts-service.js";
import {
  MAX_SYNTHESIS_TEXT_LENGTH,
  buildDownloadFilename,
} from "../shared/tts-shared.js";

const MAX_SAVED_AUDIO_BYTES = 50 * 1024 * 1024;
const activeSyntheses = new Map();

const helperScriptPath = join(
  PATHS.VIEWS_FOLDER,
  "assets",
  "edge-tts-helper.mjs",
);

function normalizeRequestedVoice(requestedVoice) {
  return typeof requestedVoice === "object" && requestedVoice
    ? {
        name:
          typeof requestedVoice.name === "string" ? requestedVoice.name : "",
        lang:
          typeof requestedVoice.lang === "string" ? requestedVoice.lang : "",
        voiceURI:
          typeof requestedVoice.voiceURI === "string"
            ? requestedVoice.voiceURI
            : "",
        default: Boolean(requestedVoice.default),
        localService: Boolean(requestedVoice.localService),
      }
    : undefined;
}

function sanitizeFilename(filename) {
  const normalized = String(filename || "speech.mp3").trim() || "speech.mp3";
  const safeName = normalized.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim();
  return safeName || "speech.mp3";
}

async function withRpcErrorHandling(action, fallbackCode) {
  try {
    return await action();
  } catch (error) {
    throw new Error(serializeTtsError(error, fallbackCode));
  }
}

const rpc = BrowserView.defineRPC({
  handlers: {
    requests: {
      async getRuntimeStatus() {
        return {
          hasNode: Boolean(Bun.which("node")),
          maxSynthesisTextLength: MAX_SYNTHESIS_TEXT_LENGTH,
        };
      },

      async cancelSynthesis({ requestId } = {}) {
        return withRpcErrorHandling(async () => {
          if (typeof requestId !== "string" || !requestId) {
            return { canceled: false };
          }

          const activeSynthesis = activeSyntheses.get(requestId);
          if (!activeSynthesis) {
            return { canceled: false };
          }

          activeSynthesis.wasCanceled = true;
          activeSynthesis.proc?.kill();
          return { canceled: true };
        }, TTS_ERROR_CODES.UNEXPECTED);
      },

      async getVoices({ forceRefresh = false } = {}) {
        return withRpcErrorHandling(async () => {
          const voices = await getHostedVoices(forceRefresh);
          return { voices };
        }, TTS_ERROR_CODES.VOICES_UNAVAILABLE);
      },

      async synthesizeSpeech({ text, requestedVoice, requestId } = {}) {
        return withRpcErrorHandling(async () => {
          const normalizedText = typeof text === "string" ? text.trim() : "";

          if (!normalizedText) {
            throw createTtsError(
              TTS_ERROR_CODES.TEXT_REQUIRED,
              "Text is required.",
            );
          }

          if (typeof requestId !== "string" || !requestId) {
            throw createTtsError(
              TTS_ERROR_CODES.REQUEST_ID_REQUIRED,
              "A synthesis request ID is required.",
            );
          }

          if (normalizedText.length > MAX_SYNTHESIS_TEXT_LENGTH) {
            throw createTtsError(
              TTS_ERROR_CODES.TEXT_TOO_LONG,
              `Text is too long. Limit each request to ${MAX_SYNTHESIS_TEXT_LENGTH} characters.`,
              { maxLength: MAX_SYNTHESIS_TEXT_LENGTH },
            );
          }

          const voices = await getHostedVoices();
          if (voices.length === 0) {
            throw createTtsError(
              TTS_ERROR_CODES.VOICES_UNAVAILABLE,
              "No hosted voices are available.",
            );
          }

          const selectedVoice = chooseHostedVoiceForRequest(
            voices,
            normalizeRequestedVoice(requestedVoice),
          );

          if (!selectedVoice) {
            throw createTtsError(
              TTS_ERROR_CODES.VOICE_NOT_FOUND,
              "No suitable hosted voice was found.",
            );
          }

          const synthesisState = {
            proc: null,
            wasCanceled: false,
          };
          activeSyntheses.set(requestId, synthesisState);

          try {
            const audioBuffer = await synthesizeSpeech(
              normalizedText,
              selectedVoice.shortName,
              helperScriptPath,
              {
                onProcessCreated(proc) {
                  synthesisState.proc = proc;
                },
                isCanceled() {
                  return synthesisState.wasCanceled;
                },
              },
            );

            return {
              audioBase64: Buffer.from(audioBuffer).toString("base64"),
              mimeType: "audio/mpeg",
              usedVoiceName: selectedVoice.friendlyName,
              usedVoiceCulture: selectedVoice.locale,
              suggestedFilename: buildDownloadFilename(normalizedText, "mp3"),
            };
          } finally {
            activeSyntheses.delete(requestId);
          }
        }, TTS_ERROR_CODES.SYNTHESIS_FAILED);
      },

      async saveGeneratedAudio({ audioBase64, filename } = {}) {
        return withRpcErrorHandling(async () => {
          if (typeof audioBase64 !== "string" || !audioBase64) {
            throw createTtsError(
              TTS_ERROR_CODES.AUDIO_REQUIRED,
              "Audio data is required.",
            );
          }

          const audioBuffer = Buffer.from(audioBase64, "base64");
          if (audioBuffer.length > MAX_SAVED_AUDIO_BYTES) {
            throw createTtsError(
              TTS_ERROR_CODES.AUDIO_TOO_LARGE,
              `Audio file is too large to save. Limit is ${Math.round(MAX_SAVED_AUDIO_BYTES / (1024 * 1024))} MB.`,
              { maxBytes: MAX_SAVED_AUDIO_BYTES },
            );
          }

          const selectedPaths = await Utils.openFileDialog({
            startingFolder: Utils.paths.downloads,
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });

          const targetDirectory = selectedPaths?.[0];
          if (!targetDirectory) {
            return { canceled: true, saved: false };
          }

          const filePath = join(targetDirectory, sanitizeFilename(filename));
          await Bun.write(filePath, audioBuffer);

          return {
            canceled: false,
            saved: true,
            path: filePath,
          };
        }, TTS_ERROR_CODES.SAVE_FAILED);
      },
    },
    messages: {},
  },
});

const win = new BrowserWindow({
  title: "TTS Studio",
  url: "views://mainview/index.html",
  rpc,
  frame: {
    x: 120,
    y: 80,
    width: 960,
    height: 920,
  },
});

win.show();
