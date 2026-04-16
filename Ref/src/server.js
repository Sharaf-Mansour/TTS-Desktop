import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { getVoices } from "edge-tts";

const rootDir = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT || 8003);
const helperScriptPath = resolve(import.meta.dir, "edge-tts-helper.mjs");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

let voiceCache = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getHostedVoices(forceRefresh = false) {
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

function chooseHostedVoiceForRequest(voices, requestedVoice) {
  if (!voices.length) {
    return null;
  }

  if (!requestedVoice) {
    return (
      voices.find((voice) => voice.shortName === "en-US-AriaNeural") ||
      voices.find(
        (voice) => voice.locale === "en-US" && voice.gender === "Female",
      ) ||
      voices[0]
    );
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
    voices.find(
      (voice) => voice.locale === "en-US" && voice.gender === "Female",
    ) ||
    voices.find((voice) => voice.locale === "en-US") ||
    voices[0]
  );
}

function slugifyText(text) {
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (
    slug.split("-").filter(Boolean).slice(0, 10).join("-").slice(0, 64) ||
    "speech"
  );
}

function buildTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  return (
    [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("") +
    "-" +
    [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("")
  );
}

function buildDownloadFilename(text, extension) {
  return `${slugifyText(text)}-${buildTimestamp()}.${extension}`;
}

async function synthesizeSpeech(text, voiceName) {
  const outputPath = join(tmpdir(), `tts-studio-${randomUUID()}.mp3`);
  const requestPath = join(tmpdir(), `tts-studio-${randomUUID()}.json`);

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
      cmd: ["node", helperScriptPath, requestPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        stderr.trim() || stdout.trim() || "node-edge-tts synthesis failed",
      );
    }

    const file = Bun.file(outputPath);
    return await file.arrayBuffer();
  } finally {
    await rm(requestPath, { force: true }).catch(() => undefined);
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

async function handleVoicesRequest() {
  try {
    const voices = await getHostedVoices();
    return jsonResponse({ voices });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to enumerate voices";
    return jsonResponse({ error: message }, 500);
  }
}

async function handleSynthesizeRequest(request) {
  try {
    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const requestedVoice =
      typeof body?.requestedVoice === "object" && body.requestedVoice
        ? {
            name:
              typeof body.requestedVoice.name === "string"
                ? body.requestedVoice.name
                : "",
            lang:
              typeof body.requestedVoice.lang === "string"
                ? body.requestedVoice.lang
                : "",
            voiceURI:
              typeof body.requestedVoice.voiceURI === "string"
                ? body.requestedVoice.voiceURI
                : "",
            default: Boolean(body.requestedVoice.default),
            localService: Boolean(body.requestedVoice.localService),
          }
        : undefined;

    if (!text) {
      return jsonResponse({ error: "Text is required." }, 400);
    }

    const voices = await getHostedVoices();
    if (voices.length === 0) {
      return jsonResponse({ error: "No hosted voices are available." }, 500);
    }

    const selectedVoice = chooseHostedVoiceForRequest(voices, requestedVoice);
    if (!selectedVoice) {
      return jsonResponse(
        { error: "No suitable hosted voice was found." },
        500,
      );
    }

    const audioBuffer = await synthesizeSpeech(text, selectedVoice.shortName);
    const headers = new Headers({
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "X-TTS-Voice-Name": encodeURIComponent(selectedVoice.friendlyName),
      "X-TTS-Voice-Culture": encodeURIComponent(selectedVoice.locale),
      "X-TTS-Filename": encodeURIComponent(buildDownloadFilename(text, "mp3")),
    });

    return new Response(audioBuffer, { headers });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "server-side synthesis failed";
    return jsonResponse({ error: message }, 500);
  }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/voices") {
      return handleVoicesRequest();
    }

    if (url.pathname === "/api/synthesize" && request.method === "POST") {
      return handleSynthesizeRequest(request);
    }

    const pathname =
      url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = resolve(rootDir, `.${pathname}`);

    if (!filePath.startsWith(rootDir)) {
      return new Response("Forbidden", { status: 403 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }

    const headers = new Headers();
    const contentType = contentTypes[extname(filePath)] || file.type;
    if (contentType) {
      headers.set("Content-Type", contentType);
    }

    return new Response(file, { headers });
  },
});

console.log(`TTS Studio running at ${server.url}`);
