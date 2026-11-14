"""Extract tileable material textures and a landmark-warped face texture from the
SKKG reference photo (photo 3, CC0).

Run with system python (needs numpy, Pillow, opencv):
    python3 tools/extract_textures.py

Outputs PNGs into assets/textures/. The Blender build script consumes them.
All coordinates below are pixel coordinates in the full-resolution photo
assets/digital.skkg.ch/marionettenpuppe-46154.jpg (5011 x 7513).
"""
import os
import json
import numpy as np
import cv2
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets/digital.skkg.ch/marionettenpuppe-46154.jpg")
OUT = os.path.join(ROOT, "assets/textures")
os.makedirs(OUT, exist_ok=True)

photo = cv2.cvtColor(cv2.imread(SRC, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

# --- photometric calibration -------------------------------------------------
# The colour chart at the bottom of the photo is already neutral (R~G~B on the
# grey patches), so only an exposure gain is needed. White patch ~= 0.70 sRGB;
# map it to ~0.85 sRGB so painted whites end up as plausible albedo.
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)

white = photo[7230:7270, 2840:2880].reshape(-1, 3).mean(0)
GAIN = (srgb_to_lin(np.array(0.85)) / srgb_to_lin(white.mean())).item()
print("exposure gain (linear):", round(GAIN, 3))

def calibrated(img):
    return lin_to_srgb(srgb_to_lin(img) * GAIN)

def crop(box):
    x0, y0, x1, y1 = box
    return photo[y0:y1, x0:x1].copy()

def remove_threads(img, thresh=0.22, dilate=4, protect=None):
    """Inpaint thin dark marionette strings lying across a patch."""
    lum = img.mean(2)
    local = cv2.medianBlur((lum * 255).astype(np.uint8), 31).astype(np.float32) / 255
    mask = ((lum < thresh) & (lum < local * 0.6)).astype(np.uint8)
    if protect is not None:
        mask[protect] = 0
    mask = cv2.dilate(mask, np.ones((dilate, dilate), np.uint8))
    u8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)
    return cv2.inpaint(u8, mask * 255, 7, cv2.INPAINT_TELEA).astype(np.float32) / 255

def flatten_lighting(img, sigma_frac=0.25, strength=1.0):
    """Remove large-scale shading (folds, highlights) but keep fine fabric detail."""
    lum = img.mean(2, keepdims=True) + 1e-4
    sigma = max(img.shape[:2]) * sigma_frac
    low = cv2.GaussianBlur(lum, (0, 0), sigma)[..., None] + 1e-4
    flat = img / low * lum.mean()
    return img * (1 - strength) + flat * strength

def make_seamless(img):
    """Cross-fade with a half-period rolled copy -> tiles in both directions."""
    h, w = img.shape[:2]
    rolled = np.roll(np.roll(img, h // 2, 0), w // 2, 1)
    yy = np.abs(np.linspace(-1, 1, h))[:, None]
    xx = np.abs(np.linspace(-1, 1, w))[None, :]
    wgt = np.clip((1 - np.maximum(xx, yy)) * 2.5, 0, 1)[..., None]
    wgt = wgt * wgt * (3 - 2 * wgt)
    return img * wgt + rolled * (1 - wgt)

def save(name, img, size=None):
    img = np.clip(img, 0, 1)
    pil = Image.fromarray((img * 255 + 0.5).astype(np.uint8))
    if size:
        pil = pil.resize(size, Image.LANCZOS)
    path = os.path.join(OUT, name)
    pil.save(path)
    print("wrote", os.path.relpath(path, ROOT), pil.size)

def tileable(name, box, size=(1024, 1024), threads=True, sigma=0.25, strength=1.0, gain=True):
    img = crop(box)
    if threads:
        img = remove_threads(img)
    img = flatten_lighting(img, sigma, strength)
    if gain:
        img = calibrated(img)
    save(name, make_seamless(img), size)

# --- tileable material textures ----------------------------------------------
def fabric_albedo(name, box, size, detail=0.12):
    """Uniform base colour (median of non-highlight pixels) x fine luminance detail.
    Removes fold shading and specular highlights (which also shift chroma)."""
    img = remove_threads(crop(box))
    lum = img.mean(2)
    base = np.median(img[lum < np.percentile(lum, 55)], axis=0)
    low = cv2.GaussianBlur(lum, (0, 0), 6) + 1e-4
    det = np.clip(lum / low, 1 - detail, 1 + detail)[..., None]
    save(name, make_seamless(calibrated(base[None, None, :] * det)), size)

fabric_albedo("satin_pink.png", (1250, 4380, 1850, 4820), (1024, 1024))         # skirt, lower left, clean satin
def tileable_white(name, box, size):
    img = remove_threads(crop(box), thresh=0.55, dilate=7)
    save(name, make_seamless(calibrated(flatten_lighting(img, 0.3, 0.8))), size)

tileable_white("knit_white.png", (2390, 2280, 2590, 2440), (512, 512))          # dickey bib, knitted cotton
tileable_white("collar_rib.png", (2520, 2000, 2700, 2085), (1024, 512))          # turtleneck ribs
tileable("linen_thigh.png", (3500, 4420, 3565, 4600), size=(256, 512), threads=False)          # stuffed linen limb
fabric_albedo("hat_fabric.png", (2350, 880, 2750, 960), (1024, 256), detail=0.10)    # soft hat: no baked highlights
tileable("skin_hand.png", (790, 3700, 930, 3800), size=(512, 512), threads=False, strength=0.8)
fabric_albedo("leg_paint.png", (1830, 5320, 1930, 5820), (256, 1024), detail=0.3)     # ivory paint + chips, no shading steps
fabric_albedo("shoe_leather.png", (1880, 5885, 1990, 5960), (512, 512), detail=0.15)   # no baked highlights (tiled into patches)
tileable("shoe_sole.png", (1880, 6020, 2160, 6260), size=(512, 512), threads=False, strength=0.5)          # right shoe: lead plate
tileable("shoe_sole_green.png", (3000, 6130, 3250, 6330), size=(512, 512), threads=False, strength=0.5)    # left shoe: green paint
tileable("velvet_black.png", (2700, 3612, 2850, 3642), size=(1024, 256), threads=False, strength=0.4)

# --- face: 3D projection + thin-plate-spline correction --------------------
# Model front-projection UV: u = 0.5 + x / (2*FACE_HALF), v = 0.5 + (z - FACE_Z0) / (2*FACE_HALF)
# with x, z in units of total puppet height H (see blender/build_marionette.py).
# In photo 3 the head is turned (towards the viewer's left) and tilted, so a flat
# 2D warp stretches the far half of the face (its eye came out too big). Instead,
# every texel is lifted onto the head surface (front depth exported by the Blender
# build: head_front_depth.json) and projected with an affine camera fitted to the
# landmarks; a TPS on the remaining residual makes the landmarks exact.
FACE_HALF = 0.075
FACE_Z0 = 0.885
# (model x, model z) in H units  <->  (photo px, photo py) in photo 3.
# "R" = character's right = viewer's left in the photo.
LANDMARKS = [
    ((-0.029, 0.896), (2229, 1442)),   # eye R, iris centre
    ((0.029, 0.896), (2582, 1402)),    # eye L, iris centre
    ((-0.041, 0.8935), (2179, 1452)),  # eye R, outer corner (painted eyes droop outwards)
    ((-0.017, 0.8985), (2307, 1405)),  # eye R, inner corner
    ((0.017, 0.8985), (2501, 1396)),   # eye L, inner corner
    ((0.041, 0.8935), (2670, 1417)),   # eye L, outer corner
    ((-0.024, 0.922), (2250, 1268)),   # brow R, centre
    ((0.024, 0.922), (2550, 1245)),    # brow L, centre
    ((0.000, 0.875), (2384, 1513)),    # nose tip
    ((0.000, 0.854), (2368, 1645)),    # mouth centre
    ((-0.013, 0.854), (2284, 1666)),   # mouth corner R
    ((0.013, 0.854), (2458, 1653)),    # mouth corner L
    ((0.004, 0.816), (2440, 1948)),    # chin
    ((0.000, 0.9495), (2430, 1075)),   # hairline at the parting
    ((0.000, 0.962), (2440, 985)),     # hat edge, centre (front edge of the hat in the model)
]

with open(os.path.join(OUT, "head_front_depth.json")) as f:
    DEPTH = json.load(f)
_dg = np.array([[np.nan if y is None else y for y in row] for row in DEPTH["y"]], float)
# off the head (no hit): continue the nearest valid depth outwards so the map stays smooth
for row in _dg:
    ok = np.nonzero(~np.isnan(row))[0]
    if len(ok):
        row[:ok[0]] = row[ok[0]]; row[ok[-1] + 1:] = row[ok[-1]]
_dg = np.where(np.isnan(_dg), np.nanmax(_dg), _dg)
assert DEPTH["face_half"] == FACE_HALF and DEPTH["face_z0"] == FACE_Z0

def depth_at(u, v):
    """Bilinear lookup of the front depth y (H units) at face UVs."""
    n = _dg.shape[0] - 1
    fu = np.clip(u * n, 0, n - 1e-6); fv = np.clip(v * n, 0, n - 1e-6)
    i0 = fv.astype(int); j0 = fu.astype(int); tv = fv - i0; tu = fu - j0
    return ((_dg[i0, j0] * (1 - tu) + _dg[i0, j0 + 1] * tu) * (1 - tv)
            + (_dg[i0 + 1, j0] * (1 - tu) + _dg[i0 + 1, j0 + 1] * tu) * tv)

def lift(uv):
    """Face UVs -> 3D points on the head (H units)."""
    uv = np.asarray(uv, float)
    x = (uv[:, 0] - 0.5) * 2 * FACE_HALF
    z = FACE_Z0 + (uv[:, 1] - 0.5) * 2 * FACE_HALF
    return np.stack([x, depth_at(uv[:, 0], uv[:, 1]), z, np.ones(len(uv))], 1)

def tps_fit(src, dst):
    src = np.asarray(src, float); dst = np.asarray(dst, float)
    n = len(src)
    d = np.linalg.norm(src[:, None] - src[None], axis=2)
    K = np.where(d > 0, d * d * np.log(d + 1e-12), 0)
    P = np.hstack([np.ones((n, 1)), src])
    A = np.zeros((n + 3, n + 3)); A[:n, :n] = K + np.eye(n) * 1e-6; A[:n, n:] = P; A[n:, :n] = P.T
    b = np.zeros((n + 3, 2)); b[:n] = dst
    return src, np.linalg.solve(A, b)

def tps_eval(model, pts):
    src, W = model
    d = np.linalg.norm(pts[:, None] - src[None], axis=2)
    K = np.where(d > 0, d * d * np.log(d + 1e-12), 0)
    P = np.hstack([np.ones((len(pts), 1)), pts])
    return K @ W[:len(src)] + P @ W[len(src):]

N = 2048
uv_pts = np.array([(0.5 + mx / (2 * FACE_HALF), 0.5 + (mz - FACE_Z0) / (2 * FACE_HALF)) for (mx, mz), _ in LANDMARKS])
photo_pts = np.array([p for _, p in LANDMARKS], float)
# affine camera (weak perspective): photo = [x y z 1] @ CAM
CAM = np.linalg.lstsq(lift(uv_pts), photo_pts, rcond=None)[0]
affine_res = photo_pts - lift(uv_pts) @ CAM
print("face camera fit, landmark residual px (max):", round(float(np.abs(affine_res).max()), 1))
model = tps_fit(uv_pts, affine_res)

us, vs = np.meshgrid((np.arange(N) + 0.5) / N, (np.arange(N) + 0.5) / N)
q = np.stack([us.ravel(), 1.0 - vs.ravel()], 1)          # image row 0 = v 1
mp = (lift(q) @ CAM + tps_eval(model, q)).astype(np.float32)
mapx = mp[:, 0].reshape(N, N); mapy = mp[:, 1].reshape(N, N)

# Clean strings around the jaw / hair before sampling (not in the eyes/brows).
face_src = photo.copy()
for (x0, y0, x1, y1) in [(2050, 1700, 2350, 2120), (2760, 1650, 2950, 2120), (2050, 1150, 2200, 1700)]:
    face_src[y0:y1, x0:x1] = remove_threads(face_src[y0:y1, x0:x1], thresh=0.18)
face = cv2.remap(face_src, mapx, mapy, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
# Where the turned head shows the black hat flap or the background instead of the side of
# the face (the far side, viewer's left), take the mirrored near side (the painted face and
# its brown side hair are near symmetric), else fill in from the neighbouring paint.
def paint_mask(img, close=True):
    """Skin and brown hair paint (warm, saturated), not hat / background / threads."""
    hsv = cv2.cvtColor((np.clip(img, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2HSV)
    h, s_, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    ok = (s_ >= 55) & (v >= 60) & ((h <= 25) | (h >= 165))
    ok = cv2.morphologyEx(ok.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    if close:
        ok = cv2.morphologyEx(ok, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    return ok.astype(bool)

# keep the dark paint of pupils, lid lines, nostrils and mouth (vv = texture v, 0 = chin side)
vv = 1.0 - vs
features_zone = (((np.abs(us - 0.31) < 0.09) | (np.abs(us - 0.69) < 0.09)) & (np.abs(vv - 0.57) < 0.07)) | \
                ((np.abs(us - 0.5) < 0.13) & (vv > 0.25) & (vv < 0.60))
side = ~features_zone

# far side (viewer's left): per row, walk out from the cheek until the paint ends (hat flap
# edge, thread or background); smooth that silhouette over the rows; replace everything
# beyond it with the mirrored near side, Poisson-blended so the shading matches (no seam)
# marionette threads lying across the cheeks first (not in the eyes, nostrils, mouth)
face = remove_threads(face, thresh=0.4, dilate=9, protect=features_zone)
raw = paint_mask(face, close=False) | features_zone
start = int(0.42 * N)
edge = np.zeros(N)
for r in range(N):
    bad = np.nonzero(~raw[r, :start][::-1])[0]
    edge[r] = start - bad[0] if len(bad) else 0
edge = cv2.GaussianBlur(cv2.medianBlur(edge.astype(np.float32).reshape(-1, 1), 5), (1, 0), 25).ravel()
cols = np.arange(N)[None, :]
mirrored = np.ascontiguousarray(face[:, ::-1])
# per-row colour gain so the mirrored (lit) side matches the shading next to the cut
strip = (cols < edge[:, None] + 40) & (cols >= edge[:, None] + 10)
gain = np.ones((N, 3), np.float32)
for r in range(N):
    m = strip[r] & raw[r] & raw[r, ::-1]
    if m.sum() > 8:
        gain[r] = (face[r, m].mean(0) + 1e-3) / (mirrored[r, m].mean(0) + 1e-3)
gain = cv2.GaussianBlur(np.clip(gain, 0.6, 1.4)[:, None, :], (1, 0), 30)[:, 0, :]
fill = np.clip(mirrored * gain[:, None, :], 0, 1)
# soft cut: 1 up to 10 px inside the silhouette (covers the dark rim), 20 px feather
w = np.clip((edge[:, None] + 30 - cols) / 20.0, 0, 1)
w = np.where(features_zone | (np.arange(N)[:, None] >= int(0.95 * N)), 0, w)[..., None]
face = face * (1 - w) + fill * w

# anything else that is still not paint at the sides (near-side background, threads)
paint = paint_mask(face)
hidden = side & ~paint
hidden = cv2.dilate(hidden.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool) & side
face = cv2.inpaint((np.clip(face, 0, 1) * 255).astype(np.uint8), hidden.astype(np.uint8) * 255, 25,
                   cv2.INPAINT_TELEA).astype(np.float32) / 255
# below the chin the warp reaches the white collar / background: inpaint it with skin
hsv = cv2.cvtColor((np.clip(face, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2HSV)
low = np.zeros(face.shape[:2], bool); low[int(N * 0.82):, :] = True
bad = (low & (hsv[..., 1] < 70) & (hsv[..., 2] > 120)).astype(np.uint8)
bad = cv2.dilate(bad, np.ones((25, 25), np.uint8))
face = cv2.inpaint((np.clip(face, 0, 1) * 255).astype(np.uint8), bad * 255, 25, cv2.INPAINT_TELEA).astype(np.float32) / 255
save("face_projection.png", calibrated(face))

# Residual check on landmarks (should be ~0 px for a TPS)
res = lift(uv_pts) @ CAM + tps_eval(model, uv_pts) - photo_pts
print("TPS landmark residual px (max):", float(np.abs(res).max()))

with open(os.path.join(OUT, "texture_meta.json"), "w") as f:
    json.dump({"face_half": FACE_HALF, "face_z0": FACE_Z0, "exposure_gain": GAIN,
               "source": "SKKG Sammlung digital, Marionettenpuppe 46154, CC0"}, f, indent=2)

# Painted hair: the brown strokes beside the jaw in photo 3 (below the hat flap, right of the face)
tileable("hair_paint.png", (2765, 1800, 2815, 1975), size=(256, 1024), threads=True, sigma=0.4, strength=0.7)
