import { Electroview } from "electrobun/view";
import { TTS_ERROR_CODES, parseTtsError } from "../../shared/tts-errors.js";
import {
  MAX_SYNTHESIS_TEXT_LENGTH,
  buildDownloadFilename,
  buildVoiceKey,
  findAriaVoice,
  getPreferredVoice,
} from "../../shared/tts-shared.js";

const rpc = Electroview.defineRPC({
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

const STORAGE_KEYS = {
  selectedVoice: "tts-studio.selected-voice",
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
};

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
  });
});

window.addEventListener("resize", () => {
  renderWaveform();
});
