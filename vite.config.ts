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

// Plays with their scene presets (src/plays/): one JSON per play in
// assets/plays/. Fetched at runtime instead of imported, so saving from the
// director bar does not reload the page (a changed import would). Dev: GET
// lists and reads them, PUT writes a play back into assets/plays/ (only the
// dev server can write, and only to that folder). Build: copied to dist/plays/.
const PLAYS_DIR = path.join(ROOT, "assets/plays");
const PLAY_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;

function playIds() {
  if (!fs.existsSync(PLAYS_DIR)) return [];
  return fs
    .readdirSync(PLAYS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => PLAY_ID.test(id))
    .sort();
}

function plays(): Plugin {
  return {
    name: "plays",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (url === "/plays/index.json" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(playIds()));
          return;
        }
        const id = url.match(/^\/plays\/([^/]+)\.json$/)?.[1];
        if (!id) return next();
        if (!PLAY_ID.test(id)) {
          res.statusCode = 400;
          res.end("bad play id");
          return;
        }
        const file = path.join(PLAYS_DIR, `${id}.json`);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          fs.createReadStream(file).pipe(res);
          return;
        }
        if (req.method === "PUT") {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const play = JSON.parse(body);
              if (!play || typeof play !== "object" || !Array.isArray(play.scenes)) throw new Error("no scenes");
              fs.mkdirSync(PLAYS_DIR, { recursive: true });
              fs.writeFileSync(file, `${JSON.stringify(play, null, 2)}\n`);
              res.statusCode = 204;
              res.end();
            } catch (error) {
              res.statusCode = 400;
              res.end(String(error));
            }
          });
          return;
        }
        next();
      });
    },
    generateBundle() {
      const ids = playIds();
      this.emitFile({ type: "asset", fileName: "plays/index.json", source: JSON.stringify(ids) });
      for (const id of ids) {
        this.emitFile({ type: "asset", fileName: `plays/${id}.json`, source: fs.readFileSync(path.join(PLAYS_DIR, `${id}.json`)) });
      }
    },
  };
}

// Lighting scenes (src/stage/lighting.ts): the library all plays share, one
// JSON per scene in assets/lights/. Fetched at runtime like the plays, as
// one file with all of them (they are small and all needed at once). Dev:
// PUT writes a scene into assets/lights/, DELETE removes it. Build: the
// combined file goes to dist/lights/index.json.
const LIGHTS_DIR = path.join(ROOT, "assets/lights");

function lightScenes() {
  const scenes: Record<string, unknown> = {};
  if (!fs.existsSync(LIGHTS_DIR)) return scenes;
  for (const file of fs.readdirSync(LIGHTS_DIR).sort()) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!PLAY_ID.test(id)) continue;
    try {
      scenes[id] = JSON.parse(fs.readFileSync(path.join(LIGHTS_DIR, file), "utf8"));
    } catch (error) {
      // One broken file (a hand edit) must not take the others with it
      console.warn(`assets/lights/${file}: ${String(error)}`);
    }
  }
  return scenes;
}

function lights(): Plugin {
  return {
    name: "lights",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (url === "/lights/index.json" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(lightScenes()));
          return;
        }
        const id = url.match(/^\/lights\/([^/]+)\.json$/)?.[1];
        if (!id || (req.method !== "PUT" && req.method !== "DELETE")) return next();
        if (!PLAY_ID.test(id)) {
          res.statusCode = 400;
          res.end("bad lighting scene id");
          return;
        }
        const file = path.join(LIGHTS_DIR, `${id}.json`);
        if (req.method === "DELETE") {
          fs.rmSync(file, { force: true });
          res.statusCode = 204;
          res.end();
          return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const scene = JSON.parse(body);
            if (!scene || typeof scene.values !== "object" || !scene.values) throw new Error("no values");
            fs.mkdirSync(LIGHTS_DIR, { recursive: true });
            fs.writeFileSync(file, `${JSON.stringify(scene, null, 2)}\n`);
            res.statusCode = 204;
            res.end();
          } catch (error) {
            res.statusCode = 400;
            res.end(String(error));
          }
        });
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "lights/index.json", source: JSON.stringify(lightScenes()) });
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
  // Relative: one build works wherever it is served (GitHub Pages under
  // /<repo>/, a custom domain or the root, vite preview); the dev server
  // treats it as "/". Runtime URLs go through import.meta.env.BASE_URL
  // ("./" in a build), which resolves against the page.
  base: "./",
  plugins: [wasmRuntimes(), plays(), lights(), ...(await httpsPlugins(mode))],
  resolve: {
    // One three.js: IWSDK's, also for three/examples/jsm add-ons
    dedupe: ["three"],
  },
  build: {
    target: "es2022", // top-level await in main.ts
    sourcemap: true,
  },
}));
