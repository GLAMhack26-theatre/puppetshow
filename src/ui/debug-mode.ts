// Debug mode: the test links, the debug panel and the HUD are hidden
// unless <body> has the "debug" class (index.html); the camera preview with
// the hand landmarks always stays visible.
// Shift+D toggles it, ?debug switches it on. The state is kept in
// sessionStorage, because the test links reload the page: it survives them
// within the tab, and a new tab starts without it.

const KEY = "puppetshow.debug";

function remembered() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false; // storage blocked (private mode)
  }
}

function setDebug(on: boolean) {
  document.body.classList.toggle("debug", on);
  try {
    sessionStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // storage blocked: the state lasts until the next reload
  }
}

export function setupDebugMode() {
  setDebug(new URLSearchParams(location.search).has("debug") || remembered());
  addEventListener("keydown", (e) => {
    // e.code, not e.key: with Shift held e.key is "D", and on some layouts something else
    if (!e.shiftKey || e.code !== "KeyD" || e.repeat) return;
    setDebug(!document.body.classList.contains("debug"));
  });
}
