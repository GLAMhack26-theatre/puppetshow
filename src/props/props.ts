import RAPIER from "@dimforge/rapier3d-compat";
import { Box3, Group, Vector3, type World } from "@iwsdk/core";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import ballUrl from "../../assets/digital.skkg.ch/Kugel_38896.3.glb?url";
import chairUrl from "../../assets/digital.skkg.ch/Stuhl_25210.6.glb?url";
import bedUrl from "../../assets/digital.skkg.ch/Bett_44012.glb?url";
import { grabbables } from "../puppet/grab";
import { GROUP, addLinked } from "../systems/rapier-system";

// SKKG objects on the stage platform. Chair and bed are doll-house pieces
// at the 0.35 m marionette's real scale; the ball is scaled down to fit a hand.
// The chest (Truhe_46955) is missing: its files were removed (they were empty).

interface PropSpec {
  name: string;
  url: string;
  scale: number;
  /** Floor position (x, z); the prop stands on y = 0 */
  at: [number, number];
  rotationY?: number;
  body: "dynamic" | "fixed";
  density?: number;
  collider: "ball" | "box";
  grabbable?: boolean;
}

// Densities are low: the colliders are bounding boxes, much larger than the
// actual wood, and props must stay light against a 0.15 kg puppet
const PROPS: PropSpec[] = [
  { name: "Kugel", url: ballUrl, scale: 0.2, at: [0.1, 0.06], body: "dynamic", density: 100, collider: "ball", grabbable: true },
  { name: "Stuhl", url: chairUrl, scale: 1, at: [-0.25, 0.03], rotationY: 0.5, body: "dynamic", density: 60, collider: "box" },
  { name: "Bett", url: bedUrl, scale: 1, at: [0.33, -0.15], body: "fixed", collider: "box" },
];

export async function loadProps(world: World) {
  const loader = new GLTFLoader();
  await Promise.all(PROPS.map(async (spec) => {
    const model = (await loader.loadAsync(spec.url)).scene;
    model.scale.setScalar(spec.scale);
    model.rotation.y = spec.rotationY ?? 0;
    model.updateMatrixWorld(true);

    // The body sits at the bounding-box centre; the model is offset inside a holder
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    model.position.sub(center);
    const holder = new Group();
    holder.name = spec.name;
    holder.add(model);

    const desc = spec.body === "fixed" ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
    desc.setTranslation(spec.at[0], size.y / 2, spec.at[1]);
    if (spec.grabbable) desc.setCcdEnabled(true); // thrown props must not tunnel through the floor
    const collider = (spec.collider === "ball"
      ? RAPIER.ColliderDesc.ball(Math.max(size.x, size.y, size.z) / 2)
      : RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
    )
      .setDensity(spec.density ?? 500)
      .setCollisionGroups(GROUP.prop);
    const linked = addLinked(world, holder, desc, collider);
    holder.traverse((o) => (o.receiveShadow = true));
    if (spec.grabbable) grabbables.push({ name: spec.name, body: linked.body, collider: linked.collider! });
  }));
}
