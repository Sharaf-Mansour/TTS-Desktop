import { join } from "node:path";
import { BrowserView, BrowserWindow, PATHS, Utils } from "electrobun/bun";
import {
  buildDownloadFilename,
  chooseHostedVoiceForRequest,
  getHostedVoices,
  synthesizeSpeech,
} from "./tts-service.js";

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

const rpc = BrowserView.defineRPC({
  handlers: {
    requests: {
      async getVoices({ forceRefresh = false } = {}) {
        const voices = await getHostedVoices(forceRefresh);
        return { voices };
      },

      async synthesizeSpeech({ text, requestedVoice } = {}) {
        const normalizedText = typeof text === "string" ? text.trim() : "";

        if (!normalizedText) {
          throw new Error("Text is required.");
        }

        const voices = await getHostedVoices();
        if (voices.length === 0) {
          throw new Error("No hosted voices are available.");
        }

        const selectedVoice = chooseHostedVoiceForRequest(
          voices,
          normalizeRequestedVoice(requestedVoice),
        );

        if (!selectedVoice) {
          throw new Error("No suitable hosted voice was found.");
        }

        const audioBuffer = await synthesizeSpeech(
          normalizedText,
          selectedVoice.shortName,
          helperScriptPath,
        );

        return {
          audioBase64: Buffer.from(audioBuffer).toString("base64"),
          mimeType: "audio/mpeg",
          usedVoiceName: selectedVoice.friendlyName,
          usedVoiceCulture: selectedVoice.locale,
          suggestedFilename: buildDownloadFilename(normalizedText, "mp3"),
        };
      },

      async saveGeneratedAudio({ audioBase64, filename } = {}) {
        if (typeof audioBase64 !== "string" || !audioBase64) {
          throw new Error("Audio data is required.");
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
        await Bun.write(filePath, Buffer.from(audioBase64, "base64"));

        return {
          canceled: false,
          saved: true,
          path: filePath,
        };
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
