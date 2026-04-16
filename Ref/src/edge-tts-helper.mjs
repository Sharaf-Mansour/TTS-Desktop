import { readFile } from "node:fs/promises";
import { EdgeTTS } from "node-edge-tts";

const requestPath = process.argv[2];

if (!requestPath) {
  console.error("Missing request file path.");
  process.exit(1);
}

const request = JSON.parse(await readFile(requestPath, "utf8"));

if (!request.text || !request.voice || !request.outputPath) {
  console.error("Request file is missing required fields.");
  process.exit(1);
}

const tts = new EdgeTTS({
  voice: request.voice,
  lang: request.lang || "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  timeout: 20000,
});

await tts.ttsPromise(request.text, request.outputPath);
console.log(JSON.stringify({ ok: true, voice: request.voice }));
