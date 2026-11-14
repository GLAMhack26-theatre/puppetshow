import { sourceKind } from "../catalogue";

// The round "i" on a slider card: real objects open their page in the SKKG
// collection in a new tab; invented ones ("ai" in assets/catalogue.json)
// show a small popup instead. The popup is a sheet of beige paper with the
// scalloped gold edge of the slider panels and a few printed stars.

/** Click handler for the card's "i", or undefined when there is no source yet (no button). */
export function infoHandler(source: string | undefined): (() => void) | undefined {
  const kind = sourceKind(source);
  if (kind === "link") return () => window.open(source!.trim(), "_blank", "noopener");
  if (kind === "fake") return showFakePopup;
  return undefined;
}

let dialog: HTMLDialogElement | null = null;

function showFakePopup() {
  dialog ??= createDialog();
  dialog.showModal();
  drawPaper(dialog);
}

function createDialog() {
  const d = document.createElement("dialog");
  d.className = "fake-popup";
  d.setAttribute("aria-labelledby", "fake-popup-title");
  d.innerHTML = `
    <div class="fake-popup-paper"></div>
    <svg class="fake-popup-edge" aria-hidden="true"><path class="shadow" transform="translate(-1 3)"/><path class="gold"/></svg>
    <div class="fake-popup-body">
      <p class="fake-popup-kicker">Quelle geprüft</p>
      <h2 id="fake-popup-title">Fake-Objekt gefunden!</h2>
      <p>Gut, dass du die Quellen prüfst. Du hast ein Objekt entdeckt, das mit AI ohne Vorlage aus der SKKG erfunden wurde.</p>
      <button type="button" class="fake-popup-close">Weiter spielen</button>
    </div>`;
  d.querySelector(".fake-popup-close")!.addEventListener("click", () => d.close());
  // A click outside the paper (on the dimmed backdrop) closes it too
  d.addEventListener("click", (e) => e.target === d && d.close());
  document.body.append(d);
  return d;
}

/** Scalloped outline around the dialog, plus a sprinkle of stars on the paper. */
function drawPaper(d: HTMLDialogElement) {
  const w = d.clientWidth;
  const h = d.clientHeight;
  const inset = 8; // room for the bulges inside the dialog box
  const path = scallopPath(inset, inset, w - inset, h - inset, 30);
  const paper = d.querySelector<HTMLElement>(".fake-popup-paper")!;
  paper.style.clipPath = `path('${path}')`;
  const edge = d.querySelector("svg")!;
  edge.setAttribute("width", String(w));
  edge.setAttribute("height", String(h));
  for (const p of edge.querySelectorAll("path")) p.setAttribute("d", path);

  // Stars like on the slider's night sky, printed faintly on the paper
  if (!paper.childElementCount) {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const stars = Array.from({ length: 22 }, () => {
      const s = 3 + rand() * 6;
      const c = ["#c79a4a", "#b5763f", "#d2a95c"][Math.floor(rand() * 3)];
      return `<path d="${STAR}" fill="${c}" transform="translate(${(rand() * w).toFixed(0)} ${(rand() * h).toFixed(0)}) rotate(${(rand() * 72).toFixed(0)}) scale(${s.toFixed(1)})"/>`;
    }).join("");
    paper.innerHTML = `<svg width="${w}" height="${h}" aria-hidden="true">${stars}</svg>`;
  }
}

/** A rectangle whose edges are rows of outward bulges, drawn clockwise. */
function scallopPath(x0: number, y0: number, x1: number, y1: number, step: number) {
  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let d = `M${x0} ${y0}`;
  for (let side = 0; side < 4; side++) {
    const [ax, ay] = corners[side];
    const [bx, by] = corners[(side + 1) % 4];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    const r = (Math.hypot(bx - ax, by - ay) / n) * 0.62;
    for (let k = 1; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n;
      const y = ay + ((by - ay) * k) / n;
      d += ` A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  }
  return `${d} Z`;
}

/** Five-pointed star in a unit circle. */
const STAR = (() => {
  let d = "";
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = k % 2 ? 0.45 : 1;
    d += `${k ? "L" : "M"}${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`;
  }
  return `${d}Z`;
})();
