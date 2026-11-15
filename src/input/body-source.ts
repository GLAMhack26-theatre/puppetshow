import type { BodySeen, FaceKeypoints, ImagePoint, PoseLandmarks } from "./body-frame.ts";

// The body models that run next to the hand landmarker while a session is
// recorded (?record): face detector (BlazeFace short-range), face landmarker
// (mesh and facial transformation matrix) and pose landmarker (lite). Camera
// and DOM side; what they report is a BodySeen (body-frame.ts).
//
// The page imports this file only with ?record, so in play nothing of it is
// downloaded. The hand tracking must not depend on any of it: the models are
// loaded one after another once the hand landmarker runs, each on its own,
// and a model that does not load or throws while running is left out (after
// one more try on the CPU), never passed on to the caller. Whatever subset
// works is recorded.
//
// Every task gets its own canvas and WebGL context: no `canvas` option is
// passed, so MediaPipe makes one per task. A canvas must not be shared
// between tasks (a MediaPipe maintainer: "When you pass us the Canvas, we
// essentially treat it as our own"). The CPU delegate does not save a
// context: MediaPipe makes one per task either way (counted in Chrome: four
// with the hand landmarker, on the GPU as on the CPU). On a device that
// cannot keep that many contexts, fewer models is the way out (?body=face).

export type BodyModel = "face" | "mesh" | "pose";
export type Delegate = "GPU" | "CPU";

/** The model files under /mediapipe/ (scripts/fetch-mediapipe-models.sh) */
const BODY_MODEL_FILES: Record<BodyModel, string> = {
  face: "blaze_face_short_range.tflite",
  mesh: "face_landmarker.task",
  pose: "pose_landmarker_lite.task",
};

/** The ten mesh points that are kept, in the order FaceMesh.points lists them (body-frame.ts) */
const MESH_POINTS = [33, 133, 362, 263, 1, 13, 152, 10, 234, 454];

export interface BodySource {
  /** Settles once every model has loaded or given up: the page is no longer held up by their start */
  loaded: Promise<void>;
  /** Runs every model that has loaded on the video's current frame; undefined while none has. Never throws. */
  detect(video: HTMLVideoElement, timeMs: number): BodySeen | undefined;
  /** The models that run at the moment, with their file and delegate: for the recording's meta */
  running(): Partial<Record<BodyModel, { file: string; delegate: Delegate }>>;
}

export interface BodySourceOptions {
  /** Which models to load, in this order */
  models: BodyModel[];
  /** Do not try the GPU delegate */
  cpuOnly?: boolean;
  /** Called with one status line whenever a model has loaded or failed */
  report(status: string): void;
}

/** As the hand landmarks are rounded: five decimals are far below landmark noise */
const round = (v: number) => Math.round(v * 1e5) / 1e5;
const point = (p: { x: number; y: number }): ImagePoint => [round(p.x), round(p.y)];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 60);

interface Task {
  /** Runs the model on the video's current frame and writes what it saw into `seen` */
  run(video: HTMLVideoElement, timeMs: number, seen: BodySeen): void;
  close(): void;
}

async function fetchModel(model: BodyModel) {
  const response = await fetch(`/mediapipe/${BODY_MODEL_FILES[model]}`);
  // The dev server answers a missing file with the page itself (200, text/html)
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
    throw new Error("model missing (scripts/fetch-mediapipe-models.sh)");
  }
  return response.arrayBuffer();
}

async function createTask(model: BodyModel, delegate: Delegate, file: ArrayBuffer): Promise<Task> {
  const { FilesetResolver, FaceDetector, FaceLandmarker, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  // No `canvas` here on purpose, see the top of the file
  const options = { baseOptions: { modelAssetBuffer: new Uint8Array(file), delegate }, runningMode: "VIDEO" as const };
  switch (model) {
    case "face": {
      const task = await FaceDetector.createFromOptions(fileset, options);
      return {
        close: () => task.close(),
        run(video, timeMs, seen) {
          // The detector's box is in pixels of the frame, its keypoints are normalized already
          const [width, height] = [video.videoWidth, video.videoHeight];
          seen.faces = task.detectForVideo(video, timeMs).detections.map((face): FaceKeypoints => {
            const box = face.boundingBox;
            return {
              kp: face.keypoints.map(point),
              box: box ? [round(box.originX / width), round(box.originY / height), round(box.width / width), round(box.height / height)] : [0, 0, 0, 0],
              score: round(face.categories[0]?.score ?? 0),
            };
          });
        },
      };
    }
    case "mesh": {
      const task = await FaceLandmarker.createFromOptions(fileset, { ...options, numFaces: 1, outputFacialTransformationMatrixes: true });
      return {
        close: () => task.close(),
        run(video, timeMs, seen) {
          const result = task.detectForVideo(video, timeMs);
          const face = result.faceLandmarks[0];
          if (!face) return;
          seen.mesh = {
            matrix: (result.facialTransformationMatrixes[0]?.data ?? []).map(round),
            points: MESH_POINTS.map((i) => point(face[i])),
          };
        },
      };
    }
    case "pose": {
      const task = await PoseLandmarker.createFromOptions(fileset, { ...options, numPoses: 1 });
      return {
        close: () => task.close(),
        run(video, timeMs, seen) {
          seen.poses = task
            .detectForVideo(video, timeMs)
            .landmarks.map((body): PoseLandmarks => ({ lm: body.map((p) => [round(p.x), round(p.y), round(p.z), round(p.visibility ?? 0)]) }));
        },
      };
    }
  }
}

export function createBodySource(options: BodySourceOptions): BodySource {
  const slots = options.models.map((model) => ({
    model,
    file: undefined as ArrayBuffer | undefined,
    task: undefined as Task | undefined,
    delegate: "GPU" as Delegate,
    /** Shown instead of the delegate while there is no task */
    note: "…",
  }));
  type Slot = (typeof slots)[number];
  const report = () => options.report(slots.map((s) => `${s.model} ${s.task ? s.delegate : s.note}`).join(", ") || "off");

  /** Loads one model, on the first delegate that works; never rejects */
  async function load(slot: Slot, delegates: Delegate[]) {
    slot.note = "…";
    report();
    try {
      slot.file ??= await fetchModel(slot.model);
      for (const delegate of delegates) {
        try {
          slot.task = await createTask(slot.model, delegate, slot.file);
          slot.delegate = delegate;
          break;
        } catch (e) {
          console.warn(`Body model "${slot.model}" did not start on the ${delegate}`, e);
          slot.note = `✗ ${message(e)}`;
        }
      }
    } catch (e) {
      console.warn(`Body model "${slot.model}" did not load`, e);
      slot.note = `✗ ${message(e)}`;
    }
    report();
  }

  // One after another: starting a model compiles it on the main thread, which the hand tracking shares
  const loaded = (async () => {
    for (const slot of slots) await load(slot, options.cpuOnly ? ["CPU"] : ["GPU", "CPU"]);
  })();

  return {
    loaded,
    detect(video, timeMs) {
      let seen: BodySeen | undefined;
      for (const slot of slots) {
        const task = slot.task;
        if (!task) continue;
        try {
          task.run(video, timeMs, (seen ??= {}));
        } catch (e) {
          // A task that threw keeps its failed graph: it is dropped, and tried once more on the CPU if it ran on the GPU
          console.warn(`Body model "${slot.model}" failed on the ${slot.delegate}`, e);
          slot.task = undefined;
          try {
            task.close();
          } catch {
            // already gone
          }
          if (slot.delegate === "GPU") void load(slot, ["CPU"]);
          else {
            slot.note = `✗ ${message(e)}`;
            report();
          }
        }
      }
      return seen;
    },
    running() {
      const running: Partial<Record<BodyModel, { file: string; delegate: Delegate }>> = {};
      for (const slot of slots) if (slot.task) running[slot.model] = { file: BODY_MODEL_FILES[slot.model], delegate: slot.delegate };
      return running;
    },
  };
}
