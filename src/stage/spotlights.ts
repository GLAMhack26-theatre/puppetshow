import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SpotLight,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";

// Follow spots: every puppet on the stage gets its own spotlight that tracks
// it. As in a real theatre they hang on a bar out in front of the stage,
// above the audience, and add a pool of focus light to the stage already lit
// by the rest of the lighting rig (lighting.ts), whose scenes also set their look.

/**
 * The lighting bar: height and distance in front of the stage (floor top y = 0,
 * stage centre z = 0). Far and low enough that the beam comes in under the
 * top of the proscenium opening, and above the camera's view.
 */
const BAR_Y = 1.2;
const BAR_Z = 1.6;
const BAR_HALF_WIDTH = 1.1;
/** Where the spots hang on the bar (x), in the order puppets arrive: off-centre first, for some modelling shadow */
const SLOTS_X = [-0.5, 0.5, 0, -0.9, 0.9];
/** The lens hangs this far below the bar */
const DROP = 0.1;

/** The drawn beam ends this far past the puppet, in beam lengths: about where it meets the floor */
const BEAM_PAST = 1.2;
/** How fast the beam catches up with its puppet, 1/s: a slight lag, like a spot operator */
const FOLLOW = 6;
/** Shadow maps are costly on phones: only the first spot casts shadows there */
const MAX_SHADOW_SPOTS = matchMedia("(pointer: coarse)").matches ? 1 : 3;

// The look of the spots: set by the lighting scene (lighting.ts, its "profile
// spot" group) and changed from the light desk; these are only the values
// until the lighting is set up. Kept here for spots hung up later.
const look = {
  color: new Color(0xfff1d6),
  /** cd; about 1.9 m to the puppet */
  intensity: 14,
  /** Half the beam angle, rad */
  angle: 0.15,
  /** 0: hard edge … 1: soft all the way to the centre */
  penumbra: 0.25,
  /** Brightness of the drawn beam (the haze in the air); 0 for none */
  beam: 0.1,
};

interface FollowSpot {
  slot: number;
  light: SpotLight;
  fixture: Group;
  beam: Mesh;
  /** Writes the point to light (world space) into `out` */
  aim: (out: Vector3) => void;
  /** Aimed at the puppet right away, without swinging in from the last place */
  settled: boolean;
}

const spots: FollowSpot[] = [];
let bar: Mesh | null = null;
const metal = new MeshStandardMaterial({ color: 0x151515, roughness: 0.6, metalness: 0.6 });
/** One for all fixtures: the lenses glow in the colour of the light */
const lensMaterial = new MeshBasicMaterial({ color: look.color });

// The beam in the air, as stage haze shows it: a cone that only adds light.
// Rendering only; it fades towards its rim (seen edge-on) and its far end, so
// no hard cone outline shows. Unit length along +z from the lens and unit
// radius at its far end, scaled to the distance and the beam angle each frame.
const beamGeometry = new ConeGeometry(1, 1, 32, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2);
const beamMaterial = new ShaderMaterial({
  uniforms: { uColor: { value: look.color.clone() }, uOpacity: { value: look.beam } },
  vertexShader: /* glsl */ `
    varying float vAlong; // 1 at the lens, 0 at the far end
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      vAlong = uv.y;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalMatrix * normal;
      vView = -mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vView;
    void main() {
      float facing = abs(dot(normalize(vNormal), normalize(vView)));
      float alpha = uOpacity * facing * facing * smoothstep(0.0, 0.35, vAlong) * mix(0.5, 1.0, vAlong);
      gl_FragColor = vec4(uColor * alpha, 1.0);
    }`,
  blending: AdditiveBlending,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
});
const goal = new Vector3();

/**
 * Hangs a new spot on the bar; it follows whatever `aim` returns each frame
 * (a puppet's chest). remove() takes it down again when the puppet leaves.
 */
export function addFollowSpot(world: World, aim: (out: Vector3) => void) {
  if (!bar) {
    bar = new Mesh(new CylinderGeometry(0.012, 0.012, BAR_HALF_WIDTH * 2, 8), metal);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, BAR_Y, BAR_Z);
    world.scene.add(bar);
  }

  // The first free place on the bar; more spots than places share them
  let slot = 0;
  while (spots.some((s) => s.slot === slot)) slot++;
  const position = new Vector3(SLOTS_X[slot % SLOTS_X.length], BAR_Y - DROP, BAR_Z);

  const light = new SpotLight(look.color, look.intensity, 6, look.angle, look.penumbra, 2);
  light.position.copy(position);
  if (spots.filter((s) => s.light.castShadow).length < MAX_SHADOW_SPOTS) {
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.5;
    light.shadow.camera.far = 4;
    light.shadow.bias = -0.0005; // small scene: avoid shadow acne on the puppet
  }

  const fixture = createFixture();
  fixture.position.copy(position);
  const beam = new Mesh(beamGeometry, beamMaterial);
  beam.visible = look.beam > 0;
  fixture.add(beam);
  world.scene.add(light, light.target, fixture);
  const spot: FollowSpot = { slot, light, fixture, beam, aim, settled: false };
  spots.push(spot);

  return {
    light,
    remove() {
      spots.splice(spots.indexOf(spot), 1);
      world.scene.remove(light, light.target, fixture);
      light.dispose();
    },
  };
}

/** Sets the look of all follow spots (a lighting scene, or a step of the fade between two). */
export function setSpotLook(color: Color, intensity: number, angle: number, penumbra: number, beam: number) {
  look.color.copy(color);
  Object.assign(look, { intensity, angle, penumbra, beam });
  lensMaterial.color.copy(color);
  beamMaterial.uniforms.uColor.value.copy(color);
  beamMaterial.uniforms.uOpacity.value = beam;
  for (const spot of spots) {
    spot.light.color.copy(color);
    Object.assign(spot.light, { intensity, angle, penumbra });
    spot.beam.visible = beam > 0;
  }
}

// A small theatre spot: a can with a glowing lens, on a hanger from the bar.
// Its +z is the beam, so lookAt() aims it.
function createFixture() {
  const fixture = new Group();
  const can = new Mesh(new CylinderGeometry(0.03, 0.038, 0.11, 16), metal);
  can.rotation.x = -Math.PI / 2; // the wide end (bottom) to the front
  can.position.z = -0.055;
  const lens = new Mesh(new CircleGeometry(0.032, 16), lensMaterial);
  lens.position.z = 0.001;
  fixture.add(can, lens);
  return fixture;
}

export class SpotlightSystem extends createSystem({}) {
  update(delta: number) {
    for (const spot of spots) {
      spot.aim(goal);
      const target = spot.light.target.position;
      if (spot.settled) target.lerp(goal, 1 - Math.exp(-FOLLOW * delta));
      else target.copy(goal);
      spot.settled = true;
      spot.fixture.lookAt(target);
      const length = spot.fixture.position.distanceTo(target) * BEAM_PAST;
      const radius = Math.tan(look.angle) * length;
      spot.beam.scale.set(radius, radius, length);
    }
  }
}
