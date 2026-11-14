import { nowPlaying, onTrackChange } from "../audio/ambient";
import { onExcerptChange, playingExcerpt } from "../audio/excerpts";
import { type Channel, isOn, onChannelChange, setOn } from "../audio/audio";
import "./sound-toggle.css";

// Two round buttons at the bottom right, both off at every load: effects in
// the corner (speaker: excerpts, cues, physics sounds), music left of it
// (note: the archive.org playlists). Left of them the credit of what plays
// ("now playing"), linked to its archive.org item; the CC BY licences require
// it whenever their music plays. Below the camera preview (#preview, index.html).

// Line icons in the style of the presentation icons: cream drawing, gold waves or cross
const ICONS: Record<Channel, string> = {
  music: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path class="body" d="M12 23 V8 L24 5 V20"/>
    <ellipse class="body" cx="9.5" cy="23" rx="3" ry="2.4"/><ellipse class="body" cx="21.5" cy="20" rx="3" ry="2.4"/>
    <path class="waves" d="M12 12 L24 9"/>
    <path class="cross" d="M5 5 L27 27"/>
  </svg>`,
  effects: `<svg viewBox="0 0 32 32" aria-hidden="true">
    <path class="body" d="M5 12 H10 L17 6 V26 L10 20 H5 Z"/>
    <path class="waves" d="M21 11.5 A6 6 0 0 1 21 20.5 M24.5 8 A11 11 0 0 1 24.5 24"/>
    <path class="cross" d="M21 12 L28 20 M28 12 L21 20"/>
  </svg>`,
};
const TITLES: Record<Channel, [on: string, off: string]> = {
  music: ["Musik aus", "Musik an"],
  effects: ["Geräusche aus", "Geräusche an"],
};

export function setupSoundToggle() {
  const root = Object.assign(document.createElement("div"), { id: "sound" });
  const credit = Object.assign(document.createElement("a"), {
    className: "sound-credit",
    target: "_blank",
    rel: "noopener",
  });
  root.append(credit);

  const buttons = {} as Record<Channel, HTMLButtonElement>;
  for (const channel of ["music", "effects"] as const) {
    const button = Object.assign(document.createElement("button"), {
      type: "button",
      className: `sound-button ${channel}`,
      innerHTML: ICONS[channel],
    });
    button.addEventListener("click", () => setOn(channel, !isOn(channel)));
    buttons[channel] = button;
    root.append(button);
  }
  document.body.append(root);

  const showButton = (channel: Channel, on: boolean) => {
    const button = buttons[channel];
    button.setAttribute("aria-pressed", String(on));
    button.title = button.ariaLabel = TITLES[channel][on ? 0 : 1];
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

  onChannelChange(showButton);
  onTrackChange(showCredit);
  onExcerptChange(showCredit);
  showButton("music", false);
  showButton("effects", false);
  showCredit();
}
