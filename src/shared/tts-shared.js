export const MAX_SYNTHESIS_TEXT_LENGTH = 2000;

export function buildVoiceKey(voice) {
  return voice.shortName;
}

export function findAriaVoice(voices) {
  return (
    voices.find((voice) => voice.friendlyName.toLowerCase().includes("aria")) ||
    null
  );
}

export function getPreferredVoice(voices) {
  return (
    findAriaVoice(voices) ||
    voices.find((voice) => voice.shortName === "en-US-AvaNeural") ||
    voices.find(
      (voice) => voice.locale === "en-US" && voice.gender === "Female",
    ) ||
    voices.find((voice) => voice.locale === "en-US") ||
    voices[0] ||
    null
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

export function buildDownloadFilename(text, extension) {
  return `${slugifyText(text)}-${buildTimestamp()}.${extension}`;
}