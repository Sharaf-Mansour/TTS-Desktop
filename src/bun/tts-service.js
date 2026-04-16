import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVoices } from "edge-tts";
import { TTS_ERROR_CODES, createTtsError } from "../shared/tts-errors.js";
import {
  MAX_SYNTHESIS_TEXT_LENGTH,
  getPreferredVoice,
} from "../shared/tts-shared.js";

let voiceCache = null;

const SYNTHESIS_TIMEOUT_MS = 30000;

export async function getHostedVoices(forceRefresh = false) {
  if (!forceRefresh && voiceCache) {
    return voiceCache;
  }

  const hostedVoices = await getVoices();
  voiceCache = hostedVoices.map((voice) => ({
    shortName: voice.ShortName,
    name: voice.Name,
    friendlyName: voice.FriendlyName,
    locale: voice.Locale,
    gender: voice.Gender,
    suggestedCodec: voice.SuggestedCodec,
    status: voice.Status,
  }));

  return voiceCache;
}

function normalizeVoiceName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(microsoft|desktop|online|natural|neural|voice|english|united|states)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function inferRequestedGender(requestedName) {
  const normalizedRequested = normalizeVoiceName(requestedName);

  if (!normalizedRequested) {
    return null;
  }

  const femaleTokens = new Set([
    "amala",
    "ana",
    "amber",
    "aria",
    "ashley",
    "ava",
    "bella",
    "christine",
    "cora",
    "elizabeth",
    "emma",
    "jane",
    "jenny",
    "libby",
    "michelle",
    "monica",
    "nancy",
    "sara",
    "sonia",
  ]);

  const maleTokens = new Set([
    "andrew",
    "brian",
    "christopher",
    "davis",
    "eric",
    "guy",
    "jacob",
    "jason",
    "kevin",
    "matthew",
    "roger",
    "ryan",
    "steffan",
    "tony",
  ]);

  for (const token of normalizedRequested.split(" ")) {
    if (femaleTokens.has(token)) {
      return "female";
    }

    if (maleTokens.has(token)) {
      return "male";
    }
  }

  return null;
}

function extractRequestedFriendlyCore(requestedVoice) {
  const rawName = String(requestedVoice?.name || "").trim();

  if (!rawName) {
    return "";
  }

  return rawName
    .replace(/^Microsoft\s+/i, "")
    .replace(/\s+Online\s*\(Natural\).*$/i, "")
    .replace(/\s+Online.*$/i, "")
    .trim();
}

function buildHostedShortNameCandidates(requestedVoice) {
  const locale = String(requestedVoice?.lang || "").trim();
  const coreName = extractRequestedFriendlyCore(requestedVoice);
  const condensedCore = coreName.replace(/\s+/g, "");

  if (!locale || !condensedCore) {
    return [];
  }

  const candidates = new Set([
    `${locale}-${condensedCore}`,
    `${locale}-${condensedCore}Neural`,
  ]);

  return [...candidates];
}

export function chooseHostedVoiceForRequest(voices, requestedVoice) {
  if (!voices.length) {
    return null;
  }

  if (!requestedVoice) {
    return getPreferredVoice(voices);
  }

  const requestedName = String(requestedVoice.name || "")
    .trim()
    .toLowerCase();
  const requestedVoiceUri = String(requestedVoice.voiceURI || "")
    .trim()
    .toLowerCase();
  const requestedLocale = String(requestedVoice.lang || "")
    .trim()
    .toLowerCase();
  const normalizedRequested = normalizeVoiceName(requestedVoice.name || "");
  const requestedGender = inferRequestedGender(requestedVoice.name || "");

  const exactFriendlyMatch = voices.find(
    (voice) => voice.friendlyName.toLowerCase() === requestedName,
  );
  if (exactFriendlyMatch) {
    return exactFriendlyMatch;
  }

  const shortNameCandidates = buildHostedShortNameCandidates(requestedVoice);
  const shortNameMatch = voices.find((voice) =>
    shortNameCandidates.some(
      (candidate) => voice.shortName.toLowerCase() === candidate.toLowerCase(),
    ),
  );
  if (shortNameMatch) {
    return shortNameMatch;
  }

  const uriMatch = voices.find(
    (voice) =>
      voice.shortName.toLowerCase() === requestedVoiceUri ||
      voice.friendlyName.toLowerCase() === requestedVoiceUri,
  );
  if (uriMatch) {
    return uriMatch;
  }

  let bestScore = -1;
  let bestVoice = null;

  for (const voice of voices) {
    let score = 0;
    const normalizedFriendly = normalizeVoiceName(voice.friendlyName);

    if (requestedLocale && voice.locale.toLowerCase() === requestedLocale) {
      score += 60;
    }

    if (requestedGender && voice.gender.toLowerCase() === requestedGender) {
      score += 20;
    }

    if (normalizedRequested && normalizedRequested === normalizedFriendly) {
      score += 80;
    }

    const requestedTokens = normalizedRequested.split(" ").filter(Boolean);
    const candidateTokens = new Set(
      normalizedFriendly.split(" ").filter(Boolean),
    );
    for (const token of requestedTokens) {
      if (candidateTokens.has(token)) {
        score += 14;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestVoice = voice;
    }
  }

  if (bestVoice && bestScore > 0) {
    return bestVoice;
  }

  return (
    voices.find(
      (voice) =>
        requestedLocale && voice.locale.toLowerCase() === requestedLocale,
    ) ||
    getPreferredVoice(voices)
  );
}

export async function synthesizeSpeech(
  text,
  voiceName,
  helperScriptPath,
  options = {},
) {
  const outputPath = join(tmpdir(), `tts-studio-${randomUUID()}.mp3`);
  const requestPath = join(tmpdir(), `tts-studio-${randomUUID()}.json`);
  const nodeExecutable = Bun.which("node");
  const onProcessCreated =
    typeof options.onProcessCreated === "function"
      ? options.onProcessCreated
      : null;
  const isCanceled =
    typeof options.isCanceled === "function" ? options.isCanceled : () => false;

  if (!nodeExecutable) {
    throw createTtsError(
      TTS_ERROR_CODES.NODE_MISSING,
      "Node.js was not found on this system. Install Node.js and ensure 'node' is available on PATH before generating speech.",
    );
  }

  try {
    await writeFile(
      requestPath,
      JSON.stringify({
        text,
        voice: voiceName,
        outputPath,
        lang: String(voiceName).split("-").slice(0, 2).join("-"),
      }),
      "utf8",
    );

    const proc = Bun.spawn({
      cmd: [nodeExecutable, helperScriptPath, requestPath],
      stdout: "pipe",
      stderr: "pipe",
    });
    onProcessCreated?.(proc);

    let didTimeout = false;
    const timeoutHandle = setTimeout(() => {
      didTimeout = true;
      proc.kill();
    }, SYNTHESIS_TIMEOUT_MS);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => {
      clearTimeout(timeoutHandle);
    });

    if (didTimeout) {
      throw createTtsError(
        TTS_ERROR_CODES.SYNTHESIS_TIMEOUT,
        `Speech generation timed out after ${Math.round(SYNTHESIS_TIMEOUT_MS / 1000)} seconds. Shorten the text and try again.`,
      );
    }

    if (isCanceled()) {
      throw createTtsError(
        TTS_ERROR_CODES.SYNTHESIS_CANCELED,
        "Speech generation was canceled.",
      );
    }

    if (exitCode !== 0) {
      if (isCanceled()) {
        throw createTtsError(
          TTS_ERROR_CODES.SYNTHESIS_CANCELED,
          "Speech generation was canceled.",
        );
      }

      throw createTtsError(
        TTS_ERROR_CODES.SYNTHESIS_FAILED,
        stderr.trim() || stdout.trim() || "node-edge-tts synthesis failed",
      );
    }

    const file = Bun.file(outputPath);
    if (!(await file.exists())) {
      throw createTtsError(
        TTS_ERROR_CODES.SYNTHESIS_OUTPUT_MISSING,
        "Speech generation finished without producing an audio file.",
      );
    }

    return await file.arrayBuffer();
  } finally {
    await rm(requestPath, { force: true }).catch(() => undefined);
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}
