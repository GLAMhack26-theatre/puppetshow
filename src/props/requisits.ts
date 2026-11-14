import RAPIER from "@dimforge/rapier3d-compat";
import {
  Box3,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  Matrix4,
  type Object3D,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Ray,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  createSystem,
  type Entity,
  type World,
} from "@iwsdk/core";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { catalogueEntry } from "../catalogue";
import { PhysicsLink } from "../components/physics-link";
import { grabbables } from "../puppet/grab";
import { stageBounds } from "../stage/stage";
import { GROUP, physics } from "../systems/rapier-system";
import type { IiifObject } from "./iiif";

// Props ("Requisiten") for the impro mode: every .glb in
// assets/digital.skkg.ch/requisits/ is offered in the left-hand slider. A
// click lowers it onto the stage as if on a string from the fly loft, a
// second click lifts it off again. Placed props can be dragged across the
// floor with the mouse or a finger.
//
// Thumbnail: a picture with the same name next to the .glb (Stuhl.png for
// Stuhl.glb) is used as is, and the model is only downloaded when it is
// picked. Without a picture the model is loaded right away and rendered
// once in a small offscreen renderer, so a new .glb works without any extra
// file.
//
// Label, scale and SKKG source come from assets/catalogue.json.
//
// IIIF: objects from IIIF 3D manifests (props/iiif.ts) are added at runtime
// with addIiifRequisit and then behave like the props from the folder; their
// .glb is loaded from wherever the manifest points (it must allow CORS).
//
// Placement: "best candidate" sampling. Of a few random spots on the floor,
// the one furthest from every prop already standing there wins (distance
// minus both footprints), so new props spread out instead of piling up in
// one place, and there is still some variety.
//
// Physics: each prop is a Rapier body, dynamic while it stands (the puppet
// can bump into it, small ones can be grabbed), kinematic while it is
// lowered, lifted off or dragged.

const FILES = import.meta.glob("../../assets/digital.skkg.ch/requisits/*.glb", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const PICTURES = import.meta.glob("../../assets/digital.skkg.ch/requisits/*.{png,jpg,jpeg,webp}", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Larger models are scaled down to this size (m), for files in other units. */
const MAX_SIZE = 0.5;
/** Props up to this size (m) can be grabbed by the puppet's hands. */
const GRAB_SIZE = 0.1;
/** Keeps props this far (m) from the floor's edges and from the backdrop. */
const MARGIN = 0.03;
const CANDIDATES = 24;
/** Height (m) the prop is lowered from, and how long it takes. */
const DROP = 0.35;
const LOWER_SECONDS = 0.7;
const LIFT_SECONDS = 0.45;
/** A dragged prop hovers this far (m) above the floor. */
const DRAG_LIFT = 0.015;
/** A prop whose centre sinks this far (m) below the floor fell off the stage. */
const FELL_OFF = 0.05;
const THUMB_SIZE = 256;

export interface Requisit {
  id: string;
  /** The .glb to load. */
  url: string;
  /** Applied to the model before it is measured (IIIF annotation transforms). */
  transform?: Matrix4;
  label: string;
  /** Picture for the slider; empty until rendered. */
  thumbnail: string;
  /** Link to the SKKG collection, "ai" for an invented object (assets/catalogue.json). */
  source: string;
  /** Scale shown on the card; may shrink once the model is loaded (MAX_SIZE). */
  scale: number;
  onScale?: (scale: number) => void;
  /** Called when a rendered thumbnail arrives. */
  onThumbnail?: (url: string) => void;
}

interface Placed {
  requisit: Requisit;
  holder: Group;
  entity: Entity;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Footprint radius on the floor (m). */
  radius: number;
  /** Half the height: the body centre stands this high when it is down. */
  halfHeight: number;
  /** Bounding box in holder space, for picking. */
  localBox: Box3;
  /** "lower" 0→1, "lift" 1→0, "drag" follows the pointer, "rest" is dynamic. */
  mode: "lower" | "lift" | "drag" | "rest";
  t: number;
  x: number;
  z: number;
  yaw: number;
}

interface Model {
  object: Object3D;
  size: Vector3;
}

const models = new Map<string, Promise<Model>>();
const placed = new Map<Requisit, Placed>();
let catalogue: Requisit[] | null = null;

/** The props on offer; thumbnails without a picture are rendered one after another. */
export function loadRequisits(): Requisit[] {
  if (catalogue) return catalogue;
  const pictures = new Map(Object.entries(PICTURES).map(([path, url]) => [baseName(path), url]));
  catalogue = Object.entries(FILES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, url]) => {
      const id = baseName(path);
      const picture = pictures.get(id) ?? "";
      const entry = catalogueEntry("requisits", id);
      return {
        id,
        url,
        // "Stuhl_25210.6" → "Stuhl": the SKKG inventory number is left off the card
        label: entry.label ?? id.replace(/_[\d.]+$/, "").replaceAll("_", " "),
        thumbnail: picture,
        source: entry.source ?? "",
        scale: entry.scale ?? 1,
      };
    });
  const missing = catalogue.filter((r) => !r.thumbnail);
  if (missing.length) {
    // In sequence, so a dozen large scans do not all download at once
    void (async () => {
      const thumbs = new ThumbnailRenderer();
      for (const requisit of missing) {
        try {
          requisit.thumbnail = thumbs.render((await loadModel(requisit)).object);
          requisit.onThumbnail?.(requisit.thumbnail);
        } catch (error) {
          console.warn(`Requisit ${requisit.id}: no thumbnail`, error);
        }
      }
      thumbs.dispose();
    })();
  }
  return catalogue;
}

/** Adds an object from a IIIF manifest to the props on offer (once per manifest). */
export function addIiifRequisit(object: IiifObject): Requisit {
  const all = loadRequisits();
  const id = `iiif:${object.id}`;
  const known = all.find((r) => r.id === id);
  if (known) return known;
  const requisit: Requisit = {
    id,
    url: object.model,
    transform: object.transform,
    label: object.label,
    thumbnail: object.thumbnail,
    source: object.homepage,
    scale: 1, // IIIF models are in metres: real size next to the 0.35 m puppet
  };
  all.push(requisit);
  if (!requisit.thumbnail) {
    void loadModel(requisit).then((model) => {
      const thumbs = new ThumbnailRenderer();
      requisit.thumbnail = thumbs.render(model.object);
      thumbs.dispose();
      requisit.onThumbnail?.(requisit.thumbnail);
    });
  }
  return requisit;
}

let loader: GLTFLoader | null = null;
function gltfLoader() {
  if (!loader) {
    // Draco only for IIIF models (DaSCH previews are Draco-compressed); the
    // decoder is served from three's own copy by vite.config.ts
    const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    loader = new GLTFLoader().setDRACOLoader(draco);
  }
  return loader;
}

function baseName(path: string) {
  return path.split("/").pop()!.replace(/\.[^.]+$/, "");
}

/** Loads a model once, scaled to metres and centred on its bounding box. */
function loadModel(requisit: Requisit): Promise<Model> {
  const id = requisit.id;
  let model = models.get(id);
  if (!model) {
    model = gltfLoader().loadAsync(requisit.url).then((gltf) => {
      // Wrapped, so the transform stays apart from the scale and centring below
      const object = new Group();
      if (requisit.transform) gltf.scene.applyMatrix4(requisit.transform);
      object.add(gltf.scene);
      object.scale.setScalar(requisit.scale);
      object.updateMatrixWorld(true);
      let box = new Box3().setFromObject(object);
      const largest = Math.max(...box.getSize(new Vector3()).toArray());
      if (largest > MAX_SIZE) {
        console.warn(`Requisit ${id} is ${largest.toFixed(2)} m, scaled down to ${MAX_SIZE} m (set its scale in assets/catalogue.json)`);
        object.scale.multiplyScalar(MAX_SIZE / largest);
        requisit.scale = object.scale.x;
        requisit.onScale?.(requisit.scale);
        object.updateMatrixWorld(true);
        box = new Box3().setFromObject(object);
      }
      object.position.sub(box.getCenter(new Vector3()));
      object.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      return { object, size: box.getSize(new Vector3()) };
    });
    models.set(id, model);
  }
  return model;
}

export function isPlaced(requisit: Requisit) {
  const p = placed.get(requisit);
  return !!p && p.mode !== "lift";
}

/** Lowers the prop onto a free spot, or lifts it off again if it stands there. */
export async function toggleRequisit(world: World, requisit: Requisit) {
  const existing = placed.get(requisit);
  if (existing) {
    if (existing.mode === "lift") existing.mode = "lower";
    else liftOff(existing);
    return;
  }
  const model = await loadModel(requisit);
  if (placed.has(requisit)) return; // clicked twice while loading
  const { size } = model;
  const radius = Math.hypot(size.x, size.z) / 2;
  const spot = freeSpot(radius);
  const yaw = (Math.random() - 0.5) * 0.6; // a little askew, like set down by hand

  const holder = new Group();
  holder.name = requisit.id;
  holder.add(model.object); // the model is reused when it is picked again

  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spot.x, size.y / 2 + DROP, spot.y)
      .setRotation(yawQuat(yaw))
      .setCcdEnabled(true),
  );
  // Low density: the box is much bigger than the wood, and props must stay light against a 0.15 kg puppet
  const collider = physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setDensity(80).setCollisionGroups(GROUP.prop),
    body,
  );
  const entity = world.createTransformEntity(holder);
  entity.addComponent(PhysicsLink, { body: body.handle });

  const p: Placed = {
    requisit,
    holder,
    entity,
    body,
    collider,
    radius,
    halfHeight: size.y / 2,
    localBox: new Box3().setFromCenterAndSize(new Vector3(), size),
    mode: "lower",
    t: 0,
    x: spot.x,
    z: spot.y,
    yaw,
  };
  placed.set(requisit, p);
  if (Math.max(size.x, size.y, size.z) <= GRAB_SIZE) grabbables.push({ name: requisit.id, body, collider });
}

function liftOff(p: Placed) {
  // Lifts from wherever it stands now (it may have been pushed)
  const at = p.body.translation();
  p.x = at.x;
  p.z = at.z;
  p.yaw = yawOf(p.body.rotation());
  setKinematic(p);
  p.mode = "lift";
  p.t = Math.min(1, Math.max(0, 1 - (at.y - p.halfHeight) / DROP));
}

function remove(p: Placed) {
  const index = grabbables.findIndex((g) => g.body === p.body);
  if (index >= 0) grabbables.splice(index, 1);
  physics.world.removeRigidBody(p.body);
  // Keep the model's geometry and textures: it is reused when picked again
  p.entity.dispose({ disposeResources: false });
  p.holder.removeFromParent();
  placed.delete(p.requisit);
}

/** Best candidate: the random spot with the most room around it. */
function freeSpot(radius: number, self?: Placed) {
  const b = floor(radius);
  const others = [...placed.values()].filter((p) => p !== self && p.mode !== "lift");
  let best = new Vector2((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
  let bestScore = -Infinity;
  for (let i = 0; i < CANDIDATES; i++) {
    const c = new Vector2(b.minX + Math.random() * (b.maxX - b.minX), b.minZ + Math.random() * (b.maxZ - b.minZ));
    let score = Infinity;
    for (const o of others) {
      const at = o.body.translation();
      score = Math.min(score, Math.hypot(c.x - at.x, c.y - at.z) - o.radius - radius);
    }
    // On an empty stage any spot is free: prefer the middle, a little to the front
    if (others.length === 0) score = -Math.hypot(c.x - stageBounds.centerX, c.y - (b.minZ + b.maxZ * 2) / 3);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** Where the centre of a prop with this footprint may stand. */
function floor(radius: number) {
  const inset = radius + MARGIN;
  const half = stageBounds.width / 2;
  // The front edge of Ground_Box sits under the proscenium: stay behind it
  const minZ = stageBounds.backZ + inset + MARGIN;
  const maxZ = Math.max(minZ, stageBounds.frontZ - inset);
  return {
    minX: stageBounds.centerX - Math.max(0, half - inset),
    maxX: stageBounds.centerX + Math.max(0, half - inset),
    minZ,
    maxZ,
  };
}

function setKinematic(p: Placed) {
  if (p.body.isKinematic()) return;
  p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  // Stand upright again (it may have tipped over)
  p.body.setRotation(yawQuat(p.yaw), true);
}

function setDynamic(p: Placed) {
  p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

const yawQuat = (yaw: number) => new Quaternion().setFromEuler(new Euler(0, yaw, 0));
const yawOf = (r: RAPIER.Rotation) => new Euler().setFromQuaternion(new Quaternion(r.x, r.y, r.z, r.w), "YXZ").y;

export class RequisitSystem extends createSystem({}) {
  update(delta: number) {
    for (const p of placed.values()) {
      if (p.mode === "lower" || p.mode === "lift") {
        const seconds = p.mode === "lower" ? LOWER_SECONDS : LIFT_SECONDS;
        p.t = Math.min(1, Math.max(0, p.t + (p.mode === "lower" ? 1 : -1) * (delta / seconds)));
        // Lowered with a soft landing, a tiny bounce on the string at the end
        const eased = p.t === 1 ? 1 : 1 - (1 - p.t) ** 3 + Math.sin(p.t * Math.PI) * 0.04;
        p.body.setNextKinematicTranslation({ x: p.x, y: p.halfHeight + DROP * (1 - eased), z: p.z });
        if (p.mode === "lower" && p.t === 1) {
          p.mode = "rest";
          setDynamic(p);
        } else if (p.mode === "lift" && p.t === 0) remove(p);
      } else if (p.mode === "drag") {
        p.body.setNextKinematicTranslation({ x: p.x, y: p.halfHeight + DRAG_LIFT, z: p.z });
      } else if (p.body.translation().y < -FELL_OFF) {
        // Knocked off the stage (by a dragged prop or the puppet): let it down again on a free spot
        setKinematic(p);
        const spot = freeSpot(p.radius, p);
        p.x = spot.x;
        p.z = spot.y;
        p.body.setTranslation({ x: p.x, y: p.halfHeight + DROP, z: p.z }, true);
        p.mode = "lower";
        p.t = 0;
      }
    }
  }
}

/**
 * Drag placed props across the stage floor. Listens in the capture phase on
 * the canvas' container, so a press on a prop never reaches the orbit camera.
 */
export function enableRequisitDrag(world: World) {
  const container = world.renderer.domElement.parentElement!;
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const plane = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  const offset = new Vector3();
  let dragged: { p: Placed; pointerId: number } | null = null;

  const setRay = (e: PointerEvent) => {
    const rect = world.renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, world.camera);
  };

  // Picks against each prop's bounding box, not its triangles: the scans
  // have hundreds of thousands, and the box is what one grabs anyway
  const localRay = new Ray();
  const inverse = new Matrix4();
  const at = new Vector3();
  const pick = () => {
    let nearest: Placed | null = null;
    let distance = Infinity;
    for (const p of placed.values()) {
      if (p.mode === "lift") continue;
      inverse.copy(p.holder.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverse);
      if (!localRay.intersectBox(p.localBox, at)) continue;
      const d = at.applyMatrix4(p.holder.matrixWorld).distanceTo(raycaster.ray.origin);
      if (d < distance) {
        distance = d;
        nearest = p;
      }
    }
    return nearest;
  };

  container.addEventListener(
    "pointerdown",
    (e) => {
      if (dragged || e.button !== 0) return;
      setRay(e);
      const p = pick();
      if (!p) return;
      e.stopPropagation();
      e.preventDefault();
      setKinematic(p);
      const t = p.body.translation();
      p.x = t.x;
      p.z = t.z;
      p.mode = "drag";
      // Drag on the horizontal plane through the prop's centre, keeping the
      // spot under the finger where it was grabbed
      plane.constant = -(p.halfHeight + DRAG_LIFT);
      if (raycaster.ray.intersectPlane(plane, hit)) offset.set(t.x - hit.x, 0, t.z - hit.z);
      else offset.set(0, 0, 0);
      dragged = { p, pointerId: e.pointerId };
      container.setPointerCapture(e.pointerId);
      container.style.cursor = "grabbing";
    },
    { capture: true },
  );

  container.addEventListener(
    "pointermove",
    (e) => {
      setRay(e);
      if (!dragged) {
        if (e.pointerType === "mouse") container.style.cursor = pick() ? "grab" : "";
        return;
      }
      if (e.pointerId !== dragged.pointerId) return;
      e.stopPropagation();
      if (!raycaster.ray.intersectPlane(plane, hit)) return;
      const b = floor(dragged.p.radius);
      dragged.p.x = Math.min(b.maxX, Math.max(b.minX, hit.x + offset.x));
      dragged.p.z = Math.min(b.maxZ, Math.max(b.minZ, hit.z + offset.z));
    },
    { capture: true },
  );

  const release = (e: PointerEvent) => {
    if (!dragged || e.pointerId !== dragged.pointerId) return;
    e.stopPropagation();
    const { p } = dragged;
    dragged = null;
    container.style.cursor = "";
    if (p.mode !== "drag") return;
    p.mode = "rest";
    setDynamic(p); // drops the last centimetres onto the floor
  };
  container.addEventListener("pointerup", release, { capture: true });
  container.addEventListener("pointercancel", release, { capture: true });
}

/** Renders models into small transparent pictures for the slider cards. */
class ThumbnailRenderer {
  private renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  private scene = new Scene();
  private camera = new PerspectiveCamera(30, 1, 0.001, 100);

  constructor() {
    this.renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(new HemisphereLight(0xfff4e0, 0x3a2a20, 2.2));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 2, 2);
    this.scene.add(key);
  }

  render(object: Object3D) {
    const parent = object.parent;
    this.scene.add(object);
    const sphere = new Box3().setFromObject(object).getBoundingSphere(new Sphere());
    // From the front, a little from above and to the side, like a visitor in the stalls
    const distance = sphere.radius / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(sphere.center).add(new Vector3(0.45, 0.4, 1).normalize().multiplyScalar(distance));
    this.camera.near = distance / 100;
    this.camera.far = distance * 3;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(sphere.center);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.scene.remove(object);
    parent?.add(object);
    return url;
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
