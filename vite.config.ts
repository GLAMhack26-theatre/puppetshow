import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Wasm runtimes served from node_modules (dev) and emitted into dist/
// (build), so they always match the installed version and the app needs no
// CDN at runtime: MediaPipe's under /mediapipe/wasm/, three.js' Draco
// decoder (for Draco-compressed .glb from IIIF manifests) under /draco/.
const WASM_DIRS: Record<string, string> = {
  "mediapipe/wasm": path.join(ROOT, "node_modules/@mediapipe/tasks-vision/wasm"),
  draco: path.join(ROOT, "node_modules/three/examples/jsm/libs/draco/gltf"),
};

function wasmRuntimes(): Plugin {
  return {
    name: "wasm-runtimes",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        for (const [prefix, dir] of Object.entries(WASM_DIRS)) {
          const file = req.url?.match(new RegExp(`^/${prefix}/([^?]+)`))?.[1];
          const source = file && path.join(dir, path.basename(file));
          if (source && fs.existsSync(source)) {
            res.setHeader("Content-Type", source.endsWith(".wasm") ? "application/wasm" : "text/javascript");
            fs.createReadStream(source).pipe(res);
            return;
          }
        }
        next();
      });
    },
    generateBundle() {
      for (const [prefix, dir] of Object.entries(WASM_DIRS)) {
        for (const file of fs.readdirSync(dir)) {
          this.emitFile({ type: "asset", fileName: `${prefix}/${file}`, source: fs.readFileSync(path.join(dir, file)) });
        }
      }
    },
  };
}

// HTTPS for phones on the LAN: camera, motion sensors and WebXR exist only
// on secure pages. Self-signed, so the browser warns once. Switched on by
// `--mode https` (works in every shell, used by `npm run dev:https`) or by
// HTTPS=1 (Unix shells, Docker, dev.sh).
async function httpsPlugins(mode: string): Promise<Plugin[]> {
  if (mode !== "https" && process.env.HTTPS !== "1") return [];
  const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
  return [basicSsl()];
}

export default defineConfig(async ({ mode }) => ({
  plugins: [wasmRuntimes(), ...(await httpsPlugins(mode))],
  resolve: {
    // One three.js: IWSDK's, also for three/examples/jsm add-ons
    dedupe: ["three"],
  },
  build: {
    target: "es2022", // top-level await in main.ts
    sourcemap: true,
  },
}));
