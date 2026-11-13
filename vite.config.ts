import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// MediaPipe's wasm runtime, served from node_modules (dev) and emitted into
// dist/mediapipe/wasm/ (build), so it always matches the installed version
// and the app needs no CDN at runtime.
const MEDIAPIPE_WASM = path.join(ROOT, "node_modules/@mediapipe/tasks-vision/wasm");

function mediapipeWasm(): Plugin {
  return {
    name: "mediapipe-wasm",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.match(/^\/mediapipe\/wasm\/([^?]+)/)?.[1];
        const source = file && path.join(MEDIAPIPE_WASM, path.basename(file));
        if (source && fs.existsSync(source)) {
          res.setHeader("Content-Type", source.endsWith(".wasm") ? "application/wasm" : "text/javascript");
          fs.createReadStream(source).pipe(res);
          return;
        }
        next();
      });
    },
    generateBundle() {
      for (const file of fs.readdirSync(MEDIAPIPE_WASM)) {
        this.emitFile({
          type: "asset",
          fileName: `mediapipe/wasm/${file}`,
          source: fs.readFileSync(path.join(MEDIAPIPE_WASM, file)),
        });
      }
    },
  };
}

// HTTPS (HTTPS=1) for phones on the LAN: camera, motion sensors and WebXR
// exist only on secure pages. Self-signed, so the browser warns once.
async function httpsPlugins(): Promise<Plugin[]> {
  if (process.env.HTTPS !== "1") return [];
  const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
  return [basicSsl()];
}

export default defineConfig({
  plugins: [mediapipeWasm(), ...(await httpsPlugins())],
  resolve: {
    // One three.js: IWSDK's, also for three/examples/jsm add-ons
    dedupe: ["three"],
  },
  build: {
    target: "es2022", // top-level await in main.ts
    sourcemap: true,
  },
});
