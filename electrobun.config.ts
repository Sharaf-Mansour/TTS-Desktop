import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "TTS Studio",
    identifier: "com.sharafmansour.ttsdesktop",
    version: "1.0.0",
  },

  runtime: {
    exitOnLastWindowClosed: true,
  },

  build: {
    bun: {
      entrypoint: "src/bun/index.js",
    },
    views: {
      mainview: {
        entrypoint: "src/views/mainview/index.js",
      },
    },
    copy: {
      "src/views/mainview/index.html": "views/mainview/index.html",
      "src/views/mainview/styles.css": "views/mainview/styles.css",
      "src/logo.png": "views/mainview/logo.png",
      "src/bun/edge-tts-helper.mjs": "views/assets/edge-tts-helper.mjs",
    },
    win: {
      bundleCEF: false,
      defaultRenderer: "native",
      icon: "src/logo.png",
    },
  },
  scripts: {
    postPackage: "./scripts/post-package.ts",
  },
} satisfies ElectrobunConfig;
