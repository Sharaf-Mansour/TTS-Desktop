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
const MAX_TRANSLATION_TEXT_LENGTH = 5000;
const RPC_MAX_REQUEST_TIME_MS = 15000;
const LIBRE_TRANSLATE_TIMEOUT_MS = 5000;
const MYMEMORY_TIMEOUT_MS = 4000;
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function translateViaLibre(text, sourceLang, targetLang) {
  const source = !sourceLang || sourceLang === "auto" ? "auto" : sourceLang;
  const url = "https://libretranslate.de/translate";

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: text,
          source,
          target: targetLang,
          format: "text",
        }),
      },
      LIBRE_TRANSLATE_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_FAILED,
        `LibreTranslate returned HTTP ${response.status}.`,
      );
    }

    const payload = await response.json();
    const translatedText =
      typeof payload?.translatedText === "string"
        ? payload.translatedText
        : "";

    if (!translatedText) {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_FAILED,
        "LibreTranslate returned no text.",
      );
    }

    return {
      translatedText,
      detectedSourceLang:
        payload?.detectedLanguage?.language ||
        (source === "auto" ? "auto" : source),
      provider: "libretranslate",
    };
  } catch (error) {
    throw (
      error?.name === "AbortError"
        ? createTtsError(
            TTS_ERROR_CODES.TRANSLATION_FAILED,
            "LibreTranslate timed out.",
          )
        : error
    );
  }
}

async function translateViaMyMemory(text, sourceLang, targetLang) {
  const source =
    !sourceLang || sourceLang === "auto" ? "autodetect" : sourceLang;
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(source)}|${encodeURIComponent(targetLang)}`;

  const response = await fetchWithTimeout(url, {}, MYMEMORY_TIMEOUT_MS);

  if (!response.ok) {
    throw createTtsError(
      TTS_ERROR_CODES.TRANSLATION_FAILED,
      `Translation fallback returned HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  const translatedText =
    typeof payload?.responseData?.translatedText === "string"
      ? payload.responseData.translatedText
      : "";

  if (!translatedText) {
    throw createTtsError(
      TTS_ERROR_CODES.TRANSLATION_FAILED,
      "Translation fallback returned no text.",
    );
  }

  return {
    translatedText,
    detectedSourceLang: source === "autodetect" ? "auto" : source,
    provider: "mymemory",
  };
}

const rpc = BrowserView.defineRPC({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
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

      async translateText({ text, sourceLang, targetLang } = {}) {
        return withRpcErrorHandling(async () => {
          const normalizedText = typeof text === "string" ? text.trim() : "";
          const normalizedTarget =
            typeof targetLang === "string" ? targetLang.trim() : "";
          const normalizedSource =
            typeof sourceLang === "string" && sourceLang.trim()
              ? sourceLang.trim()
              : "auto";

          if (!normalizedText) {
            throw createTtsError(
              TTS_ERROR_CODES.TRANSLATION_TEXT_REQUIRED,
              "Text to translate is required.",
            );
          }

          if (!normalizedTarget) {
            throw createTtsError(
              TTS_ERROR_CODES.TRANSLATION_LANG_REQUIRED,
              "Target language is required.",
            );
          }

          if (normalizedText.length > MAX_TRANSLATION_TEXT_LENGTH) {
            throw createTtsError(
              TTS_ERROR_CODES.TRANSLATION_TEXT_TOO_LONG,
              `Text is too long. Limit each translation to ${MAX_TRANSLATION_TEXT_LENGTH} characters.`,
              { maxLength: MAX_TRANSLATION_TEXT_LENGTH },
            );
          }

          try {
            return await translateViaLibre(
              normalizedText,
              normalizedSource,
              normalizedTarget,
            );
          } catch (libreError) {
            try {
              return await translateViaMyMemory(
                normalizedText,
                normalizedSource,
                normalizedTarget,
              );
            } catch {
              throw libreError;
            }
          }
        }, TTS_ERROR_CODES.TRANSLATION_FAILED);
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
