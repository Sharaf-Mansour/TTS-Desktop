import { Electroview } from "electrobun/view";
import { TTS_ERROR_CODES, parseTtsError } from "../../shared/tts-errors.js";
import {
  MAX_SYNTHESIS_TEXT_LENGTH,
  buildDownloadFilename,
  buildVoiceKey,
  findAriaVoice,
  getPreferredVoice,
} from "../../shared/tts-shared.js";

const RPC_MAX_REQUEST_TIME_MS = 15000;

const rpc = Electroview.defineRPC({
  maxRequestTime: RPC_MAX_REQUEST_TIME_MS,
  handlers: {
    requests: {},
    messages: {},
  },
});

const electroview = new Electroview({ rpc });

const elements = {
  voiceSelect: document.getElementById("voiceSelect"),
  langFilter: document.getElementById("langFilter"),
  voiceSearch: document.getElementById("voiceSearch"),
  voiceCount: document.getElementById("voiceCount"),
  langDetectStatus: document.getElementById("langDetectStatus"),
  ariaStatus: document.getElementById("ariaStatus"),
  voiceRestoreStatus: document.getElementById("voiceRestoreStatus"),
  voiceOutput: document.getElementById("voiceOutput"),
  speechStatus: document.getElementById("speechStatus"),
  downloadStatus: document.getElementById("downloadStatus"),
  text: document.getElementById("text"),
  speakButton: document.getElementById("speakButton"),
  cancelGenerateButton: document.getElementById("cancelGenerateButton"),
  downloadButton: document.getElementById("downloadButton"),
  stopPlaybackButton: document.getElementById("stopPlaybackButton"),
  downloadHint: document.getElementById("downloadHint"),
  previewPanel: document.getElementById("previewPanel"),
  previewTitle: document.getElementById("previewTitle"),
  durationOutput: document.getElementById("durationOutput"),
  waveformCanvas: document.getElementById("waveformCanvas"),
  previewAudio: document.getElementById("previewAudio"),
  downloadLink: document.getElementById("downloadLink"),
};

const sttElements = {
  lang: document.getElementById("sttLang"),
  startButton: document.getElementById("sttStartButton"),
  stopButton: document.getElementById("sttStopButton"),
  clearButton: document.getElementById("sttClearButton"),
  sendToTtsButton: document.getElementById("sttSendToTtsButton"),
  sendToTranslateButton: document.getElementById("sttSendToTranslateButton"),
  status: document.getElementById("sttStatus"),
  transcript: document.getElementById("sttTranscript"),
};

const translateElements = {
  sourceLang: document.getElementById("translateSourceLang"),
  targetLang: document.getElementById("translateTargetLang"),
  swapButton: document.getElementById("translateSwapButton"),
  input: document.getElementById("translateInput"),
  button: document.getElementById("translateButton"),
  clearButton: document.getElementById("translateClearButton"),
  sendToTtsButton: document.getElementById("translateSendToTtsButton"),
  status: document.getElementById("translateStatus"),
  output: document.getElementById("translateOutput"),
};

const STORAGE_KEYS = {
  selectedVoice: "tts-studio.selected-voice",
  sttLang: "tts-studio.stt-lang",
  translateSourceLang: "tts-studio.translate-source-lang",
  translateTargetLang: "tts-studio.translate-target-lang",
};

const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

const state = {
  availableVoices: [],
  lastVoiceSnapshot: "",
  lastDownloadUrl: "",
  lastPreviewPeaks: [],
  lastServerVoiceLabel: "",
  lastGeneratedBlob: null,
  lastGeneratedFilename: "",
  isGenerating: false,
  runtimeCanSynthesize: true,
  maxSynthesisTextLength: MAX_SYNTHESIS_TEXT_LENGTH,
  currentSynthesisRequestId: "",
  cancelRequestedRequestId: "",
  textDetectTimerId: 0,
  lastDetectedTextLang: "",
};

const TEXT_LANGUAGE_SCRIPT_DETECTORS = [
  { lang: "ar", preferredLocale: "ar-SA", matcher: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/u },
  { lang: "he", preferredLocale: "he-IL", matcher: /[\u0590-\u05FF]/u },
  { lang: "ru", preferredLocale: "ru-RU", matcher: /[\u0400-\u04FF]/u },
  { lang: "el", preferredLocale: "el-GR", matcher: /[\u0370-\u03FF]/u },
  { lang: "hi", preferredLocale: "hi-IN", matcher: /[\u0900-\u097F]/u },
  { lang: "th", preferredLocale: "th-TH", matcher: /[\u0E00-\u0E7F]/u },
  { lang: "ko", preferredLocale: "ko-KR", matcher: /[\uAC00-\uD7AF]/u },
  { lang: "ja", preferredLocale: "ja-JP", matcher: /[\u3040-\u30FF]/u },
  { lang: "zh", preferredLocale: "zh-CN", matcher: /[\u4E00-\u9FFF]/u },
  { lang: "ml", preferredLocale: "ml-IN", matcher: /[\u0D00-\u0D7F]/u },
];

const TEXT_LANGUAGE_LATIN_HINTS = [
  {
    lang: "sv",
    preferredLocale: "sv-SE",
    patterns: [
      /[\u00E5\u00E4\u00F6]/gi,
      /\boch\b/gi,
      /\bdet\b/gi,
      /\bjag\b/gi,
      /\binte\b/gi,
      /\b\u00E4r\b/gi,
      /\bmed\b/gi,
      /\bf\u00F6r\b/gi,
    ],
  },
  {
    lang: "de",
    preferredLocale: "de-DE",
    patterns: [
      /[\u00E4\u00F6\u00FC\u00DF]/gi,
      /\bund\b/gi,
      /\bnicht\b/gi,
      /\bich\b/gi,
      /\bder\b/gi,
      /\bdie\b/gi,
      /\bdas\b/gi,
    ],
  },
  {
    lang: "fr",
    preferredLocale: "fr-FR",
    patterns: [
      /[\u00E0\u00E2\u00E7\u00E9\u00E8\u00EA\u00EB\u00EE\u00EF\u00F4\u00F9\u00FB\u0153]/gi,
      /\ble\b/gi,
      /\bla\b/gi,
      /\bles\b/gi,
      /\bje\b/gi,
      /\best\b/gi,
      /\bpas\b/gi,
      /\bavec\b/gi,
    ],
  },
  {
    lang: "es",
    preferredLocale: "es-ES",
    patterns: [
      /[\u00F1\u00E1\u00E9\u00ED\u00F3\u00FA\u00BF\u00A1]/gi,
      /\bel\b/gi,
      /\bla\b/gi,
      /\bque\b/gi,
      /\bde\b/gi,
      /\by\b/gi,
      /\buna\b/gi,
      /\besta\b/gi,
    ],
  },
  {
    lang: "pt",
    preferredLocale: "pt-BR",
    patterns: [
      /[\u00E3\u00F5\u00E7\u00E1\u00E9\u00ED\u00F3\u00FA]/gi,
      /\bn\u00E3o\b/gi,
      /\bque\b/gi,
      /\buma\b/gi,
      /\bcom\b/gi,
      /\bpara\b/gi,
      /\bvoc\u00EA\b/gi,
    ],
  },
  {
    lang: "it",
    preferredLocale: "it-IT",
    patterns: [
      /[\u00E0\u00E8\u00E9\u00EC\u00F2\u00F9]/gi,
      /\bche\b/gi,
      /\bnon\b/gi,
      /\bper\b/gi,
      /\buna\b/gi,
      /\bsono\b/gi,
      /\bcon\b/gi,
    ],
  },
  {
    lang: "nl",
    preferredLocale: "nl-NL",
    patterns: [
      /[\u00EB\u00EF]/gi,
      /\ben\b/gi,
      /\bhet\b/gi,
      /\bvan\b/gi,
      /\bik\b/gi,
      /\bniet\b/gi,
      /\been\b/gi,
    ],
  },
  {
    lang: "en",
    preferredLocale: "en-US",
    patterns: [
      /\bthe\b/gi,
      /\band\b/gi,
      /\bthis\b/gi,
      /\bthat\b/gi,
      /\byou\b/gi,
      /\bare\b/gi,
      /\bhello\b/gi,
    ],
  },
];

function wasRequestCanceled(requestId) {
  return state.cancelRequestedRequestId === requestId;
}

function updateDownloadHint() {
  if (!elements.downloadHint) {
    return;
  }

  const availabilityNotice = state.runtimeCanSynthesize
    ? ""
    : " Speech generation is currently unavailable until Node.js is installed and the app is restarted.";
  elements.downloadHint.textContent = `Generate a preview first, then save it explicitly. If your browser supports it, you will get a real save dialog; otherwise the app falls back to a standard download. Text limit: ${state.maxSynthesisTextLength} characters per request.${availabilityNotice}`;
}

function setVoiceRestoreStatus(message = "") {
  if (!elements.voiceRestoreStatus) {
    return;
  }

  elements.voiceRestoreStatus.hidden = !message;
  elements.voiceRestoreStatus.textContent = message;
}

function setSpeechStatus(message) {
  elements.speechStatus.textContent = `Speech status: ${message}`;
  console.log("Speech status:", message);
}

function setDownloadStatus(message) {
  elements.downloadStatus.textContent = `Download status: ${message}`;
  console.log("Download status:", message);
}

function syncActionButtons() {
  elements.speakButton.disabled =
    state.isGenerating || !state.runtimeCanSynthesize;
  elements.cancelGenerateButton.disabled = !state.isGenerating;
  elements.downloadButton.disabled =
    state.isGenerating ||
    !state.lastGeneratedBlob ||
    !state.lastGeneratedFilename;

  const hasPlayablePreview = Boolean(elements.previewAudio.src);
  const isPlaying =
    hasPlayablePreview &&
    !elements.previewAudio.paused &&
    !elements.previewAudio.ended;
  elements.stopPlaybackButton.disabled = state.isGenerating || !isPlaying;
  elements.voiceSelect.disabled = state.isGenerating;
  elements.langFilter.disabled = state.isGenerating;
  elements.voiceSearch.disabled = state.isGenerating;
  elements.text.disabled = state.isGenerating;
}

function getStoredVoiceKey() {
  try {
    return window.localStorage.getItem(STORAGE_KEYS.selectedVoice) || "";
  } catch {
    return "";
  }
}

function setStoredVoiceKey(voiceKey) {
  try {
    if (voiceKey) {
      window.localStorage.setItem(STORAGE_KEYS.selectedVoice, voiceKey);
    } else {
      window.localStorage.removeItem(STORAGE_KEYS.selectedVoice);
    }
  } catch {
    // Ignore storage failures in restricted browsing modes.
  }
}

function describeVoice(voice) {
  return voice
    ? `${voice.friendlyName} (${voice.locale})`
    : "No provider voice selected";
}

function getSelectedVoice() {
  const selectedKey = elements.voiceSelect.value;

  return (
    state.availableVoices.find(
      (voice) => buildVoiceKey(voice) === selectedKey,
    ) || getPreferredVoice(state.availableVoices)
  );
}

function selectVoice(voice) {
  if (!voice) {
    return;
  }

  const voiceKey = buildVoiceKey(voice);
  elements.voiceSelect.value = voiceKey;
  setStoredVoiceKey(voiceKey);
  updateVoiceOutput(voice);
}

function updateVoiceOutput(voice) {
  const voiceLabel = describeVoice(voice);
  const serverLabel = state.lastServerVoiceLabel
    ? ` | Server voice used: ${state.lastServerVoiceLabel}`
    : "";
  elements.voiceOutput.textContent = `Selected hosted voice: ${voiceLabel}${serverLabel}`;
  console.log("Selected hosted voice:", voiceLabel, state.lastServerVoiceLabel);
}

function revokeLastDownloadUrl() {
  if (!state.lastDownloadUrl) {
    return;
  }

  URL.revokeObjectURL(state.lastDownloadUrl);
  state.lastDownloadUrl = "";
}

function clearPreview() {
  revokeLastDownloadUrl();
  state.lastPreviewPeaks = [];
  state.lastGeneratedBlob = null;
  state.lastGeneratedFilename = "";
  elements.previewAudio.pause();
  elements.previewAudio.removeAttribute("src");
  elements.previewAudio.load();
  elements.previewTitle.textContent = "No preview yet";
  elements.durationOutput.textContent = "Duration: 0.00s";
  elements.downloadLink.hidden = true;
  elements.previewPanel.hidden = true;
  syncActionButtons();
}

function formatDuration(seconds) {
  return `${seconds.toFixed(2)}s`;
}

function buildWaveformPeaks(audioBuffer, targetCount = 180) {
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerBucket = Math.max(
    1,
    Math.floor(channelData.length / targetCount),
  );
  const peaks = [];

  for (let start = 0; start < channelData.length; start += samplesPerBucket) {
    let peak = 0;
    const end = Math.min(start + samplesPerBucket, channelData.length);

    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(channelData[index]));
    }

    peaks.push(peak);
  }

  return peaks;
}

async function loadRuntimeStatus() {
  const runtimeStatus = await electroview.rpc.request.getRuntimeStatus({});

  state.runtimeCanSynthesize = runtimeStatus?.hasNode !== false;
  if (
    Number.isFinite(runtimeStatus?.maxSynthesisTextLength) &&
    runtimeStatus.maxSynthesisTextLength > 0
  ) {
    state.maxSynthesisTextLength = runtimeStatus.maxSynthesisTextLength;
  }

  updateDownloadHint();

  if (!state.runtimeCanSynthesize) {
    setSpeechStatus(
      "Node.js is not available. Install Node.js and restart the app to enable speech generation.",
    );
    setDownloadStatus(
      "speech generation unavailable until Node.js is installed",
    );
  }
}

function getFriendlyErrorMessage(appError) {
  switch (appError.code) {
    case TTS_ERROR_CODES.NODE_MISSING:
      return "Node.js is not available. Install Node.js and restart the app to enable speech generation.";
    case TTS_ERROR_CODES.TEXT_TOO_LONG:
      return `Text is too long. Keep each request under ${state.maxSynthesisTextLength} characters.`;
    case TTS_ERROR_CODES.VOICES_UNAVAILABLE:
      return "The hosted voice catalog is unavailable right now. Try again in a moment.";
    case TTS_ERROR_CODES.VOICE_NOT_FOUND:
      return "The selected voice is no longer available. Choose another voice and try again.";
    case TTS_ERROR_CODES.SYNTHESIS_TIMEOUT:
      return "Speech generation took too long. Shorten the text and try again.";
    case TTS_ERROR_CODES.SYNTHESIS_CANCELED:
      return "Speech generation was canceled.";
    case TTS_ERROR_CODES.AUDIO_TOO_LARGE:
      return "The generated audio is too large to save with the current limit.";
    default:
      return appError.message || "An unexpected error occurred.";
  }
}

function renderWaveform(peaks = state.lastPreviewPeaks) {
  const canvas = elements.waveformCanvas;
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || canvas.width));
  const height = Math.max(140, Math.floor(rect.height || canvas.height));
  const devicePixelRatio = window.devicePixelRatio || 1;

  canvas.width = Math.floor(width * devicePixelRatio);
  canvas.height = Math.floor(height * devicePixelRatio);
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "rgba(13, 124, 102, 0.94)");
  gradient.addColorStop(1, "rgba(165, 69, 43, 0.88)");

  context.fillStyle = "rgba(255, 255, 255, 0.78)";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(46, 36, 23, 0.12)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  if (peaks.length === 0) {
    context.fillStyle = "rgba(109, 91, 68, 0.8)";
    context.font = '16px Georgia, "Times New Roman", serif';
    context.fillText(
      "Waveform preview appears after generation.",
      20,
      height / 2 + 6,
    );
    return;
  }

  const step = width / peaks.length;
  const centerY = height / 2;
  const maxBarHeight = height * 0.42;
  const barWidth = Math.max(2, step * 0.68);

  context.fillStyle = gradient;
  peaks.forEach((peak, index) => {
    const barHeight = Math.max(3, peak * maxBarHeight);
    const x = index * step + (step - barWidth) / 2;
    context.fillRect(x, centerY - barHeight, barWidth, barHeight * 2);
  });
}

async function decodeAudioBlob(blob) {
  if (!AudioContextCtor) {
    return null;
  }

  const audioContext = new AudioContextCtor();

  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close();
  }
}

function updatePreview(blob, filename, durationSeconds, peaks) {
  revokeLastDownloadUrl();

  const previewUrl = URL.createObjectURL(blob);
  state.lastDownloadUrl = previewUrl;
  state.lastPreviewPeaks = peaks;
  state.lastGeneratedBlob = blob;
  state.lastGeneratedFilename = filename;

  elements.previewAudio.src = previewUrl;
  elements.previewTitle.textContent = filename;
  elements.durationOutput.textContent = `Duration: ${formatDuration(durationSeconds)}`;
  elements.previewPanel.hidden = false;
  elements.downloadLink.href = previewUrl;
  elements.downloadLink.download = filename;
  elements.downloadLink.textContent = `Download Audio: ${filename}`;
  elements.downloadLink.hidden = false;

  window.requestAnimationFrame(() => renderWaveform(peaks));
  syncActionButtons();
}

function triggerBrowserDownload(filename) {
  if (!state.lastDownloadUrl) {
    return false;
  }

  const anchor = document.createElement("a");
  anchor.href = state.lastDownloadUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

async function blobToBase64(blob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return String(dataUrl).replace(/^data:[^;]+;base64,/, "");
}

function base64ToBlob(base64, mimeType) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

async function saveGeneratedAudio() {
  if (!state.lastGeneratedBlob || !state.lastGeneratedFilename) {
    setDownloadStatus("generate audio before saving");
    return;
  }

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: state.lastGeneratedFilename,
        types: [
          {
            description: "MPEG Audio",
            accept: {
              "audio/mpeg": [".mp3"],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(state.lastGeneratedBlob);
      await writable.close();
      setDownloadStatus(`saved: ${state.lastGeneratedFilename}`);
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setDownloadStatus("save cancelled");
        return;
      }

      console.warn(
        "showSaveFilePicker failed, falling back to Bun save flow",
        error,
      );
    }
  }

  try {
    const result = await electroview.rpc.request.saveGeneratedAudio({
      audioBase64: await blobToBase64(state.lastGeneratedBlob),
      filename: state.lastGeneratedFilename,
    });

    if (result?.saved) {
      setDownloadStatus(`saved: ${state.lastGeneratedFilename}`);
      return;
    }

    if (result?.canceled) {
      setDownloadStatus("save cancelled");
      return;
    }
  } catch (error) {
    const appError = parseTtsError(error, TTS_ERROR_CODES.SAVE_FAILED);
    console.warn(
      "Bun save flow failed, falling back to browser download",
      appError,
    );

    if (
      appError.code === TTS_ERROR_CODES.AUDIO_TOO_LARGE ||
      appError.code === TTS_ERROR_CODES.AUDIO_REQUIRED
    ) {
      setDownloadStatus(getFriendlyErrorMessage(appError));
      return;
    }
  }

  if (triggerBrowserDownload(state.lastGeneratedFilename)) {
    setDownloadStatus(`download started: ${state.lastGeneratedFilename}`);
    return;
  }

  setDownloadStatus("save failed");
}

function languageLabel(locale) {
  try {
    const display = new Intl.DisplayNames(["en"], { type: "language" });
    const langCode = locale.split("-")[0];
    const name = display.of(langCode);
    return name ? `${name} (${langCode})` : locale;
  } catch {
    return locale;
  }
}

function setLanguageDetectorStatus(message) {
  if (!elements.langDetectStatus) {
    return;
  }

  elements.langDetectStatus.textContent = `Language detector: ${message}`;
}

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function detectTextLanguage(text) {
  const sample = text.trim();
  if (sample.length < 4) {
    return null;
  }

  for (const detector of TEXT_LANGUAGE_SCRIPT_DETECTORS) {
    if (detector.matcher.test(sample)) {
      return detector;
    }
  }

  const latinOnly = !/[^\u0000-\u024F\s\d.,!?;:'"()\-]/u.test(sample);
  if (!latinOnly) {
    return null;
  }

  const scored = TEXT_LANGUAGE_LATIN_HINTS.map((detector) => ({
    ...detector,
    score: detector.patterns.reduce(
      (total, pattern) => total + countMatches(sample, pattern),
      0,
    ),
  }))
    .filter((detector) => detector.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];
  const runnerUp = scored[1];
  if (best.score < 2) {
    return null;
  }
  if (runnerUp && best.score <= runnerUp.score) {
    return null;
  }

  return best;
}

function findVoiceForDetectedLanguage(lang, preferredLocale) {
  const preferred = state.availableVoices.find(
    (voice) => voice.locale.toLowerCase() === preferredLocale.toLowerCase(),
  );
  if (preferred) {
    return preferred;
  }

  return state.availableVoices.find((voice) =>
    voice.locale.toLowerCase().startsWith(`${lang.toLowerCase()}-`),
  );
}

function applyDetectedLanguageToVoicePicker() {
  const text = elements.text.value.trim();
  if (!text) {
    state.lastDetectedTextLang = "";
    setLanguageDetectorStatus("waiting for text.");
    return;
  }

  const detection = detectTextLanguage(text);
  if (!detection) {
    state.lastDetectedTextLang = "";
    setLanguageDetectorStatus("no clear match yet.");
    return;
  }

  const detectedLang = detection.lang.toLowerCase();
  const hasFilterOption = [...elements.langFilter.options].some(
    (option) => option.value.toLowerCase() === detectedLang,
  );

  if (!hasFilterOption) {
    setLanguageDetectorStatus(
      `${languageLabel(detectedLang)} detected, but no matching voice filter is loaded.`,
    );
    return;
  }

  if (
    state.lastDetectedTextLang === detectedLang &&
    elements.langFilter.value.toLowerCase() === detectedLang
  ) {
    setLanguageDetectorStatus(`${languageLabel(detectedLang)} detected.`);
    return;
  }

  state.lastDetectedTextLang = detectedLang;
  elements.langFilter.value = detectedLang;
  renderVoiceOptions();

  const detectedVoice = findVoiceForDetectedLanguage(
    detectedLang,
    detection.preferredLocale,
  );
  if (detectedVoice) {
    selectVoice(detectedVoice);
  }

  setLanguageDetectorStatus(
    `${languageLabel(detectedLang)} detected and applied to the voice filter.`,
  );
}

function scheduleTextLanguageDetection(delayMs = 220) {
  if (state.textDetectTimerId) {
    window.clearTimeout(state.textDetectTimerId);
  }

  state.textDetectTimerId = window.setTimeout(() => {
    state.textDetectTimerId = 0;
    applyDetectedLanguageToVoicePicker();
  }, delayMs);
}

function renderVoiceOptions() {
  const langValue = elements.langFilter.value;
  const searchText = elements.voiceSearch.value.trim().toLowerCase();

  let filtered = state.availableVoices;

  if (langValue) {
    filtered = filtered.filter((v) => v.locale.startsWith(langValue));
  }

  if (searchText) {
    filtered = filtered.filter(
      (v) =>
        v.friendlyName.toLowerCase().includes(searchText) ||
        v.shortName.toLowerCase().includes(searchText) ||
        v.locale.toLowerCase().includes(searchText),
    );
  }

  const previousKey = elements.voiceSelect.value || getStoredVoiceKey();
  elements.voiceSelect.innerHTML = "";

  const grouped = new Map();
  for (const voice of filtered) {
    const lang = voice.locale.split("-")[0];
    if (!grouped.has(lang)) grouped.set(lang, []);
    grouped.get(lang).push(voice);
  }

  const sortedLangs = [...grouped.keys()].sort((a, b) =>
    languageLabel(a).localeCompare(languageLabel(b)),
  );

  for (const lang of sortedLangs) {
    const voices = grouped
      .get(lang)
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
    const optgroup = document.createElement("optgroup");
    optgroup.label = languageLabel(lang);

    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = buildVoiceKey(voice);
      option.textContent = `${voice.friendlyName} (${voice.locale})`;
      optgroup.appendChild(option);
    }

    elements.voiceSelect.appendChild(optgroup);
  }

  elements.voiceCount.textContent = `Showing ${filtered.length} of ${state.availableVoices.length} voices`;

  const restoredVoice = filtered.find((v) => buildVoiceKey(v) === previousKey);
  if (restoredVoice) {
    elements.voiceSelect.value = buildVoiceKey(restoredVoice);
  } else if (filtered.length > 0) {
    elements.voiceSelect.value = buildVoiceKey(filtered[0]);
  }

  const selected = getSelectedVoice();
  if (selected) updateVoiceOutput(selected);
}

async function populateVoices() {
  const payload = await electroview.rpc.request.getVoices({
    forceRefresh: false,
  });
  const voices = Array.isArray(payload?.voices)
    ? payload.voices
        .slice()
        .sort(
          (left, right) =>
            left.locale.localeCompare(right.locale) ||
            left.friendlyName.localeCompare(right.friendlyName),
        )
    : [];

  const snapshot = voices.map(buildVoiceKey).join("|");
  if (snapshot === state.lastVoiceSnapshot && voices.length > 0) {
    return true;
  }

  if (voices.length === 0) {
    state.availableVoices = [];
    elements.voiceSelect.innerHTML =
      '<option value="">No hosted voices available.</option>';
    elements.ariaStatus.textContent =
      "Hosted voice catalog is unavailable right now.";
    updateVoiceOutput(null);
    setSpeechStatus("waiting for hosted voices");
    return false;
  }

  state.lastVoiceSnapshot = snapshot;
  state.availableVoices = voices;

  const langs = [...new Set(voices.map((v) => v.locale.split("-")[0]))].sort(
    (a, b) => languageLabel(a).localeCompare(languageLabel(b)),
  );
  const prevLang = elements.langFilter.value;
  elements.langFilter.innerHTML = '<option value="">All languages</option>';
  for (const lang of langs) {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = languageLabel(lang);
    elements.langFilter.appendChild(opt);
  }
  if (prevLang) elements.langFilter.value = prevLang;

  renderVoiceOptions();

  const storedSelection = getStoredVoiceKey();
  const restoredVoice = voices.find(
    (voice) => buildVoiceKey(voice) === storedSelection,
  );
  const selectedVoice = restoredVoice || getPreferredVoice(voices);

  if (storedSelection) {
    if (restoredVoice) {
      setVoiceRestoreStatus(
        `Restored your saved voice: ${restoredVoice.friendlyName} (${restoredVoice.locale}).`,
      );
    } else if (selectedVoice) {
      setVoiceRestoreStatus(
        `Your previously saved voice is no longer available. Switched to ${selectedVoice.friendlyName} (${selectedVoice.locale}).`,
      );
    } else {
      setVoiceRestoreStatus(
        "Your previously saved voice is no longer available.",
      );
    }
  } else {
    setVoiceRestoreStatus("");
  }

  if (selectedVoice) {
    selectVoice(selectedVoice);
  }

  const ariaVoice = findAriaVoice(voices);
  elements.ariaStatus.textContent = ariaVoice
    ? `Aria is available from the hosted provider: ${ariaVoice.friendlyName} (${ariaVoice.locale})`
    : "Aria is not available from the hosted provider.";

  setSpeechStatus(`ready with ${voices.length} hosted voices`);
  return true;
}

async function requestSynthesis(text, voice, requestId) {
  try {
    const response = await electroview.rpc.request.synthesizeSpeech({
      requestId,
      text,
      requestedVoice: voice
        ? {
            name: voice.friendlyName,
            lang: voice.locale,
            voiceURI: voice.shortName,
            default: false,
            localService: false,
          }
        : null,
    });

    return {
      blob: base64ToBlob(
        response.audioBase64,
        response.mimeType || "audio/mpeg",
      ),
      usedVoiceName: response.usedVoiceName || "",
      usedVoiceCulture: response.usedVoiceCulture || "",
      suggestedFilename: response.suggestedFilename || "",
    };
  } catch (error) {
    throw parseTtsError(error, TTS_ERROR_CODES.SYNTHESIS_FAILED);
  }
}

function ensureSpeakableState() {
  const normalizedText = elements.text.value.trim();

  if (state.availableVoices.length === 0) {
    setSpeechStatus("hosted voices are still loading, please try again");
    return false;
  }

  if (!normalizedText) {
    setSpeechStatus("enter some text first");
    return false;
  }

  if (normalizedText.length > state.maxSynthesisTextLength) {
    setSpeechStatus(
      `text exceeds ${state.maxSynthesisTextLength} characters; shorten it and try again`,
    );
    setDownloadStatus("generation blocked by text length limit");
    return false;
  }

  return true;
}

async function cancelSpeechGeneration() {
  if (!state.isGenerating || !state.currentSynthesisRequestId) {
    return;
  }

  const requestId = state.currentSynthesisRequestId;
  state.cancelRequestedRequestId = requestId;
  setSpeechStatus("canceling speech generation");
  setDownloadStatus("canceling generation");

  try {
    await electroview.rpc.request.cancelSynthesis({ requestId });
  } catch (error) {
    console.warn("Failed to cancel speech generation", error);
  }
}

async function generateSpeech() {
  if (!ensureSpeakableState()) {
    return;
  }

  const selectedVoice = getSelectedVoice();
  const text = elements.text.value.trim();
  const requestId = window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  state.isGenerating = true;
  state.currentSynthesisRequestId = requestId;
  state.cancelRequestedRequestId = "";
  state.lastServerVoiceLabel = "";
  syncActionButtons();
  clearPreview();
  updateVoiceOutput(selectedVoice);
  setSpeechStatus(
    `requesting hosted synthesis for ${describeVoice(selectedVoice)}`,
  );
  setDownloadStatus("generating audio on server");

  try {
    const { blob, usedVoiceName, usedVoiceCulture, suggestedFilename } =
      await requestSynthesis(text, selectedVoice, requestId);

    if (
      state.currentSynthesisRequestId !== requestId ||
      wasRequestCanceled(requestId)
    ) {
      throw new Error("Speech generation was canceled.");
    }

    setSpeechStatus("preparing generated preview");
    const decodedAudio = await decodeAudioBlob(blob);

    if (
      state.currentSynthesisRequestId !== requestId ||
      wasRequestCanceled(requestId)
    ) {
      throw new Error("Speech generation was canceled.");
    }

    const filename = suggestedFilename || buildDownloadFilename(text, "mp3");
    const durationSeconds = decodedAudio ? decodedAudio.duration : 0;
    const peaks = decodedAudio ? buildWaveformPeaks(decodedAudio) : [];
    state.lastServerVoiceLabel = usedVoiceName
      ? `${usedVoiceName}${usedVoiceCulture ? ` (${usedVoiceCulture})` : ""}`
      : "default server voice";

    if (
      state.currentSynthesisRequestId !== requestId ||
      wasRequestCanceled(requestId)
    ) {
      return;
    }

    updatePreview(blob, filename, durationSeconds, peaks);
    updateVoiceOutput(selectedVoice);
    const autoplayStarted = await elements.previewAudio
      .play()
      .then(() => true)
      .catch((error) => {
        console.warn("Preview autoplay was blocked", error);
        return false;
      });
    setSpeechStatus(
      autoplayStarted
        ? `server rendered with ${usedVoiceName || "default server voice"}${usedVoiceCulture ? ` (${usedVoiceCulture})` : ""}`
        : `preview ready for ${usedVoiceName || "default server voice"}${usedVoiceCulture ? ` (${usedVoiceCulture})` : ""}; press play to listen`,
    );
    setDownloadStatus(
      `preview ready: ${filename}. Use Save Audio As to keep it.`,
    );
  } catch (error) {
    const appError = parseTtsError(error, TTS_ERROR_CODES.SYNTHESIS_FAILED);
    const wasCanceled = appError.code === TTS_ERROR_CODES.SYNTHESIS_CANCELED;
    setSpeechStatus(
      wasCanceled
        ? "speech generation canceled"
        : `error: ${getFriendlyErrorMessage(appError)}`,
    );
    setDownloadStatus(
      wasCanceled ? "generation canceled" : "generation failed",
    );
  } finally {
    if (state.currentSynthesisRequestId === requestId) {
      state.isGenerating = false;
      state.currentSynthesisRequestId = "";
      state.cancelRequestedRequestId = "";
      syncActionButtons();
    }
  }
}

elements.voiceSelect.addEventListener("change", () => {
  const selectedVoice = getSelectedVoice();
  if (selectedVoice) {
    setStoredVoiceKey(buildVoiceKey(selectedVoice));
  }
  setVoiceRestoreStatus("");
  updateVoiceOutput(selectedVoice);
  setSpeechStatus("hosted voice selected");
});

elements.langFilter.addEventListener("change", () => {
  renderVoiceOptions();
});

elements.voiceSearch.addEventListener("input", () => {
  renderVoiceOptions();
});

elements.text.addEventListener("input", () => {
  scheduleTextLanguageDetection();
});

elements.speakButton.addEventListener("click", () => {
  void generateSpeech();
});

elements.cancelGenerateButton.addEventListener("click", () => {
  void cancelSpeechGeneration();
});

elements.downloadButton.addEventListener("click", () => {
  void saveGeneratedAudio();
});

elements.stopPlaybackButton.addEventListener("click", () => {
  elements.previewAudio.pause();
  elements.previewAudio.currentTime = 0;
  setSpeechStatus("playback stopped");
  syncActionButtons();
});

elements.previewAudio.addEventListener("play", () => {
  setSpeechStatus("playing preview");
  syncActionButtons();
});

elements.previewAudio.addEventListener("pause", () => {
  if (!elements.previewAudio.ended) {
    setSpeechStatus("preview paused");
  }
  syncActionButtons();
});

elements.previewAudio.addEventListener("ended", () => {
  setSpeechStatus("preview finished");
  syncActionButtons();
});

window.addEventListener("load", () => {
  clearPreview();
  renderWaveform([]);
  updateDownloadHint();
  syncActionButtons();
  void loadRuntimeStatus()
    .catch((error) => {
      const appError = parseTtsError(error, TTS_ERROR_CODES.UNEXPECTED);
      console.warn("Failed to load runtime status", appError);
    })
    .finally(() => {
      syncActionButtons();
    });
  void populateVoices().catch((error) => {
    const appError = parseTtsError(error, TTS_ERROR_CODES.VOICES_UNAVAILABLE);
    setSpeechStatus(`error: ${getFriendlyErrorMessage(appError)}`);
    setDownloadStatus("voice catalog unavailable");
  }).finally(() => {
    scheduleTextLanguageDetection(0);
  });
});

window.addEventListener("resize", () => {
  renderWaveform();
});

// -----------------------------------------------------------------------------
// Speech-to-Text (browser Web Speech API)
// -----------------------------------------------------------------------------

const SpeechRecognitionCtor =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const STT_LANGUAGES = [
  { code: "en-US", label: "English (United States)" },
  { code: "en-GB", label: "English (United Kingdom)" },
  { code: "es-ES", label: "Spanish (Spain)" },
  { code: "es-MX", label: "Spanish (Mexico)" },
  { code: "fr-FR", label: "French (France)" },
  { code: "de-DE", label: "German (Germany)" },
  { code: "it-IT", label: "Italian (Italy)" },
  { code: "pt-BR", label: "Portuguese (Brazil)" },
  { code: "pt-PT", label: "Portuguese (Portugal)" },
  { code: "ru-RU", label: "Russian (Russia)" },
  { code: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { code: "ar-EG", label: "Arabic (Egypt)" },
  { code: "tr-TR", label: "Turkish (Turkey)" },
  { code: "nl-NL", label: "Dutch (Netherlands)" },
  { code: "sv-SE", label: "Swedish (Sweden)" },
  { code: "pl-PL", label: "Polish (Poland)" },
  { code: "uk-UA", label: "Ukrainian (Ukraine)" },
  { code: "cs-CZ", label: "Czech (Czechia)" },
  { code: "hi-IN", label: "Hindi (India)" },
  { code: "ja-JP", label: "Japanese (Japan)" },
  { code: "ko-KR", label: "Korean (South Korea)" },
  { code: "zh-CN", label: "Chinese (Mandarin, China)" },
  { code: "zh-TW", label: "Chinese (Mandarin, Taiwan)" },
  { code: "vi-VN", label: "Vietnamese (Vietnam)" },
  { code: "th-TH", label: "Thai (Thailand)" },
  { code: "id-ID", label: "Indonesian (Indonesia)" },
];

const TRANSLATE_LANGUAGES = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "tr", label: "Turkish" },
  { code: "nl", label: "Dutch" },
  { code: "sv", label: "Swedish" },
  { code: "pl", label: "Polish" },
  { code: "uk", label: "Ukrainian" },
  { code: "cs", label: "Czech" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh-CN", label: "Chinese (Simplified)" },
  { code: "zh-TW", label: "Chinese (Traditional)" },
  { code: "vi", label: "Vietnamese" },
  { code: "th", label: "Thai" },
  { code: "id", label: "Indonesian" },
  { code: "he", label: "Hebrew" },
  { code: "el", label: "Greek" },
  { code: "ro", label: "Romanian" },
  { code: "hu", label: "Hungarian" },
];

const sttState = {
  recognizer: null,
  isListening: false,
  finalizedText: "",
  interimText: "",
};

function populateSelect(selectEl, options, defaultValue) {
  selectEl.innerHTML = "";
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.code;
    el.textContent = option.label;
    selectEl.appendChild(el);
  }
  if (defaultValue) {
    selectEl.value = defaultValue;
  }
}

function loadStoredValue(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function storeValue(key, value) {
  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures.
  }
}

function setSttStatus(message) {
  sttElements.status.textContent = `Recognition status: ${message}`;
}

function syncSttButtons() {
  const hasRecognizer = Boolean(SpeechRecognitionCtor);
  const hasTranscript = sttElements.transcript.value.trim().length > 0;

  sttElements.startButton.disabled = !hasRecognizer || sttState.isListening;
  sttElements.stopButton.disabled = !sttState.isListening;
  sttElements.clearButton.disabled = !hasTranscript && !sttState.interimText;
  sttElements.sendToTtsButton.disabled = !hasTranscript;
  sttElements.sendToTranslateButton.disabled = !hasTranscript;
  sttElements.lang.disabled = sttState.isListening;
}

function renderSttTranscript() {
  const combined = sttState.interimText
    ? `${sttState.finalizedText}${sttState.finalizedText ? " " : ""}${sttState.interimText}`.trimStart()
    : sttState.finalizedText;
  sttElements.transcript.value = combined;
  syncSttButtons();
}

function startSpeechRecognition() {
  if (!SpeechRecognitionCtor) {
    setSttStatus("speech recognition is not supported in this runtime");
    return;
  }

  if (sttState.isListening) {
    return;
  }

  const recognizer = new SpeechRecognitionCtor();
  recognizer.lang = sttElements.lang.value || "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;

  recognizer.onstart = () => {
    sttState.isListening = true;
    setSttStatus(`listening in ${recognizer.lang}`);
    syncSttButtons();
  };

  recognizer.onerror = (event) => {
    const errorName = event?.error || "unknown";
    if (errorName === "not-allowed" || errorName === "service-not-allowed") {
      setSttStatus(
        "microphone permission denied. Allow access and try again.",
      );
    } else if (errorName === "no-speech") {
      setSttStatus("no speech detected. Try again.");
    } else if (errorName === "network") {
      setSttStatus("network error while reaching the speech service.");
    } else {
      setSttStatus(`error: ${errorName}`);
    }
  };

  recognizer.onresult = (event) => {
    let interim = "";
    let finalized = sttState.finalizedText;

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result[0]?.transcript || "";
      if (result.isFinal) {
        finalized = finalized
          ? `${finalized} ${transcript.trim()}`.trim()
          : transcript.trim();
      } else {
        interim += transcript;
      }
    }

    sttState.finalizedText = finalized;
    sttState.interimText = interim.trim();
    renderSttTranscript();
  };

  recognizer.onend = () => {
    sttState.isListening = false;
    sttState.interimText = "";
    sttState.recognizer = null;
    renderSttTranscript();
    setSttStatus(
      sttState.finalizedText
        ? "stopped. Transcript ready."
        : "stopped. No transcript captured.",
    );
    syncSttButtons();
  };

  try {
    recognizer.start();
    sttState.recognizer = recognizer;
  } catch (error) {
    console.warn("Failed to start speech recognition", error);
    setSttStatus(`could not start: ${error?.message || "unknown error"}`);
  }
}

function stopSpeechRecognition() {
  if (sttState.recognizer && sttState.isListening) {
    try {
      sttState.recognizer.stop();
    } catch (error) {
      console.warn("Failed to stop speech recognition", error);
    }
  }
}

function clearSpeechTranscript() {
  sttState.finalizedText = "";
  sttState.interimText = "";
  sttElements.transcript.value = "";
  setSttStatus("transcript cleared.");
  syncSttButtons();
}

function initializeSpeechToText() {
  const storedLang = loadStoredValue(STORAGE_KEYS.sttLang, "en-US");
  populateSelect(sttElements.lang, STT_LANGUAGES, storedLang);

  if (!SpeechRecognitionCtor) {
    setSttStatus(
      "speech recognition is not available in this runtime. Try running on Windows with WebView2.",
    );
    sttElements.startButton.disabled = true;
    return;
  }

  setSttStatus("idle. Click Start Recording to begin.");

  sttElements.lang.addEventListener("change", () => {
    storeValue(STORAGE_KEYS.sttLang, sttElements.lang.value);
  });

  sttElements.startButton.addEventListener("click", () => {
    startSpeechRecognition();
  });

  sttElements.stopButton.addEventListener("click", () => {
    stopSpeechRecognition();
  });

  sttElements.clearButton.addEventListener("click", () => {
    clearSpeechTranscript();
  });

  sttElements.transcript.addEventListener("input", () => {
    sttState.finalizedText = sttElements.transcript.value;
    sttState.interimText = "";
    syncSttButtons();
  });

  sttElements.sendToTtsButton.addEventListener("click", () => {
    const text = sttElements.transcript.value.trim();
    if (!text) {
      return;
    }
    elements.text.value = text;
    elements.text.dispatchEvent(new Event("input"));
    setSpeechStatus("text updated from transcript");
    elements.text.focus();
  });

  sttElements.sendToTranslateButton.addEventListener("click", () => {
    const text = sttElements.transcript.value.trim();
    if (!text) {
      return;
    }
    translateElements.input.value = text;
    const sttLangRoot = (sttElements.lang.value || "en").split("-")[0];
    const matchingSource = TRANSLATE_LANGUAGES.find(
      (option) => option.code === sttLangRoot,
    );
    if (matchingSource) {
      translateElements.sourceLang.value = matchingSource.code;
      storeValue(STORAGE_KEYS.translateSourceLang, matchingSource.code);
    }
    setTranslateStatus("text copied from transcript. Click Translate.");
    translateElements.input.focus();
    syncTranslateButtons();
  });

  syncSttButtons();
}

// -----------------------------------------------------------------------------
// Translation
// -----------------------------------------------------------------------------

const translateState = {
  isTranslating: false,
  lastResult: "",
};

function setTranslateStatus(message) {
  translateElements.status.textContent = `Translation status: ${message}`;
}

function syncTranslateButtons() {
  const hasInput = translateElements.input.value.trim().length > 0;
  const hasOutput = translateElements.output.value.trim().length > 0;

  translateElements.button.disabled =
    translateState.isTranslating || !hasInput;
  translateElements.clearButton.disabled = !hasInput && !hasOutput;
  translateElements.sendToTtsButton.disabled = !hasOutput;
  translateElements.swapButton.disabled = translateState.isTranslating;
  translateElements.sourceLang.disabled = translateState.isTranslating;
  translateElements.targetLang.disabled = translateState.isTranslating;
  translateElements.input.disabled = translateState.isTranslating;
}

async function performTranslation() {
  const text = translateElements.input.value.trim();
  if (!text) {
    setTranslateStatus("enter some text to translate.");
    return;
  }

  const sourceLang = translateElements.sourceLang.value || "auto";
  const targetLang = translateElements.targetLang.value || "en";

  if (sourceLang !== "auto" && sourceLang === targetLang) {
    setTranslateStatus("source and target languages are the same.");
    return;
  }

  translateState.isTranslating = true;
  syncTranslateButtons();
  setTranslateStatus(
    `translating from ${sourceLang === "auto" ? "auto-detect" : sourceLang} to ${targetLang}...`,
  );

  try {
    const response = await electroview.rpc.request.translateText({
      text,
      sourceLang,
      targetLang,
    });

    const translated =
      typeof response?.translatedText === "string"
        ? response.translatedText
        : "";
    translateElements.output.value = translated;
    translateState.lastResult = translated;

    const detected = response?.detectedSourceLang || sourceLang;
    const provider = response?.provider ? ` via ${response.provider}` : "";
    setTranslateStatus(`translated${provider} (${detected} → ${targetLang}).`);
  } catch (error) {
    const appError = parseTtsError(error, TTS_ERROR_CODES.TRANSLATION_FAILED);
    let friendly = appError.message || "translation failed.";
    if (appError.code === TTS_ERROR_CODES.TRANSLATION_TEXT_TOO_LONG) {
      friendly = `text too long. Limit: ${appError.details?.maxLength || "5000"} characters.`;
    } else if (appError.code === TTS_ERROR_CODES.TRANSLATION_TEXT_REQUIRED) {
      friendly = "text to translate is required.";
    } else if (appError.code === TTS_ERROR_CODES.TRANSLATION_LANG_REQUIRED) {
      friendly = "pick a target language.";
    }
    setTranslateStatus(`error: ${friendly}`);
  } finally {
    translateState.isTranslating = false;
    syncTranslateButtons();
  }
}

function initializeTranslation() {
  const storedSource = loadStoredValue(
    STORAGE_KEYS.translateSourceLang,
    "auto",
  );
  const storedTarget = loadStoredValue(STORAGE_KEYS.translateTargetLang, "en");

  populateSelect(
    translateElements.sourceLang,
    TRANSLATE_LANGUAGES,
    storedSource,
  );
  populateSelect(
    translateElements.targetLang,
    TRANSLATE_LANGUAGES.filter((option) => option.code !== "auto"),
    storedTarget,
  );

  translateElements.sourceLang.addEventListener("change", () => {
    storeValue(
      STORAGE_KEYS.translateSourceLang,
      translateElements.sourceLang.value,
    );
  });

  translateElements.targetLang.addEventListener("change", () => {
    storeValue(
      STORAGE_KEYS.translateTargetLang,
      translateElements.targetLang.value,
    );
  });

  translateElements.input.addEventListener("input", () => {
    syncTranslateButtons();
  });

  translateElements.button.addEventListener("click", () => {
    void performTranslation();
  });

  translateElements.swapButton.addEventListener("click", () => {
    const source = translateElements.sourceLang.value;
    const target = translateElements.targetLang.value;
    if (source === "auto") {
      setTranslateStatus("cannot swap while source is auto-detect.");
      return;
    }
    translateElements.sourceLang.value = target;
    translateElements.targetLang.value = source;
    const inputText = translateElements.input.value;
    const outputText = translateElements.output.value;
    translateElements.input.value = outputText;
    translateElements.output.value = inputText;
    storeValue(STORAGE_KEYS.translateSourceLang, target);
    storeValue(STORAGE_KEYS.translateTargetLang, source);
    syncTranslateButtons();
    setTranslateStatus("languages swapped.");
  });

  translateElements.clearButton.addEventListener("click", () => {
    translateElements.input.value = "";
    translateElements.output.value = "";
    translateState.lastResult = "";
    setTranslateStatus("cleared.");
    syncTranslateButtons();
  });

  translateElements.sendToTtsButton.addEventListener("click", () => {
    const text = translateElements.output.value.trim();
    if (!text) {
      return;
    }
    elements.text.value = text;
    elements.text.dispatchEvent(new Event("input"));
    setSpeechStatus("text updated from translation");

    const targetLangRoot = (
      translateElements.targetLang.value || ""
    ).toLowerCase();
    if (targetLangRoot && Array.isArray(state.availableVoices)) {
      const match = state.availableVoices.find((voice) =>
        voice.locale.toLowerCase().startsWith(`${targetLangRoot}-`),
      );
      if (match) {
        selectVoice(match);
        setVoiceRestoreStatus(
          `Voice auto-switched to ${match.friendlyName} (${match.locale}) to match translation target.`,
        );
      }
    }

    elements.text.focus();
  });

  setTranslateStatus("idle.");
  syncTranslateButtons();
}

initializeSpeechToText();
initializeTranslation();
