// ?emu on the dev server: an emulated Quest 3 (IWER), so the WebXR mode can
// be started and scripted on a desktop without a headset. The device is
// reachable as `xrDevice` from the console: move the headset and the
// controllers with xrDevice.position / .quaternion and
// xrDevice.controllers.left|right.position, press buttons with
// .updateButtonValue("squeeze", 1).
// Dev only: the import is dropped from the build. (@iwsdk/vite-plugin-dev,
// which bundles the same emulator with a UI, needs Vite 7.)

/** Before the World is created: three.js looks for the WebXR classes when it starts a session. */
export async function installEmulator() {
  if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("emu")) return;
  const { XRDevice, metaQuest3 } = await import("iwer");
  const xrDevice = new XRDevice(metaQuest3);
  // Desktop Chrome has a navigator.xr of its own (without a headset): ?emu asks for the emulated one
  xrDevice.installRuntime({ forceInstall: true });
  Object.assign(globalThis, { xrDevice });
}
