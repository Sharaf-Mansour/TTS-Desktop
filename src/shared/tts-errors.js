export const TTS_ERROR_CODES = {
  UNEXPECTED: "unexpected_error",
  TEXT_REQUIRED: "text_required",
  REQUEST_ID_REQUIRED: "request_id_required",
  TEXT_TOO_LONG: "text_too_long",
  NODE_MISSING: "node_missing",
  VOICES_UNAVAILABLE: "voices_unavailable",
  VOICE_NOT_FOUND: "voice_not_found",
  SYNTHESIS_TIMEOUT: "synthesis_timeout",
  SYNTHESIS_CANCELED: "synthesis_canceled",
  SYNTHESIS_OUTPUT_MISSING: "synthesis_output_missing",
  SYNTHESIS_FAILED: "synthesis_failed",
  AUDIO_REQUIRED: "audio_required",
  AUDIO_TOO_LARGE: "audio_too_large",
  SAVE_FAILED: "save_failed",
  TRANSLATION_TEXT_REQUIRED: "translation_text_required",
  TRANSLATION_TEXT_TOO_LONG: "translation_text_too_long",
  TRANSLATION_LANG_REQUIRED: "translation_lang_required",
  TRANSLATION_FAILED: "translation_failed",
};

export function createTtsError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "TtsDesktopError";
  error.code = code;
  error.details = details;
  return error;
}

export function normalizeTtsError(
  error,
  fallbackCode = TTS_ERROR_CODES.UNEXPECTED,
) {
  if (error && typeof error === "object") {
    const code =
      typeof error.code === "string" && error.code ? error.code : fallbackCode;
    const message =
      typeof error.message === "string" && error.message
        ? error.message
        : "An unexpected error occurred.";
    const details =
      error.details && typeof error.details === "object" ? error.details : {};

    return { code, message, details };
  }

  if (typeof error === "string" && error) {
    return { code: fallbackCode, message: error, details: {} };
  }

  return {
    code: fallbackCode,
    message: "An unexpected error occurred.",
    details: {},
  };
}

export function serializeTtsError(
  error,
  fallbackCode = TTS_ERROR_CODES.UNEXPECTED,
) {
  return JSON.stringify({
    __ttsDesktopError: true,
    ...normalizeTtsError(error, fallbackCode),
  });
}

export function parseTtsError(
  error,
  fallbackCode = TTS_ERROR_CODES.UNEXPECTED,
) {
  if (error && typeof error === "object") {
    if (error.__ttsDesktopError === true) {
      return normalizeTtsError(error, fallbackCode);
    }

    if (typeof error.message === "string" && error.message) {
      try {
        const parsed = JSON.parse(error.message);
        if (parsed?.__ttsDesktopError === true) {
          return normalizeTtsError(parsed, fallbackCode);
        }
      } catch {
        // Fall through to normalized error below.
      }
    }
  }

  return normalizeTtsError(error, fallbackCode);
}
