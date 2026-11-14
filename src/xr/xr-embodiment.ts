import { InputComponent, Quaternion, Vector3, createSystem } from "@iwsdk/core";
import { controlInput, type ControlSource } from "../input/control-input";
import { bodyDrives, type BodyDrive } from "../puppet/body-drive";
import { stageFloor } from "../stage/stage";

// WebXR: the player is the marionette. The view comes from the puppet's eyes
// at the puppet's size, and the player's head and hands (6DoF) are the
// puppet's: this system writes them to ControlInput.body, and
// puppet/body-drive.ts moves the puppet.
//
// The puppet stays as it is (0.35 m: its rig only works at scale 1); the
// player is shrunk instead. IWSDK's XR origin (world.player) carries the
// camera and the hand spaces, and three.js applies its transform and scale
// to both eyes, so scaling the origin by puppet eye height / player eye
// height makes the 1.4 m stage as large as a room. The camera always stays on
// the tracked head; the puppet's head follows it, never the other way round.

/** Assumed when the headset gives no height above the floor (reference space "local"), m. */
const DEFAULT_EYE_HEIGHT = 1.6;
/** Head heights taken as standing or sitting on the floor the headset knows, m. */
const EYE_HEIGHT_RANGE = [0.9, 2.1];
/** Eye height of the puppet when there is none on stage (?test=world), m. */
const PUPPET_EYE_HEIGHT = 0.32;
/** Place the player after this many frames even without a head pose. */
const MAX_WAIT_FRAMES = 30;

const SIDES = ["left", "right"] as const;
const UP = new Vector3(0, 1, 0);
/** The camera looks along −z, the puppet's rest pose faces +z; the same half turn fits the hands (WebXR grip space: −z along the thumb). */
const HALF_TURN = new Quaternion(0, 1, 0, 0);

const listeners: Array<(active: boolean) => void> = [];
/** Called when an XR session starts (true) and ends (false). */
export function onXrSession(listener: (active: boolean) => void) {
  listeners.push(listener);
}

export class XrEmbodimentSystem extends createSystem({}) {
  private active = false;
  private placed = false;
  private frames = 0;
  private drive?: BodyDrive;
  private previousSource: ControlSource = "mouse";
  private previousFar = 0;
  private sideways = new Vector3();

  init() {
    // The renderer's events, not world.session: IWSDK sets that only after the session has started
    const xr = this.world.renderer.xr;
    xr.addEventListener("sessionstart", () => this.enter());
    xr.addEventListener("sessionend", () => this.leave());
  }

  private enter() {
    this.active = true;
    this.placed = false;
    this.frames = 0;
    this.previousSource = controlInput.source;
    this.previousFar = this.camera.far;
    // Nothing to point at: the hands are the puppet's
    for (const side of SIDES) this.input.xr.multiPointers[side].toggleSubPointer("ray", false);
    for (const listener of listeners) listener(true);
  }

  private leave() {
    this.active = false;
    const body = controlInput.body;
    body.active = false;
    for (const side of SIDES) {
      body.hands[side].tracked = false;
      controlInput.grip[side] = false;
    }
    controlInput.source = this.previousSource;
    // IWSDK restores the camera, not the origin it hangs on
    this.player.position.set(0, 0, 0);
    this.player.quaternion.identity();
    this.player.scale.setScalar(1);
    this.camera.far = this.previousFar;
    this.camera.updateProjectionMatrix();
    this.drive?.setFirstPerson(false);
    for (const listener of listeners) listener(false);
  }

  /**
   * Shrinks the player to the puppet's size and stands them where the puppet
   * is, facing the audience: once, when the first head pose is there.
   */
  private place() {
    const origin = this.player;
    const head = origin.head;
    const drive = (this.drive = bodyDrives[0]);
    const height = head.position.y;
    const onFloor = height >= EYE_HEIGHT_RANGE[0] && height <= EYE_HEIGHT_RANGE[1];
    const puppetEye = drive?.eyeHeight ?? PUPPET_EYE_HEIGHT;
    const scale = puppetEye / (onFloor ? height : DEFAULT_EYE_HEIGHT);

    // Turn the room so that the way the player faces now is towards the
    // audience (+z). Their turn comes from the head's sideways axis: where the
    // face points has no direction when they look straight up or down.
    this.sideways.set(1, 0, 0).applyQuaternion(head.quaternion);
    origin.quaternion.setFromAxisAngle(UP, Math.PI - Math.atan2(-this.sideways.z, this.sideways.x));
    origin.scale.setScalar(scale);

    // The player's head over the puppet's, wherever the player stands in the
    // room; the puppet's standing eye height at the player's current head height
    const floor = stageFloor.isEmpty() ? 0 : stageFloor.max.y;
    const eye = drive ? drive.eye(new Vector3()) : new Vector3();
    const offset = new Vector3(head.position.x, 0, head.position.z).applyQuaternion(origin.quaternion).multiplyScalar(scale);
    origin.position.set(eye.x - offset.x, floor + puppetEye - scale * height, eye.z - offset.z);

    // Clip distances are in the player's metres: keep the far plane where it was on stage
    this.camera.far = this.previousFar / scale;
    drive?.setFirstPerson(true);
    this.placed = true;
  }

  update() {
    if (!this.active) return;
    const xr = this.input.xr;
    // The player sees the puppet's hands, not controllers. IWSDK shows its
    // models again every frame (its input system runs before this one).
    for (const side of SIDES) {
      for (const kind of ["controller", "hand"] as const) {
        const model = xr.visualAdapters[kind][side].visual?.model;
        if (model) model.visible = false;
      }
    }

    const origin = this.player;
    if (!this.placed) {
      const frame = this.world.xrFrame;
      const space = this.world.xrReferenceSpace;
      const posed = !!(frame && space && frame.getViewerPose(space));
      if (!posed && ++this.frames < MAX_WAIT_FRAMES) return;
      this.place();
    }
    // The spaces were posed before the origin was placed (this frame only) or moved
    origin.updateMatrixWorld(true);

    // world.player.head, not the camera: the camera gets this frame's pose only when rendering
    const body = controlInput.body;
    origin.head.getWorldPosition(body.head.position);
    origin.head.getWorldQuaternion(body.head.rotation).multiply(HALF_TURN);
    for (const side of SIDES) {
      const hand = body.hands[side];
      hand.tracked = !!xr.getPrimaryInputSource(side);
      if (hand.tracked) {
        // Grip space: the palm, for controllers and tracked hands alike
        const grip = origin.gripSpaces[side];
        grip.getWorldPosition(hand.position);
        grip.getWorldQuaternion(hand.rotation).multiply(HALF_TURN);
      }
      // Squeeze or trigger closes the puppet's hand; with tracked hands, a pinch
      const pad = xr.gamepads[side];
      const closed = pad
        ? pad.getButtonPressed(InputComponent.Squeeze) || pad.getButtonPressed(InputComponent.Trigger)
        : xr.getSelectState(side).active;
      controlInput.grip[side] = hand.tracked && closed;
    }
    body.active = true;
    controlInput.source = "xr-6dof";
  }
}
