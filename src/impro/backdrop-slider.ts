// The backdrop picker as a paper-theatre slider: a starry night sky with a
// scalloped gold edge on the right of the screen, and the backdrops as paper
// cards that travel along a curve while the list scrolls. The card in the
// middle bulges out furthest and is the biggest; cards tilt along the curve
// and fade out at the top and bottom. Scrolling is native (wheel, touch),
// the cards are only positioned from scrollTop.
//
// The same slider serves the props on the left side: `mirror` flips the
// whole slider with CSS and flips every card back, so the layout code only
// ever thinks in the right-hand version.
//
// An item with `drop` is a drop field instead of a picture card (the IIIF
// card at the end of the props): it takes things dragged onto it, or
// anywhere onto the open slider, and lights up while something hovers.

/** Tune the look here; there is deliberately no settings UI. */
const SLIDER = {
  /** How far the middle card bulges to the left, as a share of the panel width. */
  bend: 0.2,
  /** Tilt along the curve (0 = upright, 1 = follows the curve). */
  tilt: 1,
  /** Extra size of the middle card (0.3 = 30 % bigger). */
  boost: 0.3,
  /** Vertical spacing between cards (1 = default). */
  gap: 1.5,
  /** Card width as a share of the panel width, capped in px. */
  cardWidth: 0.36,
  cardWidthMax: 170,
  /** Card height relative to its width. */
  cardAspect: 1.2,
};

/** Parallax of the two star layers, as a share of the scroll distance. */
const FAR = 0.06;
const NEAR = 0.14;
const STAR_COLOURS = ["#e9895a", "#f0a15f", "#d9774a", "#f2b36c"];

export interface SliderItem {
  label: string;
  thumbnail: string;
  /** Small line under the label, e.g. the scale. */
  caption?: string;
  /** Shows a round "i" on the card's outer side; called on a click. */
  onInfo?: () => void;
  /** Makes the card a drop field; called with what was dropped. */
  drop?: (data: DataTransfer) => void;
}

export interface Slider {
  /** Root element: fills the panel. */
  root: HTMLElement;
  /** Replaces the cards; `onPick(i)` fires on a click. */
  setItems(items: SliderItem[], onPick: (index: number) => void): void;
  /** Swaps the image of one card (thumbnails that are rendered later). */
  setThumbnail(index: number, thumbnail: string): void;
  /** Swaps the line under the label. */
  setCaption(index: number, caption: string): void;
  /** Marks the chosen cards. */
  setSelected(isSelected: (index: number) => boolean): void;
  /** Re-measures the panel (on open and on resize). */
  layout(): void;
}

export function createSlider({ mirror = false } = {}): Slider {
  const root = div(mirror ? "slider slider-mirrored" : "slider");
  // Flips each card back inside the mirrored slider, so text and images read normally
  const unflip = mirror ? " scaleX(-1)" : "";
  const clip = div("slider-clip");
  const scroller = div("slider-scroller");
  const stage = div("slider-stage");
  const sky = div("slider-sky");
  const farLayer = div("slider-layer");
  const farDrift = div("slider-drift slider-d1");
  const nearLayer = div("slider-layer");
  const nearDrift = div("slider-drift slider-d2");
  const spacer = div("");
  farLayer.append(farDrift);
  nearLayer.append(nearDrift);
  sky.append(div("slider-skybg"), farLayer, nearLayer, div("slider-grain"));
  stage.append(sky);
  scroller.append(stage, spacer);
  clip.append(scroller);

  const svgNs = "http://www.w3.org/2000/svg";
  const edge = document.createElementNS(svgNs, "svg");
  edge.classList.add("slider-edge");
  edge.setAttribute("aria-hidden", "true");
  const edgeShadow = document.createElementNS(svgNs, "path");
  edgeShadow.setAttribute("class", "slider-edge-shadow");
  edgeShadow.setAttribute("transform", "translate(-2 3)");
  const edgeGold = document.createElementNS(svgNs, "path");
  edgeGold.setAttribute("class", "slider-edge-gold");
  edge.append(edgeShadow, edgeGold);
  root.append(clip, edge);

  let cards: HTMLElement[] = [];
  let dropCard: { card: HTMLElement; index: number; drop: (data: DataTransfer) => void } | null = null;
  let W = 0;
  let H = 0;
  let cardW = 0;
  let cardH = 0;
  let step = 0;
  let bend = 0;

  // Curve of the card centres: u is -1 at the top, 0 in the middle, 1 at the bottom
  const f = (u: number) => 1 - u * u;
  const anchorX = () => W - cardW * 0.5 - 10;
  const centerX = (u: number) => anchorX() - bend * f(u);
  const angleAt = (u: number) => Math.atan((bend * 2 * u) / (H * 0.5)) * SLIDER.tilt;
  // The sky edge keeps clear of the (scaled, tilted) cards
  const edgeX = (u: number) => {
    const sc = 1 + SLIDER.boost * Math.max(0, f(u));
    return centerX(u) - (cardW / 2) * sc - Math.abs(Math.sin(angleAt(u))) * cardH * 0.5 * sc - 26;
  };

  // Scalloped edge, like the cut edge of a paper backdrop
  function drawSky() {
    const y0 = -0.1 * H;
    const y1 = 1.1 * H;
    const scallop = Math.max(34, Math.min(56, W * 0.12));
    const n = Math.ceil(((y1 - y0) / scallop) * 1.08);
    const pts: [number, number][] = [];
    for (let k = 0; k <= n; k++) {
      const y = y0 + ((y1 - y0) * k) / n;
      pts.push([edgeX((y - H * 0.5) / (H * 0.5)), y]);
    }
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let j = 1; j < pts.length; j++) {
      const r = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]) * 0.58;
      d += ` A${r.toFixed(1)} ${r.toFixed(1)} 0 0 0 ${pts[j][0].toFixed(1)} ${pts[j][1].toFixed(1)}`;
    }
    const fill = `${d} L${W + 30} ${y1.toFixed(1)} L${W + 30} ${y0.toFixed(1)} Z`;
    // Clipping the whole scroller (not just the sky) leaves the stage
    // left of the edge clickable while the panel is open
    clip.style.clipPath = `path('${fill}')`;
    edge.setAttribute("width", String(W));
    edge.setAttribute("height", String(H));
    edgeGold.setAttribute("d", d);
    edgeShadow.setAttribute("d", d);
  }

  function buildLayer(
    layer: HTMLElement,
    drift: HTMLElement,
    factor: number,
    density: number,
    rMin: number,
    rMax: number,
    alpha: number,
    seed: number,
    dots: boolean,
  ) {
    const rand = rng(seed);
    const maxScroll = step * Math.max(0, cards.length - 1);
    const lh = Math.ceil(H + maxScroll * factor + 60);
    layer.style.height = `${lh}px`;
    drift.style.height = `${lh}px`;
    const count = Math.floor((W * 0.85 * lh) / density);
    const buckets: string[][] = [[], [], []];
    for (let k = 0; k < count; k++) {
      const x = W * 0.15 + rand() * W * 0.9;
      const y = rand() * lh;
      const s = rMin + rand() * (rMax - rMin);
      const rot = (rand() * 72 - 36).toFixed(0);
      const c = STAR_COLOURS[Math.floor(rand() * STAR_COLOURS.length)];
      const b = rand() < 0.55 ? 0 : rand() < 0.5 ? 1 : 2;
      buckets[b].push(
        `<path d="${STAR}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot}) scale(${s.toFixed(2)})" fill="${c}"/>`,
      );
    }
    if (dots) {
      for (let m = 0; m < Math.floor(count * 0.8); m++) {
        buckets[m % 3].push(
          `<circle cx="${(W * 0.15 + rand() * W * 0.9).toFixed(1)}" cy="${(rand() * lh).toFixed(1)}" r="${(0.8 + rand() * 0.9).toFixed(1)}" fill="#f3e6c8" opacity=".6"/>`,
        );
      }
    }
    // Three groups twinkle out of phase
    const twinkle = ["", "slider-twA", "slider-twB"];
    drift.innerHTML = buckets
      .map(
        (stars, q) =>
          `<svg class="${twinkle[q]}" width="${W}" height="${lh}" style="opacity:${alpha}" aria-hidden="true">${stars.join("")}</svg>`,
      )
      .join("");
  }

  function layout() {
    W = root.clientWidth;
    H = root.clientHeight;
    if (!W || !H) return;
    bend = SLIDER.bend * W;
    cardW = Math.min(SLIDER.cardWidthMax, W * SLIDER.cardWidth);
    cardH = cardW * SLIDER.cardAspect;
    step = cardH * 0.95 * SLIDER.gap + 14;
    spacer.style.height = `${step * Math.max(0, cards.length - 1)}px`;
    for (const card of cards) {
      card.style.width = `${cardW}px`;
      card.style.height = `${cardH}px`;
    }
    drawSky();
    buildLayer(farLayer, farDrift, FAR, 9000, 3, 6, 0.6, 7, true);
    buildLayer(nearLayer, nearDrift, NEAR, 30000, 7, 12, 1, 21, false);
    update();
  }

  function update() {
    const s = scroller.scrollTop;
    farLayer.style.transform = `translate3d(0,${(-s * FAR).toFixed(1)}px,0)`;
    nearLayer.style.transform = `translate3d(0,${(-s * NEAR).toFixed(1)}px,0)`;
    cards.forEach((card, i) => {
      const y = H * 0.5 + i * step - s;
      const u = (y - H * 0.5) / (H * 0.5);
      if (Math.abs(u) > 1.4) {
        card.style.visibility = "hidden";
        return;
      }
      card.style.visibility = "visible";
      const angle = (angleAt(u) * 180) / Math.PI;
      const scale = 1 + SLIDER.boost * Math.max(0, f(u)) - 0.25 * Math.min(1, Math.max(0, u * u - 1) * 3);
      const opacity = Math.max(0, 1 - Math.max(0, Math.abs(u) - 1.05) * 3);
      card.style.transform = `translate3d(${(centerX(u) - cardW / 2).toFixed(1)}px,${(y - cardH / 2).toFixed(1)}px,0) rotate(${angle.toFixed(2)}deg) scale(${scale.toFixed(3)})${unflip}`;
      card.style.opacity = opacity.toFixed(2);
      card.style.zIndex = String(Math.round(100 - Math.abs(u) * 50));
    });
  }

  let ticking = false;
  scroller.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        update();
        ticking = false;
      });
    },
    { passive: true },
  );
  window.addEventListener("resize", layout);

  // Dragging over the slider brings the drop field to the middle and lights it up
  let dragDepth = 0;
  const setHover = (on: boolean) => dropCard?.card.classList.toggle("dragover", on);
  root.addEventListener("dragenter", (e) => {
    if (!dropCard) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      centre(dropCard.index);
      setHover(true);
    }
  });
  root.addEventListener("dragover", (e) => {
    if (!dropCard) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  root.addEventListener("dragleave", () => {
    if (dropCard && --dragDepth <= 0) {
      dragDepth = 0;
      setHover(false);
    }
  });
  root.addEventListener("drop", (e) => {
    if (!dropCard || !e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    setHover(false);
    dropCard.drop(e.dataTransfer);
  });

  const centre = (i: number) => scroller.scrollTo({ top: i * step, behavior: "smooth" });

  return {
    root,
    layout,
    setItems(items, onPick) {
      for (const card of cards) card.remove();
      dropCard = null;
      cards = items.map((item, i) => {
        // A card is a positioned frame holding a transparent pick button over
        // the picture and an optional "i" button: buttons cannot be nested
        const card = div("slider-card");
        const image = document.createElement("img");
        if (item.thumbnail) image.src = item.thumbnail;
        image.alt = "";
        image.draggable = false;
        const label = document.createElement("span");
        label.textContent = item.label;
        const caption = document.createElement("small");
        caption.className = "slider-caption";
        caption.textContent = item.caption ?? "";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "slider-pick";
        pick.setAttribute("aria-label", item.label);
        pick.addEventListener("click", () => {
          centre(i);
          onPick(i);
        });
        // Keyboard users tab through the cards; bring the focused one to the middle
        pick.addEventListener("focus", () => centre(i));
        if (item.drop) {
          card.classList.add("slider-drop");
          image.remove();
          const zone = div("slider-drop-zone");
          zone.innerHTML = `<span class="slider-drop-mark">IIIF</span>`;
          card.append(zone, label, caption, pick);
          dropCard = { card, index: i, drop: item.drop };
        } else card.append(image, label, caption, pick);
        if (item.onInfo) {
          const info = document.createElement("button");
          info.type = "button";
          info.className = "slider-info";
          info.textContent = "i";
          info.setAttribute("aria-label", `Quelle: ${item.label}`);
          info.addEventListener("click", item.onInfo);
          card.append(info);
        }
        stage.append(card);
        return card;
      });
      layout();
    },
    setCaption(index, caption) {
      const line = cards[index]?.querySelector(".slider-caption");
      if (line) line.textContent = caption;
    },
    setThumbnail(index, thumbnail) {
      const image = cards[index]?.querySelector("img");
      if (image) image.src = thumbnail;
    },
    setSelected(isSelected) {
      cards.forEach((card, i) => {
        card.classList.toggle("selected", isSelected(i));
        card.querySelector(".slider-pick")!.setAttribute("aria-pressed", String(isSelected(i)));
      });
    },
  };
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

/** Seeded random (mulberry32), so the sky looks the same on every layout. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function div(className: string) {
  const el = document.createElement("div");
  if (className) el.className = className;
  return el;
}
