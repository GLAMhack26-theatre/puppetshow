import { nowPlaying, onTrackChange } from "../audio/ambient";
import { onExcerptChange, playingExcerpt } from "../audio/excerpts";
import { isSoundOn, onSoundChange, setSoundOn } from "../audio/audio";
import "./sound-toggle.css";

// The speaker button at the bottom right, off at every load, and to its
// left the credit of the track playing ("now playing"), linked to its
// archive.org item. The credit is required by the CC BY licences, so it is
// shown whenever music plays. Below the camera preview (#preview, index.html).

// Line icon in the style of the presentation icons: cream speaker, gold waves or cross
const SPEAKER = `<svg viewBox="0 0 32 32" aria-hidden="true">
  <path class="body" d="M5 12 H10 L17 6 V26 L10 20 H5 Z"/>
  <path class="waves" d="M21 11.5 A6 6 0 0 1 21 20.5 M24.5 8 A11 11 0 0 1 24.5 24"/>
  <path class="cross" d="M21 12 L28 20 M28 12 L21 20"/>
</svg>`;

export function setupSoundToggle() {
  const root = Object.assign(document.createElement("div"), { id: "sound" });
  const credit = Object.assign(document.createElement("a"), {
    className: "sound-credit",
    target: "_blank",
    rel: "noopener",
  });
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    className: "sound-button",
    innerHTML: SPEAKER,
  });
  root.append(credit, button);
  document.body.append(root);

  const showButton = (on: boolean) => {
    button.setAttribute("aria-pressed", String(on));
    button.title = button.ariaLabel = on ? "Ton aus" : "Ton an";
  };
  // An excerpt playing is credited before the background music
  const showCredit = () => {
    const track = playingExcerpt() ?? nowPlaying();
    credit.hidden = !track;
    if (!track) return;
    credit.href = track.url;
    credit.textContent = `${track.title} · ${track.creator} · ${track.licence}`;
    credit.title = `Läuft gerade, auf archive.org: ${credit.textContent}`;
  };

  button.addEventListener("click", () => setSoundOn(!isSoundOn()));
  onSoundChange(showButton);
  onTrackChange(showCredit);
  onExcerptChange(showCredit);
  showButton(false);
  showCredit();
}
