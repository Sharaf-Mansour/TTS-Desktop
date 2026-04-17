function createTtsErrorPayload(payload, fallbackCode, fallbackMessage) {
  if (payload && typeof payload === "object") {
    return {
      __ttsDesktopError: true,
      code:
        typeof payload.code === "string" && payload.code
          ? payload.code
          : fallbackCode,
      message:
        typeof payload.message === "string" && payload.message
          ? payload.message
          : fallbackMessage,
      details:
        payload.details && typeof payload.details === "object"
          ? payload.details
          : {},
    };
  }

  return {
    __ttsDesktopError: true,
    code: fallbackCode,
    message: fallbackMessage,
    details: {},
  };
}

async function readJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function throwApiError(response, fallbackCode, fallbackMessage) {
  const payload = await readJsonSafely(response);
  throw createTtsErrorPayload(payload, fallbackCode, fallbackMessage);
}

function decodeHeaderValue(value) {
  if (!value) {
    return "";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function downloadFromBase64(audioBase64, filename) {
  const blob = base64ToBlob(audioBase64, "audio/mpeg");
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "speech.mp3";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const requestApi = {
  async getRuntimeStatus() {
    const response = await fetch("/api/runtime", { cache: "no-store" });
    if (!response.ok) {
      await throwApiError(
        response,
        "unexpected_error",
        "Failed to load runtime status.",
      );
    }

    return response.json();
  },

  async cancelSynthesis({ requestId } = {}) {
    const response = await fetch("/api/cancel-synthesis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
    });

    if (!response.ok) {
      await throwApiError(
        response,
        "synthesis_failed",
        "Failed to cancel speech generation.",
      );
    }

    return response.json();
  },

  async getVoices({ forceRefresh = false } = {}) {
    const suffix = forceRefresh ? "?forceRefresh=1" : "";
    const response = await fetch(`/api/voices${suffix}`, { cache: "no-store" });

    if (!response.ok) {
      await throwApiError(
        response,
        "voices_unavailable",
        "Failed to load hosted voices.",
      );
    }

    return response.json();
  },

  async synthesizeSpeech(payload = {}) {
    const response = await fetch("/api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await throwApiError(
        response,
        "synthesis_failed",
        "Failed to synthesize speech.",
      );
    }

    const audioBuffer = await response.arrayBuffer();
    return {
      audioBase64: arrayBufferToBase64(audioBuffer),
      mimeType: response.headers.get("Content-Type") || "audio/mpeg",
      usedVoiceName: decodeHeaderValue(response.headers.get("X-TTS-Voice-Name")),
      usedVoiceCulture: decodeHeaderValue(
        response.headers.get("X-TTS-Voice-Culture"),
      ),
      suggestedFilename: decodeHeaderValue(
        response.headers.get("X-TTS-Filename"),
      ),
    };
  },

  async saveGeneratedAudio({ audioBase64, filename } = {}) {
    if (typeof audioBase64 !== "string" || !audioBase64) {
      throw createTtsErrorPayload(
        {
          code: "audio_required",
          message: "Audio data is required.",
        },
        "audio_required",
        "Audio data is required.",
      );
    }

    await downloadFromBase64(audioBase64, filename || "speech.mp3");
    return {
      canceled: false,
      saved: true,
      path: "browser-download",
    };
  },

  async translateText(payload = {}) {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await throwApiError(
        response,
        "translation_failed",
        "Failed to translate text.",
      );
    }

    return response.json();
  },
};

export class Electroview {
  static defineRPC(config = {}) {
    return {
      maxRequestTime: config.maxRequestTime || 0,
      handlers: config.handlers || { requests: {}, messages: {} },
    };
  }

  constructor({ rpc } = {}) {
    this.rpc = {
      request: {
        ...requestApi,
        ...(rpc?.handlers?.requests || {}),
      },
      send: {
        ...(rpc?.handlers?.messages || {}),
      },
    };
  }
}