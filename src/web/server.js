import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  TTS_ERROR_CODES,
  createTtsError,
  normalizeTtsError,
} from "../shared/tts-errors.js";
import {
  buildDownloadFilename,
  MAX_SYNTHESIS_TEXT_LENGTH,
} from "../shared/tts-shared.js";
import {
  chooseHostedVoiceForRequest,
  getHostedVoices,
  synthesizeSpeech,
} from "../bun/tts-service.js";

const rootDir = resolve(import.meta.dir, "..");
const webDir = resolve(import.meta.dir);
const port = Number(process.env.PORT || 8003);
const helperScriptPath = resolve(rootDir, "bun", "edge-tts-helper.mjs");
const webEntryPath = resolve(rootDir, "views", "mainview", "index.web.html");
const logoPath = resolve(rootDir, "logo.png");
const manifestPath = resolve(webDir, "manifest.webmanifest");
const serviceWorkerPath = resolve(webDir, "service-worker.js");
const LIBRE_TRANSLATE_TIMEOUT_MS = 5000;
const MYMEMORY_TIMEOUT_MS = 4000;
const activeSyntheses = new Map();

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

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

function statusForErrorCode(code) {
  switch (code) {
    case TTS_ERROR_CODES.TEXT_REQUIRED:
    case TTS_ERROR_CODES.REQUEST_ID_REQUIRED:
    case TTS_ERROR_CODES.TEXT_TOO_LONG:
    case TTS_ERROR_CODES.TRANSLATION_TEXT_REQUIRED:
    case TTS_ERROR_CODES.TRANSLATION_TEXT_TOO_LONG:
    case TTS_ERROR_CODES.TRANSLATION_LANG_REQUIRED:
      return 400;
    case TTS_ERROR_CODES.VOICE_NOT_FOUND:
      return 404;
    case TTS_ERROR_CODES.SYNTHESIS_CANCELED:
      return 409;
    case TTS_ERROR_CODES.SYNTHESIS_TIMEOUT:
      return 408;
    default:
      return 500;
  }
}

function errorResponse(error, fallbackCode = TTS_ERROR_CODES.UNEXPECTED) {
  const normalized = normalizeTtsError(error, fallbackCode);
  return jsonResponse(
    {
      __ttsDesktopError: true,
      ...normalized,
    },
    statusForErrorCode(normalized.code),
  );
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    throw createTtsError(
      TTS_ERROR_CODES.UNEXPECTED,
      "Request body must be valid JSON.",
    );
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
  const response = await fetchWithTimeout(
    "https://libretranslate.de/translate",
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
  ).catch((error) => {
    if (error?.name === "AbortError") {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_FAILED,
        "LibreTranslate timed out.",
      );
    }

    throw error;
  });

  if (!response.ok) {
    throw createTtsError(
      TTS_ERROR_CODES.TRANSLATION_FAILED,
      `LibreTranslate returned HTTP ${response.status}.`,
    );
  }

  const payload = await response.json();
  const translatedText =
    typeof payload?.translatedText === "string" ? payload.translatedText : "";

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

async function handleRuntimeStatusRequest() {
  return jsonResponse({
    hasNode: Boolean(Bun.which("node")),
    maxSynthesisTextLength: MAX_SYNTHESIS_TEXT_LENGTH,
  });
}

async function handleVoicesRequest(url) {
  try {
    const voices = await getHostedVoices(
      url.searchParams.get("forceRefresh") === "1",
    );
    return jsonResponse({ voices });
  } catch (error) {
    return errorResponse(error, TTS_ERROR_CODES.VOICES_UNAVAILABLE);
  }
}

async function handleCancelSynthesisRequest(request) {
  try {
    const body = await readJsonBody(request);
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";

    if (!requestId) {
      throw createTtsError(
        TTS_ERROR_CODES.REQUEST_ID_REQUIRED,
        "A synthesis request ID is required.",
      );
    }

    const activeSynthesis = activeSyntheses.get(requestId);
    if (!activeSynthesis) {
      return jsonResponse({ canceled: false });
    }

    activeSynthesis.wasCanceled = true;
    activeSynthesis.proc?.kill();
    return jsonResponse({ canceled: true });
  } catch (error) {
    return errorResponse(error, TTS_ERROR_CODES.UNEXPECTED);
  }
}

async function handleSynthesizeRequest(request) {
  try {
    const body = await readJsonBody(request);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const requestId = typeof body?.requestId === "string" ? body.requestId : "";

    if (!text) {
      throw createTtsError(TTS_ERROR_CODES.TEXT_REQUIRED, "Text is required.");
    }

    if (!requestId) {
      throw createTtsError(
        TTS_ERROR_CODES.REQUEST_ID_REQUIRED,
        "A synthesis request ID is required.",
      );
    }

    if (text.length > MAX_SYNTHESIS_TEXT_LENGTH) {
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
      normalizeRequestedVoice(body?.requestedVoice),
    );

    if (!selectedVoice) {
      throw createTtsError(
        TTS_ERROR_CODES.VOICE_NOT_FOUND,
        "No suitable hosted voice was found.",
      );
    }

    const synthesisState = { proc: null, wasCanceled: false };
    activeSyntheses.set(requestId, synthesisState);

    try {
      const audioBuffer = await synthesizeSpeech(
        text,
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

      return new Response(audioBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-TTS-Voice-Name": encodeURIComponent(selectedVoice.friendlyName),
          "X-TTS-Voice-Culture": encodeURIComponent(selectedVoice.locale),
          "X-TTS-Filename": encodeURIComponent(
            buildDownloadFilename(text, "mp3"),
          ),
        },
      });
    } finally {
      activeSyntheses.delete(requestId);
    }
  } catch (error) {
    return errorResponse(error, TTS_ERROR_CODES.SYNTHESIS_FAILED);
  }
}

async function handleTranslateRequest(request) {
  try {
    const body = await readJsonBody(request);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const targetLang =
      typeof body?.targetLang === "string" ? body.targetLang.trim() : "";
    const sourceLang =
      typeof body?.sourceLang === "string" && body.sourceLang.trim()
        ? body.sourceLang.trim()
        : "auto";

    if (!text) {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_TEXT_REQUIRED,
        "Text to translate is required.",
      );
    }

    if (!targetLang) {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_LANG_REQUIRED,
        "Target language is required.",
      );
    }

    if (text.length > 5000) {
      throw createTtsError(
        TTS_ERROR_CODES.TRANSLATION_TEXT_TOO_LONG,
        "Text is too long. Limit each translation to 5000 characters.",
        { maxLength: 5000 },
      );
    }

    try {
      return jsonResponse(
        await translateViaLibre(text, sourceLang, targetLang),
      );
    } catch (libreError) {
      try {
        return jsonResponse(
          await translateViaMyMemory(text, sourceLang, targetLang),
        );
      } catch {
        throw libreError;
      }
    }
  } catch (error) {
    return errorResponse(error, TTS_ERROR_CODES.TRANSLATION_FAILED);
  }
}

function resolveStaticFile(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return webEntryPath;
  }

  if (pathname === "/manifest.webmanifest") {
    return manifestPath;
  }

  if (pathname === "/service-worker.js") {
    return serviceWorkerPath;
  }

  if (
    pathname === "/views/mainview/logo.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/icons/icon-192.png" ||
    pathname === "/icons/icon-512.png" ||
    pathname === "/icons/icon-maskable-512.png"
  ) {
    return logoPath;
  }

  const filePath = resolve(rootDir, `.${pathname}`);
  const relativePath = relative(rootDir, filePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return filePath;
}

async function handleStaticRequest(url) {
  const pathname = decodeURIComponent(url.pathname);
  const filePath = resolveStaticFile(pathname);

  if (!filePath) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }

  const overrideType =
    pathname === "/favicon.ico" ||
    pathname === "/icons/icon-192.png" ||
    pathname === "/icons/icon-512.png" ||
    pathname === "/icons/icon-maskable-512.png"
      ? "image/png"
      : null;

  const contentType =
    overrideType || contentTypes[extname(filePath)] || file.type;
  const headers = new Headers();
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  if (pathname === "/service-worker.js") {
    headers.set("Service-Worker-Allowed", "/");
    headers.set("Cache-Control", "no-cache");
  } else if (pathname === "/manifest.webmanifest") {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(file, { headers });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/runtime") {
      return handleRuntimeStatusRequest();
    }

    if (url.pathname === "/api/voices") {
      return handleVoicesRequest(url);
    }

    if (url.pathname === "/api/cancel-synthesis" && request.method === "POST") {
      return handleCancelSynthesisRequest(request);
    }

    if (url.pathname === "/api/synthesize" && request.method === "POST") {
      return handleSynthesizeRequest(request);
    }

    if (url.pathname === "/api/translate" && request.method === "POST") {
      return handleTranslateRequest(request);
    }

    return handleStaticRequest(url);
  },
});

console.log(`TTS Studio web server running at ${server.url}`);
