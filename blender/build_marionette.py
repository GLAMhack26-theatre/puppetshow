"""Procedural, rigged, cloth-ready marionette built from the SKKG reference photos.

Run inside Blender (5.x):
    blender --python blender/build_marionette.py
or from a running session:
    exec(compile(open(p).read(), p, "exec"), {"__file__": p, "__name__": "__main__"})

Everything lives in the "Marionette" collection; re-running rebuilds it.
All dimensions are authored as fractions of the total height H (hat top to
sole) and measured on the orthographic front/side reference photos.
Real object size (SKKG catalogue): 35 x 14 x 7.5 cm  ->  H = 0.35 m.

Rest pose: arms hanging down, as a marionette rests on its strings. The arm and
sleeve geometry is generated along X (simple lofts) and immediately rotated into
the hanging pose, which then becomes the rest pose of the rig and the export.

Controller: the real SKKG 9-string cross (main bar, shoulder crossbar, head bar
below it, a rocking leg bar in the middle and a rocking hand bar at the front).

Conventions: Z up, the puppet faces -Y, character left = +X (".L" bones).
"""
import bpy
import bmesh
import math
import os
import json
import numpy as np
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

H = 0.35                     # total height in metres (hat top to sole)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, "assets", "textures")
COLL = "Marionette"
PREFIX = "MAR_"

# ============================================================================
# small math helpers
# ============================================================================

def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def pchip(xs, ys):
    """Monotone cubic (Fritsch-Carlson) interpolant; xs strictly increasing."""
    xs = np.asarray(xs, float); ys = np.asarray(ys, float)
    h = np.diff(xs); d = np.diff(ys) / h; n = len(xs)
    m = np.zeros(n)
    for k in range(1, n - 1):
        if d[k - 1] * d[k] > 0:
            w1 = 2 * h[k] + h[k - 1]; w2 = h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    m[0] = d[0]; m[-1] = d[-1]

    def f(x):
        x = np.asarray(x, float)
        k = np.clip(np.searchsorted(xs, x) - 1, 0, n - 2)
        t = np.clip((x - xs[k]) / h[k], 0, 1); t2 = t * t; t3 = t2 * t
        return ((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h[k] * m[k]
                + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h[k] * m[k + 1])
    return f


class Profile:
    """Table of cross-section parameters vs. a scalar (usually z)."""
    def __init__(self, keys, rows):
        rows = sorted(rows, key=lambda r: r[0])
        arr = np.array(rows, float)
        self.lo, self.hi = arr[0, 0], arr[-1, 0]
        self.f = {k: pchip(arr[:, 0], arr[:, i + 1]) for i, k in enumerate(keys)}

    def __call__(self, key, x):
        return float(self.f[key](x))


def se_xy(t, a, bf, bb, pf=2.2, pb=2.2):
    """Superellipse section. t=0 back (+Y), pi/2 left (+X), pi front (-Y), 3pi/2 right."""
    s, c = math.sin(t), math.cos(t)
    b, p = (bb, pb) if c >= 0 else (bf, pf)
    x = a * math.copysign(abs(s) ** (2 / p), s)
    y = b * math.copysign(abs(c) ** (2 / p), c)
    return x, y


def quadrant_params(a, bf, bb, N, pf=2.2, pb=2.2):
    """Column angles with equal arc length inside each quadrant so that
    j = 0, N/4, N/2, 3N/4 hit back, left, front, right exactly."""
    out = []
    for q in range(4):
        ts = np.linspace(q * math.pi / 2, (q + 1) * math.pi / 2, 600)
        pts = np.array([se_xy(t, a, bf, bb, pf, pb) for t in ts])
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
        out += list(np.interp(np.linspace(0, L[-1], N // 4 + 1)[:-1], L, ts))
    return np.array(out)


def resample_polyline(pts, n):
    """n+1 points equally spaced by arc length along a polyline (pts: (k,3))."""
    pts = np.asarray(pts, float)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    s = np.linspace(0, L[-1], n + 1)
    return np.stack([np.interp(s, L, pts[:, i]) for i in range(3)], 1), L[-1]


# ============================================================================
# scene / data helpers
# ============================================================================

def get_collection():
    coll = bpy.data.collections.get(COLL)
    if coll is None:
        coll = bpy.data.collections.new(COLL)
        bpy.context.scene.collection.children.link(coll)
    return coll


def clear_previous():
    coll = bpy.data.collections.get(COLL)
    if coll:
        for ob in list(coll.all_objects):
            data = ob.data
            bpy.data.objects.remove(ob, do_unlink=True)
            if data is not None and data.users == 0:
                if isinstance(data, bpy.types.Mesh):
                    bpy.data.meshes.remove(data)
                elif isinstance(data, bpy.types.Armature):
                    bpy.data.armatures.remove(data)
                elif isinstance(data, bpy.types.Camera):
                    bpy.data.cameras.remove(data)
                elif isinstance(data, bpy.types.Light):
                    bpy.data.lights.remove(data)
        for child in list(coll.children):
            bpy.data.collections.remove(child)
    for a in list(bpy.data.actions):
        if a.name.startswith(PREFIX):
            bpy.data.actions.remove(a)
    for m in list(bpy.data.materials):
        if m.name.startswith(PREFIX) and m.users == 0:
            bpy.data.materials.remove(m)
    # the untouched factory-startup cube would sit right on top of the puppet
    cube = bpy.data.objects.get("Cube")
    if cube and cube.type == "MESH" and len(cube.data.polygons) == 6 and cube.location.length < 1e-6 \
            and abs(cube.dimensions.x - 2.0) < 1e-6:
        bpy.data.objects.remove(cube, do_unlink=True)


def sub_collection(name):
    parent = get_collection()
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        parent.children.link(c)
    return c


def make_mesh_object(name, verts_h, faces, coll=None, face_uvs=None, mat_idx=None, smooth=True):
    """verts in H units -> metres. face_uvs: list (per face) of list of (u,v)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(float(c) * H for c in v) for v in verts_h], [], [tuple(f) for f in faces])
    me.validate(clean_customdata=False)
    if face_uvs is not None:
        uvl = me.uv_layers.new(name="UVMap")
        flat = []
        for poly_uv in face_uvs:
            for uv in poly_uv:
                flat.extend(uv)
        uvl.data.foreach_set("uv", flat)
    if mat_idx is not None:
        me.polygons.foreach_set("material_index", list(mat_idx))
    me.polygons.foreach_set("use_smooth", [smooth] * len(me.polygons))
    me.update()
    ob = bpy.data.objects.new(name, me)
    (coll or get_collection()).objects.link(ob)
    return ob


def fix_normals(ob, outward_from=None):
    """Make normals consistent; optionally flip so they point away from a point/axis fn."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if outward_from is not None:
        score = 0.0
        for f in bm.faces:
            c = f.calc_center_median()
            score += f.normal.dot(c - outward_from(c)) * f.calc_area()
        if score < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces, flip_multires=False)
    bm.to_mesh(ob.data); bm.free(); ob.data.update()


def loft(name, rings, cap0=None, cap1=None, u_rep=1.0, v_tile=None, mat_fn=None, coll=None):
    """Closed rings (list of (N,3) arrays, H units) -> quad tube with optional pole caps.
    UV: u = column fraction * u_rep, v = arc length / v_tile (or 0..1)."""
    R, N = len(rings), len(rings[0])
    verts = [tuple(p) for ring in rings for p in ring]
    cent = [np.mean(r, axis=0) for r in rings]
    vl = np.concatenate([[0], np.cumsum([np.linalg.norm(cent[i + 1] - cent[i]) for i in range(R - 1)])])
    vv = vl / v_tile if v_tile else vl / max(vl[-1], 1e-9)
    faces, uvs, mats = [], [], []
    for i in range(R - 1):
        for j in range(N):
            j1 = (j + 1) % N
            faces.append((i * N + j, (i + 1) * N + j, (i + 1) * N + j1, i * N + j1))
            u0, u1 = j / N * u_rep, (j + 1) / N * u_rep
            uvs.append([(u0, vv[i]), (u0, vv[i + 1]), (u1, vv[i + 1]), (u1, vv[i])])
            mats.append(mat_fn(i, j, rings) if mat_fn else 0)
    for cap, ri, sgn in ((cap0, 0, -1), (cap1, R - 1, 1)):
        if cap is None:
            continue
        pi = len(verts); verts.append(tuple(cap))
        vcap = vv[ri] + sgn * 0.02
        for j in range(N):
            j1 = (j + 1) % N
            a, b = ri * N + j, ri * N + j1
            faces.append((pi, a, b) if sgn < 0 else (pi, b, a))
            u0, u1 = j / N * u_rep, (j + 1) / N * u_rep
            uvs.append([((u0 + u1) / 2, vcap), (u0, vv[ri]), (u1, vv[ri])] if sgn < 0
                       else [((u0 + u1) / 2, vcap), (u1, vv[ri]), (u0, vv[ri])])
            mats.append(mat_fn(ri, j, rings) if mat_fn else 0)
    ob = make_mesh_object(name, verts, faces, coll, uvs, mats)
    fix_normals(ob)
    return ob


def ring(center, ax_u, ax_v, ra, rb, N, p=2.0, phase=0.0, rfun=None):
    """Superellipse ring in the plane (ax_u, ax_v) around center (all H units)."""
    c = np.asarray(center, float); U = np.asarray(ax_u, float); V = np.asarray(ax_v, float)
    pts = []
    for j in range(N):
        t = phase + 2 * math.pi * j / N
        cs, sn = math.cos(t), math.sin(t)
        k = (rfun(t) if rfun else 1.0)
        pts.append(c + U * ra * k * math.copysign(abs(cs) ** (2 / p), cs)
                   + V * rb * k * math.copysign(abs(sn) ** (2 / p), sn))
    return np.array(pts)


# ============================================================================
# materials
# ============================================================================

def load_image(fname):
    path = os.path.join(TEX, fname)
    img = bpy.data.images.get(fname)
    if img is None or img.filepath != path:
        img = bpy.data.images.load(path, check_existing=True)
    img.reload()
    return img


def sock(node, ident, out=False):
    coll = node.outputs if out else node.inputs
    return next(s for s in coll if s.identifier == ident or s.name == ident)


def material(name, tex=None, scale=(1, 1), color=None, tint=None, **params):
    """Principled material; optional tiled image texture (UV) multiplied by tint."""
    m = bpy.data.materials.get(PREFIX + name) or bpy.data.materials.new(PREFIX + name)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); out.location = (500, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled"); bsdf.location = (200, 0)
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    if color is not None:
        bsdf.inputs["Base Color"].default_value = (*color, 1)
    if tex:
        tc = nt.nodes.new("ShaderNodeTexCoord"); tc.location = (-800, 0)
        mp = nt.nodes.new("ShaderNodeMapping"); mp.location = (-600, 0)
        mp.inputs["Scale"].default_value = (scale[0], scale[1], 1)
        im = nt.nodes.new("ShaderNodeTexImage"); im.location = (-380, 0)
        im.image = load_image(tex)
        im.interpolation = "Cubic"
        nt.links.new(sock(tc, "UV", True), mp.inputs["Vector"])
        nt.links.new(mp.outputs[0], im.inputs[0])
        col = im.outputs["Color"]
        if tint is not None:
            mix = nt.nodes.new("ShaderNodeMix"); mix.location = (-80, 0)
            mix.data_type = "RGBA"; mix.blend_type = "MULTIPLY"
            sock(mix, "Factor_Float").default_value = 1.0
            nt.links.new(col, sock(mix, "A_Color"))
            sock(mix, "B_Color").default_value = (*tint, 1)
            col = sock(mix, "Result_Color", True)
        nt.links.new(col, bsdf.inputs["Base Color"])
    for k, v in params.items():
        key = k.replace("_", " ")
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = v
    return m


def build_materials():
    M = {}
    M["face"] = material("FacePaint", "face_projection.png", Roughness=0.55, **{"Coat Weight": 0.25, "Coat Roughness": 0.3})
    M["hair"] = material("HairPaint", "hair_paint.png", (6, 3), tint=(1.0, 0.92, 0.85), Roughness=0.5,
                         **{"Coat Weight": 0.25})
    M["skin"] = material("SkinPaint", "skin_hand.png", (3, 3), Roughness=0.5, **{"Coat Weight": 0.2})
    # soft black fabric hat (not lacquered): matte, with a cloth sheen
    M["hat"] = material("HatFabric", "hat_fabric.png", (2, 2), tint=(0.10, 0.10, 0.11), Roughness=0.85,
                        **{"Specular IOR Level": 0.25, "Sheen Weight": 0.5, "Sheen Roughness": 0.5,
                           "Sheen Tint": (0.45, 0.45, 0.5, 1)})
    M["ribbon"] = material("BlackRibbon", None, color=(0.012, 0.012, 0.014), Roughness=0.35, Anisotropic=0.5)
    # the photo's satin texture reads almost white once lit: tint it towards the satin's pink
    M["satin"] = material("PinkSatin", "satin_pink.png", (1, 1), tint=(0.95, 0.70, 0.85), Roughness=0.3,
                          Anisotropic=0.0, **{"Specular IOR Level": 0.45, "Sheen Weight": 0.15,
                                               "Sheen Tint": (1.0, 0.75, 0.86, 1)})
    M["velvet"] = material("BlackVelvet", "velvet_black.png", (2, 1), tint=(0.5, 0.5, 0.5), Roughness=0.95,
                           **{"Specular IOR Level": 0.2, "Sheen Weight": 1.0, "Sheen Roughness": 0.35,
                              "Sheen Tint": (0.35, 0.33, 0.38, 1)})
    M["knit"] = material("WhiteKnit", "knit_white.png", (4, 4), Roughness=0.9, **{"Sheen Weight": 0.4})
    M["rib"] = material("WhiteRib", "collar_rib.png", (3, 1), Roughness=0.9, **{"Sheen Weight": 0.4})
    M["linen"] = material("LinenStuffing", "linen_thigh.png", (4, 4), Roughness=0.85, **{"Sheen Weight": 0.3})
    M["legpaint"] = material("LegWhitePaint", "leg_paint.png", (2, 1), tint=(1.0, 0.93, 0.80), Roughness=0.55,
                             **{"Coat Weight": 0.15})                               # warm ivory, as in photo 3
    M["shoe"] = material("ShoeLeather", "shoe_leather.png", (3, 3), tint=(0.8, 0.68, 0.58), Roughness=0.4,
                         **{"Coat Weight": 0.4, "Coat Roughness": 0.2})
    M["sole"] = material("ShoeSole", "shoe_sole.png", (2, 2), Roughness=0.45, Metallic=0.3)          # lead plate (R)
    M["sole_green"] = material("ShoeSoleGreen", "shoe_sole_green.png", (2, 2), Roughness=0.6)       # painted (L)
    M["string"] = material("String", None, color=(0.015, 0.015, 0.015), Roughness=0.7)
    M["wood"] = material("ControlWood", None, color=(0.33, 0.2, 0.11), Roughness=0.5)
    return M


def set_mats(ob, mats):
    me = ob.data
    idx = [0] * len(me.polygons)
    me.polygons.foreach_get("material_index", idx)
    me.materials.clear()                       # (clearing resets the per-face indices)
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", idx)
    me.update()


# ============================================================================
# proportions (H units) - measured from the reference photos
# ============================================================================
SHOULDER = (0.11, -0.005, 0.705)     # shoulder joint (L); arm axis in T-pose
ELBOW_X, WRIST_X, FINGER_X = 0.245, 0.345, 0.432
HIP = (0.047, 0.0, 0.47)
KNEE_Z, ANKLE_Z = 0.275, 0.06
NECK_BASE, HEAD_PIVOT = 0.765, 0.81


# ============================================================================
# body parts
# ============================================================================

def build_head(M, coll):
    # z, a (half width), bf (front depth), bb (back depth)
    prof = Profile(["a", "bf", "bb"], [
        # jaw: narrow at the chin, widening up to the cheeks (photo 3 / front view: the jaw line
        # rises from the chin to about +-0.047 at z 0.84), no flat shelf under the head
        (0.766, 0.021, 0.021, 0.022), (0.790, 0.021, 0.022, 0.023), (0.803, 0.022, 0.030, 0.026),
        (0.810, 0.024, 0.055, 0.030), (0.817, 0.028, 0.069, 0.036), (0.828, 0.038, 0.077, 0.045),
        (0.842, 0.049, 0.079, 0.052), (0.856, 0.0555, 0.078, 0.060), (0.875, 0.0565, 0.075, 0.067),
        (0.900, 0.058, 0.072, 0.072), (0.925, 0.058, 0.071, 0.073), (0.950, 0.055, 0.066, 0.071),
        (0.970, 0.047, 0.055, 0.062), (0.983, 0.033, 0.038, 0.045), (0.990, 0.015, 0.018, 0.022)])
    N = 96
    zs = np.concatenate([np.linspace(0.768, 0.80, 7), np.linspace(0.8035, 0.989, 62)])

    def g(x, z, cx, cz, sx, sz):
        return math.exp(-((x - cx) / sx) ** 2 - ((z - cz) / sz) ** 2)

    def features(x, z):
        d = 0.0
        # nose: ridge growing from the brows to the tip, sharp underside
        if 0.868 < z < 0.915:
            t = smoothstep(0.915, 0.876, z)
            amp = 0.003 + 0.0135 * t if z >= 0.876 else 0.0165 * math.exp(-((z - 0.876) / 0.0035) ** 2)
            sx = 0.0045 + 0.0045 * t
            d += amp * math.exp(-(x / sx) ** 2)
        for sx_ in (-1, 1):
            d += 0.006 * g(x, z, sx_ * 0.0085, 0.8735, 0.0045, 0.0035)       # nostril wings
            d += 0.0035 * g(x, z, sx_ * 0.024, 0.921, 0.016, 0.006)          # brow ridge
            d -= 0.0065 * g(x, z, sx_ * 0.029, 0.897, 0.012, 0.008)          # eye socket
            d += 0.0042 * g(x, z, sx_ * 0.029, 0.896, 0.0085, 0.0055)        # eyeball / lids
            d += 0.0055 * g(x, z, sx_ * 0.034, 0.864, 0.016, 0.014)          # cheeks (full, rounded)
        d += 0.0020 * g(x, z, 0, 0.911, 0.008, 0.006)                        # glabella
        d += 0.0060 * g(x, z, 0, 0.8585, 0.014, 0.0038)                      # upper lip
        d += 0.0050 * g(x, z, 0, 0.8495, 0.011, 0.0035)                      # lower lip
        d -= 0.0025 * g(x, z, 0, 0.8540, 0.012, 0.0012)                      # mouth line
        d += 0.0040 * g(x, z, 0, 0.8260, 0.014, 0.0070)                      # chin
        return d

    rings = []
    for z in zs:
        a, bf, bb = prof("a", z), prof("bf", z), prof("bb", z)
        pf = 2.0 + 0.6 * smoothstep(0.825, 0.86, z)
        pts = []
        for j in range(N):
            t = 2 * math.pi * j / N
            x, y = se_xy(t, a, bf, bb, pf, 2.2)
            if y < 0 and z > 0.80:
                w = smoothstep(0.3, 0.7, -y / max(bf, 1e-6))
                dd = features(x, z) * w
                r = math.hypot(x, y) + 1e-9
                x += x / r * dd * 0.35
                y += y / r * dd
            pts.append((x, y, z))
        rings.append(np.array(pts))
    ob = loft("Head", rings, cap0=(0, 0, 0.766), cap1=(0, 0.002, 0.9905), coll=coll)
    # material split + per-material UVs: face = planar front projection matching
    # tools/extract_textures.py, hair/neck = cylindrical tiling
    me = ob.data
    FACE_HALF, FACE_Z0 = 0.075, 0.885
    uvl = me.uv_layers["UVMap"]
    mats = []
    for p in me.polygons:
        c = p.center / H; n = p.normal
        if c.z < 0.806:
            mi = 2                                   # neck (skin paint)
        elif (-n.y > 0.05 or (n.z < -0.45 and c.y < -0.01)) and c.y < 0:
            # painted face (its texture carries the side hair too), including under the jaw;
            # the seam to the tiled hair paint then lies under the hat flaps
            mi = 0
        else:
            mi = 1                                   # painted hair
        mats.append(mi)
        for li in p.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co / H
            if mi == 0:
                uvl.data[li].uv = (0.5 + v.x / (2 * FACE_HALF), 0.5 + (v.z - FACE_Z0) / (2 * FACE_HALF))
            else:
                ang = math.atan2(v.x, v.y) / (2 * math.pi) + 0.5
                uvl.data[li].uv = (ang, v.z * 4)
    me.polygons.foreach_set("material_index", mats)
    set_mats(ob, [M["face"], M["hair"], M["skin"]])
    write_face_depth(ob, FACE_HALF, FACE_Z0)
    ob.modifiers.new("Subdivision", "SUBSURF").levels = 1
    return ob


def write_face_depth(head, face_half, face_z0, n=65):
    """Front depth of the head (y, H units) on the face texture's projection grid, for
    tools/extract_textures.py: it projects the 3D face into the (turned) head in photo 3."""
    bvh = BVHTree.FromObject(head, bpy.context.evaluated_depsgraph_get())
    grid = []
    for i in range(n):                                   # rows: v from 0 (chin side) to 1
        z = face_z0 + (i / (n - 1) - 0.5) * 2 * face_half
        row = []
        for j in range(n):
            x = (j / (n - 1) - 0.5) * 2 * face_half
            hit = bvh.ray_cast(Vector((x * H, -0.5, z * H)), Vector((0, 1, 0)))
            row.append(round(hit[0].y / H, 5) if hit[0] else None)
        grid.append(row)
    with open(os.path.join(TEX, "head_front_depth.json"), "w") as f:
        json.dump({"face_half": face_half, "face_z0": face_z0, "units": "H", "rows": "v 0..1", "cols": "u 0..1",
                   "y": grid}, f)


def build_hat(M, coll):
    prof = Profile(["a", "bf", "bb"], [
        (0.822, 0.100, 0.077, 0.064), (0.840, 0.087, 0.077, 0.068), (0.855, 0.076, 0.077, 0.074),
        (0.875, 0.068, 0.077, 0.077), (0.900, 0.065, 0.077, 0.079), (0.925, 0.064, 0.076, 0.079),
        (0.950, 0.062, 0.072, 0.077), (0.968, 0.056, 0.062, 0.070), (0.982, 0.042, 0.045, 0.055),
        (0.9905, 0.020, 0.020, 0.028), (0.993, 0.0, 0.0, 0.0)])
    # lower edge of the hat as a function of angle from the front (deg)
    # (front raised so the painted brown hair band above the forehead shows, as in photo 3)
    edge = pchip([0, 20, 32, 40, 55, 67, 80, 88, 100, 130, 160, 180],
                 [0.962, 0.959, 0.951, 0.939, 0.900, 0.873, 0.842, 0.824, 0.823, 0.832, 0.840, 0.842])
    N, R = 128, 34
    cols = []
    for j in range(N):
        t = 2 * math.pi * j / N
        phi = math.degrees(abs(math.pi - t))            # 0 = front centre, 180 = back
        # soft fabric: the edge droops a little at the sides and back (not on the forehead)
        side = smoothstep(30, 70, phi)
        z_end = float(edge(phi)) - side * 0.006 * (0.6 + 0.4 * math.sin(3 * t + 1.3))
        zz = np.linspace(0.993, z_end, 160)
        pts = []
        for z in zz:
            x, y = se_xy(t, prof("a", z), prof("bf", z), prof("bb", z), 2.3, 2.2)
            # gentle outward waves towards the edge (never inwards: the head is underneath)
            s_ = (0.993 - z) / (0.993 - z_end)
            k = 1 + side * s_ ** 2 * 0.045 * (0.5 + 0.5 * math.sin(5 * t + 0.7) * math.cos(2 * t))
            pts.append((x * k, y * k, z))
        col, _ = resample_polyline(pts, R)
        cols.append(col[1:])                            # drop the pole sample
    verts = [(0, 0.0, 0.993)]
    for i in range(R):
        for j in range(N):
            verts.append(tuple(cols[j][i]))
    vid = lambda i, j: 1 + i * N + (j % N)
    faces, uvs = [], []
    for j in range(N):
        faces.append((0, vid(0, j), vid(0, j + 1)))
        uvs.append([(j / N, 1.0), (j / N, 1 - 1 / R), ((j + 1) / N, 1 - 1 / R)])
    for i in range(R - 1):
        for j in range(N):
            faces.append((vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)))
            v0, v1 = 1 - (i + 1) / R, 1 - (i + 2) / R
            uvs.append([(j / N * 2, v0), (j / N * 2, v1), ((j + 1) / N * 2, v1), ((j + 1) / N * 2, v0)])
    ob = make_mesh_object("Hat", verts, faces, coll, uvs)
    fix_normals(ob, outward_from=lambda c: Vector((0, 0, 0.9 * H)))
    set_mats(ob, [M["hat"]])
    sol = ob.modifiers.new("Thickness", "SOLIDIFY")
    sol.thickness = 0.003 * H; sol.offset = 1.0; sol.use_even_offset = True; sol.use_rim = True
    ob.modifiers.new("Subdivision", "SUBSURF").levels = 1

    # crumpled ribbon rosette on the left side of the crown
    parts = []
    base = Vector((0.062, 0.012, 0.958))
    for k, (dx, dy, dz, sx, sy, sz, rx, ry, rz) in enumerate([
            (0.000, 0.000, 0.000, 0.016, 0.006, 0.011, 20, 70, 10),
            (0.002, -0.012, 0.004, 0.012, 0.005, 0.009, -30, 60, 40),
            (0.002, 0.012, 0.003, 0.012, 0.005, 0.010, 40, 75, -35),
            (0.004, 0.002, -0.010, 0.010, 0.005, 0.008, 80, 60, 0),
            (0.006, 0.000, 0.000, 0.006, 0.006, 0.006, 0, 0, 0)]):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=1.0)
        mat = (Matrix.Translation((base + Vector((dx, dy, dz))) * H)
               @ Matrix.Rotation(math.radians(rz), 4, "Z") @ Matrix.Rotation(math.radians(ry), 4, "Y")
               @ Matrix.Rotation(math.radians(rx), 4, "X") @ Matrix.Diagonal((sx * H, sy * H, sz * H, 1)))
        for v in bm.verts:
            n = v.co.copy()
            v.co = n * (1 + 0.12 * math.sin(5 * n.x + 3 * k) * math.cos(4 * n.y))
        bmesh.ops.transform(bm, matrix=mat, verts=bm.verts)
        me = bpy.data.meshes.new(f"Rosette{k}"); bm.to_mesh(me); bm.free()
        parts.append(me)
    bm = bmesh.new()
    for me in parts:
        bm.from_mesh(me); bpy.data.meshes.remove(me)
    me = bpy.data.meshes.new("HatRosette"); bm.to_mesh(me); bm.free()
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    ros = bpy.data.objects.new("HatRosette", me); coll.objects.link(ros)
    set_mats(ros, [M["ribbon"]])
    return ob, ros


def build_collar(M, coll):
    """White ribbed turtleneck with black velvet ribbon (rigid on the neck)."""
    a0, b0, yc = 0.032, 0.035, -0.002
    # (scale, z) profile: outer surface up, rolled lip, inner surface down
    prof = [(1.00, 0.764), (1.01, 0.772), (1.015, 0.781), (1.035, 0.784), (1.035, 0.788), (1.015, 0.791),
            (1.02, 0.798), (1.0, 0.805), (0.94, 0.809), (0.86, 0.807), (0.80, 0.800), (0.78, 0.785),
            (0.78, 0.768)]
    N = 64
    rings = [ring((0, yc, z), (1, 0, 0), (0, 1, 0), a0 * s, b0 * s, N, 2.0) for s, z in prof]
    ob = loft("Collar", rings, u_rep=6, mat_fn=lambda i, j, r: 1 if i in (2, 3, 4) else 0, coll=coll)
    set_mats(ob, [M["rib"], M["velvet"]])
    return ob


TORSO_PELVIS = [  # z, a, bf, bb
    (0.400, 0.055, 0.045, 0.042), (0.415, 0.075, 0.063, 0.058), (0.440, 0.084, 0.072, 0.064),
    (0.480, 0.087, 0.075, 0.060), (0.520, 0.086, 0.074, 0.055), (0.537, 0.082, 0.069, 0.051)]
TORSO_CHEST = [
    (0.522, 0.078, 0.066, 0.049), (0.535, 0.086, 0.074, 0.054), (0.600, 0.084, 0.074, 0.052),
    (0.660, 0.082, 0.074, 0.050), (0.700, 0.085, 0.068, 0.050), (0.725, 0.093, 0.058, 0.048),
    (0.742, 0.085, 0.047, 0.042), (0.753, 0.062, 0.037, 0.036), (0.762, 0.040, 0.030, 0.031),
    (0.768, 0.026, 0.024, 0.025)]


def build_torso(M, coll):
    out = []
    for name, table, caps in (("Pelvis", TORSO_PELVIS, ((0, 0, 0.395), (0, 0, 0.539))),
                              ("Chest", TORSO_CHEST, ((0, 0, 0.519), (0, 0, 0.770)))):
        prof = Profile(["a", "bf", "bb"], table)
        zs = np.linspace(table[0][0], table[-1][0], 26)
        N = 48
        rings = [np.array([(*se_xy(2 * math.pi * j / N, prof("a", z), prof("bf", z), prof("bb", z)), z)
                           for j in range(N)]) for z in zs]

        def mat_fn(i, j, rs, name=name):
            if name != "Chest":
                return 0
            c = rs[i][j]
            return 1 if (c[2] > 0.63 and c[1] < 0 and abs(c[0]) < 0.065) or c[2] > 0.755 else 0
        ob = loft(name, rings, cap0=caps[0], cap1=caps[1], u_rep=4, v_tile=0.08, mat_fn=mat_fn, coll=coll)
        set_mats(ob, [M["linen"], M["knit"]])
        out.append(ob)
    return out


def limb_x(name, side, stations, N=24, M_=None, coll=None, center=(0, 0), p=2.0):
    """Tube along +-X. stations: (x, ry, rz[, dz])."""
    rings = []
    for st in stations[1:-1]:
        x, ry, rz = st[:3]; dz = st[3] if len(st) > 3 else 0.0
        rings.append(ring((side * x, center[0], center[1] + dz), (0, 1, 0), (0, 0, 1), ry, rz, N, p))
    x0, x1 = stations[0][0], stations[-1][0]
    ob = loft(name, rings, cap0=(side * x0, center[0], center[1] + (stations[0][3] if len(stations[0]) > 3 else 0)),
              cap1=(side * x1, center[0], center[1] + (stations[-1][3] if len(stations[-1]) > 3 else 0)),
              u_rep=2, v_tile=0.1, coll=coll)
    return ob


def build_arms(M, coll):
    objs = {}
    cy, cz = SHOULDER[1], SHOULDER[2]
    for side, sfx in ((1, "L"), (-1, "R")):
        ua = limb_x(f"UpperArm.{sfx}", side, [(0.085, 0, 0), (0.09, 0.015, 0.015), (0.10, 0.020, 0.020),
                                              (0.17, 0.021, 0.021), (0.23, 0.019, 0.019), (0.25, 0.016, 0.016),
                                              (0.258, 0, 0)], coll=coll, center=(cy, cz))
        fa = limb_x(f"Forearm.{sfx}", side, [(0.238, 0, 0), (0.243, 0.013, 0.013), (0.25, 0.016, 0.016),
                                             (0.30, 0.015, 0.015), (0.335, 0.012, 0.012), (0.343, 0.011, 0.011),
                                             (0.348, 0, 0)], coll=coll, center=(cy, cz))
        for ob in (ua, fa):
            set_mats(ob, [M["linen"]])
        objs[f"upper_arm.{sfx}"] = ua; objs[f"forearm.{sfx}"] = fa
        objs[f"hand.{sfx}"] = build_hand(M, coll, side, sfx)
    return objs


def build_hand(M, coll, side, sfx):
    """Carved wooden hand, palm down, thumb forward (-Y), slightly cupped fingers."""
    cy, cz = SHOULDER[1], SHOULDER[2]
    st = [  # x, half width (y), half thickness (z)
        (0.336, 0.0090, 0.0090), (0.346, 0.0100, 0.0092), (0.352, 0.0135, 0.0082), (0.362, 0.0165, 0.0084),
        (0.375, 0.0172, 0.0080), (0.386, 0.0168, 0.0068), (0.398, 0.0158, 0.0058), (0.410, 0.0140, 0.0050),
        (0.420, 0.0118, 0.0044), (0.427, 0.0090, 0.0038), (0.4305, 0.0055, 0.0030)]
    N = 40
    rings = []
    for x, w, t in st:
        cup = -3.0 * max(0.0, x - 0.385) ** 2 * 1.0
        pts = []
        for j in range(N):
            a = 2 * math.pi * j / N
            yy = w * math.copysign(abs(math.cos(a)) ** (2 / 2.6), math.cos(a))
            zz = t * math.copysign(abs(math.sin(a)) ** (2 / 2.2), math.sin(a))
            if x > 0.388:   # finger grooves on top and bottom
                f = smoothstep(0.388, 0.398, x) * (1 - smoothstep(0.424, 0.430, x))
                gsum = sum(math.exp(-((yy - gy * w) / 0.0011) ** 2) for gy in (-0.5, 0.0, 0.5))
                zz *= 1 - 0.35 * f * gsum
            pts.append((side * x, cy + yy, cz + zz + cup))
        rings.append(np.array(pts))
    hand = loft(f"Hand.{sfx}", rings, cap0=(side * 0.334, cy, cz), cap1=(side * 0.432, cy, cz - 0.006),
                u_rep=1, v_tile=0.05, coll=coll)
    # thumb: tapered tube from the palm edge towards the front
    base = np.array((side * 0.356, cy - 0.011, cz - 0.001))
    d = np.array((side * 0.55, -0.75, -0.2)); d /= np.linalg.norm(d)
    up = np.array((0, 0, 1.0)); u = np.cross(d, up); u /= np.linalg.norm(u); v = np.cross(u, d)
    trings = []
    for s, r in ((0.0, 0.0065), (0.008, 0.0062), (0.018, 0.0055), (0.026, 0.0045), (0.031, 0.0030)):
        trings.append(ring(base + d * s, u, v, r, r * 0.85, 16))
    thumb = loft(f"Thumb.{sfx}", trings, cap0=tuple(base - d * 0.003), cap1=tuple(base + d * 0.034),
                 v_tile=0.05, coll=coll)
    join_into(hand, [thumb])
    set_mats(hand, [M["skin"]])
    hand.modifiers.new("Subdivision", "SUBSURF").levels = 1
    return hand


def join_into(target, others):
    bm = bmesh.new(); bm.from_mesh(target.data)
    for o in others:
        bm.from_mesh(o.data)
        me = o.data; bpy.data.objects.remove(o, do_unlink=True); bpy.data.meshes.remove(me)
    bm.to_mesh(target.data); bm.free(); target.data.update()


def build_legs(M, coll):
    objs = {}
    for side, sfx in ((1, "L"), (-1, "R")):
        x = side * HIP[0]
        th_st = [(0.500, 0), (0.495, 0.018), (0.485, 0.027), (0.46, 0.032), (0.40, 0.031), (0.33, 0.028),
                 (0.29, 0.025), (0.275, 0.020), (0.268, 0)]
        rings = [ring((x, 0, z), (1, 0, 0), (0, 1, 0), r, r, 28) for z, r in th_st[1:-1]][::-1]
        th = loft(f"Thigh.{sfx}", rings, cap0=(x, 0, 0.268), cap1=(x, 0, 0.5), u_rep=2, v_tile=0.1, coll=coll)
        set_mats(th, [M["linen"]])
        sh_st = [(0.292, 0, 0), (0.288, 0.016, 0), (0.280, 0.024, 0.0), (0.265, 0.027, 0.001),
                 (0.235, 0.030, 0.004), (0.200, 0.030, 0.004), (0.170, 0.028, 0.003), (0.130, 0.023, 0.002),
                 (0.100, 0.019, 0.001), (0.075, 0.016, 0), (0.060, 0.015, 0), (0.050, 0.014, 0),
                 (0.045, 0, 0)]
        rings = [ring((x, dy, z), (1, 0, 0), (0, 1, 0), r * 0.97, r, 32) for z, r, dy in sh_st[1:-1]][::-1]
        sh = loft(f"Shin.{sfx}", rings, cap0=(x, 0, 0.045), cap1=(x, 0, 0.292), u_rep=1, v_tile=0.25, coll=coll)
        set_mats(sh, [M["legpaint"]])
        objs[f"thigh.{sfx}"] = th; objs[f"shin.{sfx}"] = sh
        objs[f"foot.{sfx}"] = build_shoe(M, coll, x, sfx)
    return objs


def build_shoe(M, coll, x0, sfx):
    # y (heel +Y .. toe -Y), half width, bottom z, top z
    st = [(0.034, 0.012, 0.004, 0.060), (0.028, 0.017, 0.000, 0.068), (0.015, 0.020, 0.000, 0.070),
          (0.000, 0.021, 0.004, 0.066), (-0.015, 0.022, 0.004, 0.056), (-0.030, 0.023, 0.001, 0.045),
          (-0.045, 0.022, 0.001, 0.036), (-0.058, 0.019, 0.002, 0.029), (-0.066, 0.014, 0.004, 0.022),
          (-0.071, 0.008, 0.007, 0.017)]
    N = 40
    rings = []
    for y, w, zb, zt in st:
        zc, hz = (zb + zt) / 2, (zt - zb) / 2
        rings.append(ring((x0, y, zc), (1, 0, 0), (0, 0, 1), w, hz, N, 2.8))
    ob = loft(f"Shoe.{sfx}", rings, cap0=(x0, 0.036, 0.034), cap1=(x0, -0.0735, 0.012), u_rep=2, v_tile=0.1,
              coll=coll)
    me = ob.data
    me.polygons.foreach_set("material_index", [1 if p.normal.z < -0.6 else 0 for p in me.polygons])
    set_mats(ob, [M["shoe"], M["sole"] if sfx == "R" else M["sole_green"]])   # photo 3: lead (R), green (L)
    ob.modifiers.new("Subdivision", "SUBSURF").levels = 1
    return ob


# ============================================================================
# the dress: one welded single-layer garment (bodice + gathered skirt + sleeves)
# ============================================================================
BODICE = [  # z, a, bf, bb  (torso + ~0.005 H ease)
    (0.530, 0.092, 0.079, 0.059), (0.560, 0.091, 0.079, 0.058), (0.600, 0.089, 0.079, 0.057),
    (0.660, 0.087, 0.079, 0.055), (0.700, 0.090, 0.073, 0.055), (0.725, 0.098, 0.063, 0.053),
    (0.742, 0.091, 0.052, 0.047), (0.753, 0.068, 0.043, 0.043), (0.762, 0.050, 0.040, 0.044)]
SKIRT = [
    (0.170, 0.158, 0.102, 0.100), (0.230, 0.153, 0.102, 0.098), (0.300, 0.146, 0.101, 0.095),
    (0.380, 0.137, 0.100, 0.090), (0.430, 0.130, 0.098, 0.086), (0.470, 0.122, 0.095, 0.080),
    (0.495, 0.112, 0.090, 0.074), (0.515, 0.102, 0.085, 0.067), (0.530, 0.092, 0.079, 0.059)]
WAIST_Z, NECK_Z, HEM_Z = 0.530, 0.762, 0.170
V_BOTTOM, V_HALF = 0.664, 0.048
SLEEVE_R = [(0.100, 0.046), (0.130, 0.045), (0.160, 0.040), (0.180, 0.032), (0.187, 0.026), (0.193, 0.025),
            (0.199, 0.027), (0.215, 0.035), (0.232, 0.034), (0.244, 0.027), (0.250, 0.024), (0.256, 0.026),
            (0.272, 0.032), (0.290, 0.030), (0.300, 0.024), (0.306, 0.022), (0.312, 0.024), (0.325, 0.028),
            (0.336, 0.024), (0.342, 0.0175), (0.347, 0.0170), (0.352, 0.022), (0.358, 0.027)]
SLEEVE_BANDS = (0.193, 0.250, 0.306)
EDGE = 0.011   # target edge length (H units) ~ 3.9 mm on the real 35 cm puppet


def build_dress(M, coll):
    bod = Profile(["a", "bf", "bb"], BODICE)
    skt = Profile(["a", "bf", "bb"], SKIRT)
    N = 64
    ts = quadrant_params(0.089, 0.079, 0.057, N)

    # ---- common row heights from the side (shoulder) profile, equal arc length
    def side_rows(prof, z0, z1, n_hint=None):
        zz = np.linspace(z0, z1, 800)
        pts = np.array([(prof("a", z), 0.0, z) for z in zz])
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
        n = n_hint or max(2, int(round(L[-1] / EDGE)))
        return np.interp(np.linspace(0, L[-1], n + 1), L, zz)
    zb = side_rows(bod, WAIST_Z, NECK_Z)          # waist .. neckline (len nb+1)
    zs = side_rows(skt, WAIST_Z, HEM_Z)           # waist .. hem       (len ns+1)
    nb, ns = len(zb) - 1, len(zs) - 1

    # ---- V neckline: per column, height where the front surface meets the V
    def v_top(t):
        if math.cos(t) >= 0:
            return NECK_Z
        sx = abs(math.sin(t)) ** (2 / 2.2)
        lo, hi = V_BOTTOM, NECK_Z
        f = lambda z: bod("a", z) * sx - V_HALF * (z - V_BOTTOM) / (NECK_Z - V_BOTTOM)
        if f(hi) > 0:
            return NECK_Z
        for _ in range(40):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if f(mid) > 0 else (lo, mid)
        return (lo + hi) / 2

    # ---- gathers / soft folds on the skirt (radial offset, H units)
    rng = np.random.default_rng(7)
    phases = rng.uniform(0, 2 * math.pi, 6)

    def skirt_offset(t, z):
        k = (WAIST_Z - z) / (WAIST_Z - HEM_Z)                 # 0 waist .. 1 hem
        ramp = smoothstep(0.0, 0.08, k)
        gathers = 0.0045 * ramp * (1 - 0.55 * k) * math.cos(18 * t)
        folds = 0.0065 * ramp * k * (math.sin(5 * t + phases[0]) * 0.6 + math.sin(7 * t + phases[1]) * 0.4
                                     + math.sin(3 * t + phases[2]) * 0.3)
        return gathers + folds

    rows = []           # rows[r][j] -> (x,y,z) ; r = 0 hem ... ns waist ... ns+nb neckline
    for zi in zs[::-1]:
        row = []
        for t in ts:
            a, bf, bb = skt("a", zi), skt("bf", zi), skt("bb", zi)
            x, y = se_xy(t, a, bf, bb)
            d = skirt_offset(t, zi)
            r = math.hypot(x, y) + 1e-9
            row.append((x + x / r * d, y + y / r * d, zi))
        rows.append(row)
    vt = [v_top(t) for t in ts]
    for k in range(1, nb + 1):
        row = []
        for j, t in enumerate(ts):
            z = zb[k]
            if vt[j] < NECK_Z - 1e-6:
                z = WAIST_Z + (zb[k] - WAIST_Z) * (vt[j] - WAIST_Z) / (NECK_Z - WAIST_Z)
            x, y = se_xy(t, bod("a", z), bod("bf", z), bod("bb", z))
            row.append((x, y, z))
        rows.append(row)
    R = len(rows)
    waist_r = ns
    verts = [p for row in rows for p in row]
    vid = lambda r, j: r * N + (j % N)

    # ---- armholes: rectangular holes in the bodice grid at the side seams
    k_half = 5
    rh0 = waist_r + int(np.argmin(np.abs(zb - 0.655)))
    rh1 = waist_r + int(np.argmin(np.abs(zb - 0.742)))
    holes = {}
    for side, jc in ((1, N // 4), (-1, 3 * N // 4)):
        j0, j1 = jc - k_half, jc + k_half
        holes[side] = (j0, j1)

    def in_hole(r, j):
        for (j0, j1) in holes.values():
            if rh0 <= r < rh1 and j0 <= j < j1:
                return True
        return False

    faces, fuv, fmat, fregion = [], [], [], []
    # UVs in metres / tile (texture tile = 6 cm of real fabric)
    TILE = 0.06 / H
    ucum = np.zeros((R, N + 1))
    for r in range(R):
        P = np.array(rows[r] + [rows[r][0]])
        ucum[r, 1:] = np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))
    vcum = np.zeros((R, N))
    for r in range(1, R):
        vcum[r] = vcum[r - 1] + np.linalg.norm(np.array(rows[r]) - np.array(rows[r - 1]), axis=1)
    vcum -= vcum[waist_r]
    top_v = vcum[R - 1]
    for r in range(R - 1):
        for j in range(N):
            if in_hole(r, j):
                continue
            j1 = j + 1
            faces.append((vid(r, j), vid(r, j1), vid(r + 1, j1), vid(r + 1, j)))
            # center the u coordinate on the front so the grain is straight there
            fuv.append([((ucum[r, j] - ucum[r, N // 2]) / TILE, vcum[r, j] / TILE),
                        ((ucum[r, j1] - ucum[r, N // 2]) / TILE, vcum[r, j1 % N] / TILE),
                        ((ucum[r + 1, j1] - ucum[r + 1, N // 2]) / TILE, vcum[r + 1, j1 % N] / TILE),
                        ((ucum[r + 1, j] - ucum[r + 1, N // 2]) / TILE, vcum[r + 1, j] / TILE)])
            cz = (rows[r][j][2] + rows[r + 1][j][2]) / 2
            from_top = top_v[j] - (vcum[r, j] + vcum[r + 1, j]) / 2
            mat = 0
            if 0.522 < cz < 0.546:
                mat = 1                                   # velvet waist ribbon
            elif r >= waist_r and from_top < (0.013 if vt[j] >= NECK_Z - 1e-6 else 0.019):
                mat = 1                                   # velvet V / neckline trim
            fmat.append(mat)
            fregion.append("skirt" if r < waist_r else "bodice")

    # ---- sleeves, welded to the armhole boundary loops
    sleeve_info = {}
    for side, (j0, j1) in holes.items():
        loop = [vid(rh0, j) for j in range(j0, j1)] + [vid(r, j1) for r in range(rh0, rh1)] + \
               [vid(rh1, j) for j in range(j1, j0, -1)] + [vid(r, j0) for r in range(rh1, rh0, -1)]
        if side < 0:
            loop = loop[::-1]
        Mloop = len(loop)
        ay, az = SHOULDER[1], SHOULDER[2]
        lp = np.array([verts[i] for i in loop])
        psi = np.unwrap(np.arctan2(lp[:, 2] - az, lp[:, 1] - ay))
        direction = 1 if psi[-1] > psi[0] else -1
        psi_u = psi[0] + direction * 2 * math.pi * np.arange(Mloop) / Mloop
        x_start = float(np.max(np.abs(lp[:, 0]))) + 0.008
        rprof = pchip([s[0] for s in SLEEVE_R], [s[1] for s in SLEEVE_R])
        xs_ = [x_start]
        while xs_[-1] < SLEEVE_R[-1][0] - 1e-6:
            # finer steps around the gathered bands and the cuff
            near = min(abs(xs_[-1] - b) for b in SLEEVE_BANDS + (0.345,))
            xs_.append(min(xs_[-1] + (0.0055 if near < 0.012 else 0.0085), SLEEVE_R[-1][0]))
        ring_ids = [loop]
        sl_rows = [lp]
        for i, xa in enumerate(xs_):
            bl = smoothstep(0, 4, i + 1)                 # blend from hole shape to circle
            r0 = float(rprof(xa))
            pts = []
            for m in range(Mloop):
                ps = psi[m] * (1 - bl) + psi_u[m] * bl
                puff = smoothstep(0.024, 0.034, r0)
                wr = 1 + 0.07 * puff * math.sin(6 * ps + 40 * xa) + 0.04 * puff * math.sin(11 * ps - 25 * xa + 1.3)
                circ = np.array((side * xa, ay + r0 * wr * math.cos(ps), az + r0 * wr * math.sin(ps)))
                hole_pt = lp[m] + np.array((side * (xa - abs(lp[m][0])), 0, 0))
                c = smoothstep(0, 3, i + 1)
                pts.append(hole_pt * (1 - c) + circ * c)
            ids = list(range(len(verts), len(verts) + Mloop))
            verts.extend(tuple(p) for p in pts)
            ring_ids.append(ids); sl_rows.append(np.array(pts))
        # u along circumference (metres/tile), v along the sleeve
        for i in range(len(ring_ids) - 1):
            A, B = ring_ids[i], ring_ids[i + 1]
            xa = (abs(sl_rows[i][:, 0].mean()) + abs(sl_rows[i + 1][:, 0].mean())) / 2
            for m in range(Mloop):
                m1 = (m + 1) % Mloop
                faces.append((A[m], A[m1], B[m1], B[m]) if side > 0 else (A[m], B[m], B[m1], A[m1]))
                circ = 2 * math.pi * float(rprof(min(max(xa, 0.1), 0.358)))
                u0, u1 = m / Mloop * circ / TILE, (m + 1) / Mloop * circ / TILE
                v0, v1 = (i * 0.007) / TILE, ((i + 1) * 0.007) / TILE
                fuv.append([(u0, v0), (u1, v0), (u1, v1), (u0, v1)] if side > 0
                           else [(u0, v0), (u0, v1), (u1, v1), (u1, v0)])
                fmat.append(1 if any(abs(xa - b) < 0.0065 for b in SLEEVE_BANDS) else 0)
                fregion.append("sleeve")
        sleeve_info[side] = (ring_ids, [0.0] + [abs(x) for x in xs_])

    ob = make_mesh_object("Dress", verts, faces, coll, fuv, fmat)
    # orientation: outward from the body axis
    fix_normals(ob, outward_from=lambda c: Vector((0, 0, c.z)) if abs(c.x) < 0.1 * H
                else Vector((c.x, SHOULDER[1] * H, SHOULDER[2] * H)))
    set_mats(ob, [M["satin"], M["velvet"]])

    # ---- pin weights (1 = follows the skeleton, 0 = fully simulated)
    pin = np.zeros(len(verts))
    for r in range(R):
        for j in range(N):
            if r >= waist_r:
                pin[vid(r, j)] = 1.0                         # fitted bodice
            else:
                k = waist_r - r                              # rows below the waist
                pin[vid(r, j)] = (1.0, 0.5, 0.15)[k] if k < 3 else 0.0
    for side, (ring_ids, xs_) in sleeve_info.items():
        for i, ids in enumerate(ring_ids):
            xa = xs_[i] if i else 0.0
            w = (1.0, 0.3)[i] if i < 2 else 0.0             # armhole seam
            for b in SLEEVE_BANDS:                           # elastic bands (softer at the elbow)
                peak = 0.4 if abs(b - ELBOW_X) < 0.01 else 1.0
                w = max(w, peak * (1.0 - abs(xa - b) / 0.009))
            w = max(w, 1.0 - abs(xa - 0.345) / 0.007)        # gathered cuff
            for vi in ids:
                pin[vi] = max(pin[vi], min(1.0, w))
    vg = ob.vertex_groups.new(name="pin")
    for i, w in enumerate(pin):
        if w > 0:
            vg.add([i], float(w), "REPLACE")
    return ob, pin, sleeve_info, (rows, N, waist_r, R)


# ============================================================================
# armature
# ============================================================================
BONES = [  # name, head, tail, parent, connected, deform
    ("root", (0, 0, 0), (0, 0.15, 0), None, False, True),
    ("pelvis", (0, 0, 0.47), (0, 0, 0.53), "root", False, True),
    ("chest", (0, 0, 0.53), (0, 0, 0.745), "pelvis", True, True),
    ("neck", (0, -0.003, NECK_BASE), (0, -0.003, HEAD_PIVOT), "chest", False, True),
    ("head", (0, -0.003, HEAD_PIVOT), (0, -0.003, 0.99), "neck", True, True),
]
for s, sfx in ((1, "L"), (-1, "R")):
    BONES += [
        (f"upper_arm.{sfx}", (s * SHOULDER[0], SHOULDER[1], SHOULDER[2]), (s * ELBOW_X, SHOULDER[1], SHOULDER[2]),
         "chest", False, True),
        (f"forearm.{sfx}", (s * ELBOW_X, SHOULDER[1], SHOULDER[2]), (s * WRIST_X, SHOULDER[1], SHOULDER[2]),
         f"upper_arm.{sfx}", True, True),
        (f"hand.{sfx}", (s * WRIST_X, SHOULDER[1], SHOULDER[2]), (s * FINGER_X, SHOULDER[1], SHOULDER[2]),
         f"forearm.{sfx}", True, True),
        (f"thigh.{sfx}", (s * HIP[0], 0, HIP[2]), (s * HIP[0], 0, KNEE_Z), "pelvis", False, True),
        (f"shin.{sfx}", (s * HIP[0], 0, KNEE_Z), (s * HIP[0], 0, ANKLE_Z), f"thigh.{sfx}", True, True),
        (f"foot.{sfx}", (s * HIP[0], 0, ANKLE_Z), (s * HIP[0], -0.065, 0.02), f"shin.{sfx}", True, True),
    ]

# String attachment sockets (classic 9-string marionette). Bone head = attach point,
# tail points up towards the controller.
SOCKETS = [  # name, parent bone, position (H)
    # head strings: on the head's sides above the ears (head surface under the hat flaps, not on
    # the hat), in line with the head's centre of mass so the head hangs level
    ("string_head.L", "head", (0.058, 0.0, 0.905)), ("string_head.R", "head", (-0.058, 0.0, 0.905)),
    ("string_shoulder.L", "chest", (0.070, 0.000, 0.756)), ("string_shoulder.R", "chest", (-0.070, 0.000, 0.756)),
    ("string_back", "pelvis", (0.0, 0.068, 0.50)),
    ("string_hand.L", "hand.L", (0.395, -0.004, 0.714)), ("string_hand.R", "hand.R", (-0.395, -0.004, 0.714)),
    ("string_knee.L", "thigh.L", (0.047, -0.032, 0.29)), ("string_knee.R", "thigh.R", (-0.047, -0.032, 0.29)),
]
CTRL_Z = 1.75   # controller height in H units at rest (~26 cm above the hat)

# ---------------------------------------------------------------------------
# The real SKKG 9-string control cross (photos + hand sketches), in METRES,
# armature space (front = -Y). Sticks are 9 mm square. Names of the bars match
# the controller bones; the rocking bars pivot about an axis along the main bar.
#   main bar 16 cm (front-back) .. rear-end eye: back string
#   shoulder crossbar 11 cm, fixed, 2.5 cm from the rear end: shoulder strings
#   head bar ~9 cm, fixed, on a post below the shoulder cross: head strings
#   leg bar 12 cm on a 5 cm post, pin 3.5 cm down, rocks: knee strings
#   hand bar 15 cm on a pivot screw at the front tip, rocks: hand strings
# Estimates (not measured): head bar width and drop, hand bar pivot at its centre.
# ---------------------------------------------------------------------------
STICK = 0.009
CZ = CTRL_Z * H                       # height of the main bar's centreline
Y_SHOULDER = 0.0                      # shoulder cross right above the shoulders
Y_REAR = Y_SHOULDER + 0.025           # rear end of the 16 cm main bar
Y_FRONT = Y_REAR - 0.16
Y_LEG = Y_REAR - 0.125                # leg-bar post
HEAD_DROP = 0.04                      # head bar below the main bar (estimate)
HEAD_HALF, SHOULDER_HALF, LEG_HALF, HAND_HALF = 0.045, 0.055, 0.06, 0.075
LEG_PIN_DROP, LEG_POST = 0.035, 0.05
LEG_PIVOT = (0.0, Y_LEG - STICK, CZ - LEG_PIN_DROP)     # the bar sits in front of its post
HAND_PIVOT = (0.0, Y_FRONT - STICK / 2, CZ)             # the bar sits in front of the tip
EYE = STICK / 2                                          # eyes on the underside of the sticks

CROSS_BARS = [  # name, parent, pivot (metres), rocking axis or None, ControlInput.rock key
    ("CTRL_bar", None, (0.0, Y_SHOULDER, CZ), None, None),
    ("CTRL_legbar", "CTRL_bar", LEG_PIVOT, (0.0, -1.0, 0.0), "legs"),
    ("CTRL_handbar", "CTRL_bar", HAND_PIVOT, (0.0, -1.0, 0.0), "hands"),
]
CROSS_STICKS = [  # bar, a, b (metres): drawn as 9 mm square sticks
    ("CTRL_bar", (0, Y_REAR, CZ), (0, Y_FRONT, CZ)),
    ("CTRL_bar", (-SHOULDER_HALF, Y_SHOULDER, CZ), (SHOULDER_HALF, Y_SHOULDER, CZ)),
    ("CTRL_bar", (0, Y_SHOULDER, CZ), (0, Y_SHOULDER, CZ - HEAD_DROP)),
    ("CTRL_bar", (-HEAD_HALF, Y_SHOULDER, CZ - HEAD_DROP), (HEAD_HALF, Y_SHOULDER, CZ - HEAD_DROP)),
    ("CTRL_bar", (0, Y_LEG, CZ), (0, Y_LEG, CZ - LEG_POST)),
    ("CTRL_legbar", (-LEG_HALF, LEG_PIVOT[1], LEG_PIVOT[2]), (LEG_HALF, LEG_PIVOT[1], LEG_PIVOT[2])),
    ("CTRL_handbar", (-HAND_HALF, HAND_PIVOT[1], CZ), (HAND_HALF, HAND_PIVOT[1], CZ)),
]
# where each string ends on the cross: bar, eye position (metres)
STRING_TOP = {
    "string_back": ("CTRL_bar", (0.0, Y_REAR, CZ - EYE)),
    "string_shoulder.L": ("CTRL_bar", (SHOULDER_HALF, Y_SHOULDER, CZ - EYE)),
    "string_shoulder.R": ("CTRL_bar", (-SHOULDER_HALF, Y_SHOULDER, CZ - EYE)),
    "string_head.L": ("CTRL_bar", (HEAD_HALF, Y_SHOULDER, CZ - HEAD_DROP - EYE)),
    "string_head.R": ("CTRL_bar", (-HEAD_HALF, Y_SHOULDER, CZ - HEAD_DROP - EYE)),
    "string_knee.L": ("CTRL_legbar", (LEG_HALF, LEG_PIVOT[1], LEG_PIVOT[2] - EYE)),
    "string_knee.R": ("CTRL_legbar", (-LEG_HALF, LEG_PIVOT[1], LEG_PIVOT[2] - EYE)),
    "string_hand.L": ("CTRL_handbar", (HAND_HALF, HAND_PIVOT[1], CZ - EYE)),
    "string_hand.R": ("CTRL_handbar", (-HAND_HALF, HAND_PIVOT[1], CZ - EYE)),
}
# rest pose: upper arms rotated down from the generated horizontal arms (degrees)
ARM_HANG_DEG = 87       # hanging close to the body (the skirt gives way: see settle_dress)


def _new_armature(name, coll):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    coll.objects.link(ob)
    ob.show_in_front = True
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    return ob, arm.edit_bones


def build_armature(coll):
    """'MarionetteRig' = the game skeleton (deform bones + string sockets)."""
    v = lambda p: Vector(p) * H
    ob, eb = _new_armature("MarionetteRig", coll)
    ob.data.display_type = "STICK"
    for name, hd, tl, parent, conn, deform in BONES:
        b = eb.new(name); b.head = v(hd); b.tail = v(tl); b.use_deform = deform
        if parent:
            b.parent = eb[parent]; b.use_connect = conn
    for name, parent, pos in SOCKETS:
        b = eb.new(name); b.head = v(pos); b.tail = v((pos[0], pos[1], pos[2] + 0.03))
        b.parent = eb[parent]; b.use_deform = True          # deform (no weights) so exporters keep them
    for b in eb:                                              # arm bone rolls: Z up
        if b.name.startswith(("upper_arm", "forearm", "hand")):
            b.align_roll(Vector((0, 0, 1)))
    bpy.ops.object.mode_set(mode="OBJECT")
    cols = {n: ob.data.collections.new(n) for n in ("Deform", "Sockets")}
    for b in ob.data.bones:
        cols["Sockets" if b.name.startswith("string_") else "Deform"].assign(b)
    return ob


def rest_pose_arms_down(rig, meshes):
    """Turn the generated horizontal arms down into the hanging rest pose: pose the upper
    arms, bake the deformation into every skinned mesh, then make that pose the rest pose."""
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    for sfx, s in (("L", 1), ("R", -1)):
        pb = rig.pose.bones[f"upper_arm.{sfx}"]
        head = pb.bone.head_local
        # about the forward axis through the shoulder: +X arm (L) turns down for +angle about +Y
        rot = (Matrix.Translation(head) @ Matrix.Rotation(math.radians(s * ARM_HANG_DEG), 4, "Y")
               @ Matrix.Translation(-head))
        pb.matrix = rot @ pb.bone.matrix_local
    bpy.context.view_layer.update()
    bpy.ops.object.mode_set(mode="OBJECT")
    for ob in meshes:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.modifier_apply(modifier="Armature")
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    for ob in meshes:
        attach(ob, rig)


def settle_dress(dress, bodies, rig, margin=0.0016, radius=0.022, iters=15):
    """Lowering the arms folds the sleeve roots into the bodice and lays the arms against the
    skirt: relax the dress around the armpits (Laplacian smoothing), dent the skirt where the
    arms rest, and push every vertex that ended up inside a body part back out to the surface
    + margin, so the rest pose is collision-free for the cloth solver."""
    bm = bmesh.new(); bm.from_mesh(dress.data); bm.verts.ensure_lookup_table()
    # Taubin smoothing (shrink / inflate) around each shoulder joint: evens out the folded
    # armpit and the stretched sleeve cap without shrinking the sleeve puff
    joints = [rig.data.bones[f"upper_arm.{sfx}"].head_local for sfx in ("L", "R")]
    region = [v for v in bm.verts if v.link_edges and min((v.co - j).length for j in joints) < radius]
    for i in range(iters * 2):
        lam = 0.5 if i % 2 == 0 else -0.53
        new = {}
        for v in region:
            nb = [e.other_vert(v).co for e in v.link_edges]
            new[v] = v.co + (sum(nb, Vector()) / len(nb) - v.co) * lam
        for v, co in new.items():
            v.co = co
    # the skirt / bodice gives way where the forearms and hands rest against it: push those
    # vertices towards the body axis until they clear the limb (sleeve) capsules
    dl = bm.verts.layers.deform.verify()
    arm_groups = {vg.index for vg in dress.vertex_groups if vg.name.startswith(("upper_arm", "forearm", "hand"))}
    caps = []
    for sfx in ("L", "R"):
        for bone, r in ((f"forearm.{sfx}", 0.034 * H), (f"hand.{sfx}", 0.022 * H)):
            b = rig.data.bones[bone]
            caps.append((b.head_local.copy(), b.tail_local.copy(), r + margin))
    dented = []
    for v in bm.verts:
        if sum(w for g, w in v[dl].items() if g in arm_groups) > 0.3:
            continue                                    # the sleeves themselves
        for a, b, r in caps:
            ab = b - a
            t = max(0.0, min(1.0, (v.co - a).dot(ab) / ab.length_squared))
            c = a + ab * t
            d = v.co - c
            if d.length >= r:
                continue
            inward = Vector((-v.co.x, -v.co.y, 0)).normalized()
            for _ in range(40):                         # step inwards until outside the capsule
                v.co += inward * 0.0003
                if (v.co - c).length >= r:
                    break
            dented.append(v)
    ring = {e.other_vert(v) for v in dented for e in v.link_edges} | set(dented)
    for _ in range(4):                                  # soften the dent's rim
        new = {v: v.co * 0.6 + sum((e.other_vert(v).co for e in v.link_edges), Vector()) / len(v.link_edges) * 0.4
               for v in ring if v not in dented and v.link_edges}
        for v, co in new.items():
            v.co = co
    dg = bpy.context.evaluated_depsgraph_get()
    trees = [BVHTree.FromObject(o, dg) for o in bodies]
    moved = 0
    for _ in range(3):              # where two bodies meet (waist), pushing out of one can push into the other
        for v in bm.verts:
            for t in trees:
                loc, nrm, _, _ = t.find_nearest(v.co)
                if loc is None:
                    continue
                d = (v.co - loc).dot(nrm)
                if d < margin and (v.co - loc).length < 0.01:
                    v.co = loc + nrm * margin; moved += 1
    bm.to_mesh(dress.data); bm.free(); dress.data.update()
    return moved


def build_controller(rig, coll):
    """'MarionetteControls' = the real cross, used to animate / preview in Blender.
    Bars rock about their bone's local Y (along the main bar). The puppet hangs from
    CTRL_bar; IK targets at the hands and knees rise when their bar end rises (drivers)."""
    ctrl, eb = _new_armature("MarionetteControls", coll)
    ctrl.data.display_type = "OCTAHEDRAL"
    for name, parent, pivot, axis, _ in CROSS_BARS:
        b = eb.new(name); b.head = Vector(pivot); b.use_deform = False
        b.tail = b.head + Vector(axis or (0, -1, 0)) * 0.03
        if parent:
            b.parent = eb[parent]
    for name, (bar, eye) in STRING_TOP.items():                # where each string ends on the cross
        b = eb.new("ATT_" + name[len("string_"):])
        b.head = Vector(eye); b.tail = b.head + Vector((0, 0, 0.02 * H))
        b.parent = eb[bar]; b.use_deform = False
    # IK targets at the rest hand / knee positions, pointing up (local Y = world Z)
    targets = {}
    for sfx in ("L", "R"):
        for nme, bone in ((f"CTRL_hand.{sfx}", f"forearm.{sfx}"), (f"CTRL_knee.{sfx}", f"thigh.{sfx}")):
            b = eb.new(nme); b.head = rig.data.bones[bone].tail_local.copy()
            b.tail = b.head + Vector((0, 0, 0.04 * H)); b.parent = eb["CTRL_bar"]; b.use_deform = False
            targets[nme] = bone
    bpy.ops.object.mode_set(mode="OBJECT")
    c_att = ctrl.data.collections.new("StringEnds")
    c_ctl = ctrl.data.collections.new("Controls")
    for b in ctrl.data.bones:
        (c_att if b.name.startswith("ATT_") else c_ctl).assign(b)
    for name in ("CTRL_legbar", "CTRL_handbar"):
        ctrl.pose.bones[name].rotation_mode = "XYZ"
    # rocking: +angle about local Y (world -Y) lifts the puppet's left (+X) end. The targets
    # rise by as much as their eye, and move forward too: the strings run up to bars in front
    # of the puppet, and a straight hanging limb pulled exactly along itself gives IK no
    # direction to bend in
    for nme in targets:
        bar, half, forward = ("CTRL_handbar", HAND_HALF, 0.6) if "hand" in nme else ("CTRL_legbar", LEG_HALF, 1.5)
        sign = 1 if nme.endswith(".L") else -1
        for index, scale in ((1, 1.0), (2, forward)):           # local Y = world Z, local Z = forward
            fc = ctrl.pose.bones[nme].driver_add("location", index)
            drv = fc.driver; drv.type = "SCRIPTED"
            var = drv.variables.new(); var.name = "r"; var.type = "TRANSFORMS"
            var.targets[0].id = ctrl; var.targets[0].bone_target = bar
            var.targets[0].transform_type = "ROT_Y"; var.targets[0].transform_space = "LOCAL_SPACE"
            drv.expression = f"{scale:.2f} * max(0.0, {sign * half:.4f} * sin(r))"   # a string only lifts

    # the puppet hangs from the controller
    pb = rig.pose.bones["root"]
    c = pb.constraints.new("CHILD_OF"); c.target = ctrl; c.subtarget = "CTRL_bar"
    c.inverse_matrix = (ctrl.matrix_world @ ctrl.data.bones["CTRL_bar"].matrix_local).inverted()
    # IK so lifting the hand / knee strings moves the limbs (preview rig)
    for sfx in ("L", "R"):
        pb = rig.pose.bones[f"forearm.{sfx}"]
        c = pb.constraints.new("IK"); c.target = ctrl; c.subtarget = f"CTRL_hand.{sfx}"; c.chain_count = 2
        lim = JOINT_LIMITS[f"forearm.{sfx}"]                 # elbow = hinge about local Z
        pb.lock_ik_y = True; pb.use_ik_limit_x = True; pb.ik_min_x = pb.ik_max_x = 0.0
        pb.use_ik_limit_z = True; pb.ik_min_z = math.radians(lim["min"]); pb.ik_max_z = math.radians(lim["max"])
        pb = rig.pose.bones[f"thigh.{sfx}"]
        c = pb.constraints.new("IK"); c.target = ctrl; c.subtarget = f"CTRL_knee.{sfx}"; c.chain_count = 1
    return ctrl


def control_shapes(rig, coll):
    """Clickable widget shapes for the controller bones (animation preview rig)."""
    def widget(name, verts, edges):
        me = bpy.data.meshes.get(name) or bpy.data.meshes.new(name)
        me.clear_geometry(); me.from_pydata(verts, edges, []); me.update()
        ob = bpy.data.objects.new(name, me); coll.objects.link(ob)
        ob.hide_viewport = True; ob.hide_render = True
        return ob
    n = 24
    circ = widget("MAR_WGT_circle", [(math.cos(2 * math.pi * i / n), 0, math.sin(2 * math.pi * i / n))
                                     for i in range(n)], [(i, (i + 1) % n) for i in range(n)])
    line = widget("MAR_WGT_bar", [(0, 0, 0), (0, 1, 0), (0.05, 0.5, 0), (-0.05, 0.5, 0)], [(0, 1), (2, 3)])
    for pb in rig.pose.bones:
        if pb.name in ("CTRL_bar", "CTRL_handbar", "CTRL_legbar"):
            pb.custom_shape = line
        elif pb.name.startswith("CTRL_"):
            pb.custom_shape = circ; pb.custom_shape_scale_xyz = (0.6, 0.6, 0.6)
        if pb.name.startswith("CTRL_"):
            pb.color.palette = "THEME09"
        elif pb.name.startswith("string_"):
            pb.color.palette = "THEME03"


def skin_rigid(ob, rig, bone):
    vg = ob.vertex_groups.new(name=bone)
    vg.add(list(range(len(ob.data.vertices))), 1.0, "REPLACE")
    attach(ob, rig)


def attach(ob, rig):
    ob.parent = rig
    ob.matrix_parent_inverse = rig.matrix_world.inverted()
    mod = ob.modifiers.new("Armature", "ARMATURE"); mod.object = rig
    idx = ob.modifiers.find("Armature")
    if idx > 0:                                   # armature first in the stack
        ob.modifiers.move(idx, 0)


def seg_dist(p, a, b):
    ab = b - a; t = np.clip(np.dot(p - a, ab) / np.dot(ab, ab), 0, 1)
    return np.linalg.norm(p - (a + np.outer(t, ab)) if p.ndim > 1 else p - (a + t * ab), axis=-1)


def skin_dress(dress, rig, sleeve_info, grid):
    rows, N, waist_r, R = grid
    co = np.array([v.co / H for v in dress.data.vertices])
    bones = {b.name: (np.array(b.head_local) / H, np.array(b.tail_local) / H) for b in rig.data.bones}
    W = {}

    def add(name, idx, w):
        W.setdefault(name, np.zeros(len(co)))[idx] += w

    n_body = R * N
    body = np.arange(n_body)
    z = co[body, 2]
    # bodice: chest, blending to pelvis around the waist
    wp = np.clip((0.575 - z) / 0.06, 0, 1)
    add("chest", body, np.where(z >= WAIST_Z - 1e-6, 1 - wp, 0))
    add("pelvis", body, np.where(z >= WAIST_Z - 1e-6, wp, 0))
    # skirt: pelvis at the waist, sharing towards the thighs further down
    sk = z < WAIST_Z - 1e-6
    k = np.clip((WAIST_Z - z) / (WAIST_Z - HEM_Z), 0, 1)
    side_l = np.clip(0.5 + co[body, 0] / 0.12, 0, 1)
    wthigh = 0.55 * smooth_np(k)
    add("pelvis", body, np.where(sk, 1 - wthigh, 0))
    add("thigh.L", body, np.where(sk, wthigh * side_l, 0))
    add("thigh.R", body, np.where(sk, wthigh * (1 - side_l), 0))
    # bodice near the armhole follows the upper arm a little
    for s, sfx in ((1, "L"), (-1, "R")):
        d = np.linalg.norm(co[body] - np.array((s * 0.095, SHOULDER[1], SHOULDER[2])), axis=1)
        w = np.clip(1 - d / 0.05, 0, 1) ** 2 * 0.5 * (z >= WAIST_Z)
        for nme in ("chest", "pelvis"):
            W[nme][body] *= (1 - w)
        add(f"upper_arm.{sfx}", body, w)
    # sleeves
    for side, (ring_ids, xs_) in sleeve_info.items():
        sfx = "L" if side > 0 else "R"
        for i, ids in enumerate(ring_ids[1:], start=1):
            xa = xs_[i]
            ids = np.array(ids)
            c = smoothstep(0, 3, i)
            fw = smoothstep(ELBOW_X - 0.02, ELBOW_X + 0.02, xa)
            hw = 0.3 * smoothstep(0.34, 0.358, xa)
            add("chest", ids, (1 - c) * 0.5)
            add(f"upper_arm.{sfx}", ids, (1 - fw) * (c * 1 + (1 - c) * 0.5))
            add(f"forearm.{sfx}", ids, fw * (1 - hw) * c)
            add(f"hand.{sfx}", ids, fw * hw * c)
    total = sum(W.values()) + 1e-12
    for name, w in W.items():
        w = w / total
        vg = dress.vertex_groups.new(name=name)
        for i in np.nonzero(w > 1e-4)[0]:
            vg.add([int(i)], float(w[i]), "REPLACE")
    attach(dress, rig)


def smooth_np(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


# ============================================================================
# strings + controller visuals
# ============================================================================

def build_strings(M, rig, ctrl, coll):
    objs = []
    for name, parent, pos in SOCKETS:
        att = "ATT_" + name[len("string_"):]
        a = rig.data.bones[name].head_local
        b = ctrl.data.bones[att].head_local
        L = (b - a).length
        bm = bmesh.new()
        r = 0.00025
        bmesh.ops.create_cone(bm, cap_ends=False, segments=6, radius1=r, radius2=r, depth=L,
                              matrix=Matrix.Translation((0, L / 2, 0)) @ Matrix.Rotation(math.radians(-90), 4, "X"))
        me = bpy.data.meshes.new("String_" + name[7:]); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new("String_" + name[7:], me)
        coll.objects.link(ob); set_mats(ob, [M["string"]])
        c = ob.constraints.new("COPY_LOCATION"); c.target = rig; c.subtarget = name
        s = ob.constraints.new("STRETCH_TO"); s.target = ctrl; s.subtarget = att
        s.rest_length = L; s.volume = "NO_VOLUME"
        ob.hide_select = True
        objs.append(ob)
    # the wooden cross: 9 mm square sticks on their bar bones
    for i, (bone, p0, p1) in enumerate(CROSS_STICKS):
        p0 = Vector(p0); p1 = Vector(p1); d = p1 - p0
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=(STICK, STICK, d.length + STICK), verts=bm.verts)
        me = bpy.data.meshes.new(f"Controller_{i}"); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(f"Controller_{bone[5:]}_{i}", me); coll.objects.link(ob)
        set_mats(ob, [M["wood"]])
        world = Matrix.Translation((p0 + p1) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        ob.parent = ctrl; ob.parent_type = "BONE"; ob.parent_bone = bone
        bpy.context.view_layer.update()
        ob.matrix_world = world
    return objs


# ============================================================================
# physics: Blender preview cloth + colliders, and engine metadata
# ============================================================================
DENSITY = {"wood": 550.0, "stuffed": 250.0, "weighted_wood": 1800.0}
PART_MATERIAL = {"head": "wood", "neck": "wood", "hand": "wood", "shin": "wood", "foot": "weighted_wood",
                 "chest": "stuffed", "pelvis": "stuffed", "upper_arm": "stuffed", "forearm": "stuffed",
                 "thigh": "stuffed"}
# Joint limits (degrees, estimates for a loosely jointed marionette). Angles are rotations
# about the bone's LOCAL axes (Blender bone space: +Y runs along the bone). Hinge signs were
# verified by rotating each bone in the rig: +X on shin swings the lower leg backwards;
# forearm.L bends forwards for -Z, forearm.R for +Z (mirrored rolls).
JOINT_LIMITS = {
    "neck": {"type": "cone", "swing": 25, "twist": 30},
    "head": {"type": "cone", "swing": 30, "twist": 50},
    "chest": {"type": "cone", "swing": 20, "twist": 15},
    "upper_arm": {"type": "cone", "swing": 110, "twist": 60},
    "forearm.L": {"type": "hinge", "axis": "Z", "min": -150, "max": 0},
    "forearm.R": {"type": "hinge", "axis": "Z", "min": 0, "max": 150},
    "hand": {"type": "cone", "swing": 60, "twist": 30},
    # hip as a hinge (local X, like the knee; - lifts the knee forwards): the angled knee
    # strings of the cross would otherwise twist the legs, and the skirt with them
    "thigh": {"type": "hinge", "axis": "X", "min": -95, "max": 30},
    "shin": {"type": "hinge", "axis": "X", "min": 0, "max": 140},
    "foot": {"type": "cone", "swing": 35, "twist": 10},
}


def joint_limit(bone):
    return JOINT_LIMITS.get(bone) or JOINT_LIMITS.get(bone.split(".")[0])


# soft parts weighed by area (kg/m2): felt hat, ribbon rosette
FABRIC_GSM = {"Hat": 0.30, "HatRosette": 0.15}


def fabric_mass(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    area = sum(f.calc_area() for f in bm.faces)
    bm.free()
    return area * FABRIC_GSM[ob.name]


def mesh_volume(ob):
    """Closed meshes: enclosed volume. Open shells: area x solidify thickness."""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    if all(e.is_manifold for e in bm.edges):
        vol = abs(bm.calc_volume(signed=False))
    else:
        sol = next((m for m in ob.modifiers if m.type == "SOLIDIFY"), None)
        vol = sum(f.calc_area() for f in bm.faces) * (sol.thickness if sol else 0.001)
    bm.free()
    return vol


def setup_cloth(dress, colliders):
    cl = dress.modifiers.new("Cloth", "CLOTH")
    s = cl.settings
    s.quality = 12
    s.mass = 0.0004                       # kg / vertex (heavier than real satin -> stable preview)
    s.air_damping = 1.0
    s.tension_stiffness = 8; s.compression_stiffness = 8
    s.shear_stiffness = 4; s.bending_stiffness = 0.02
    s.tension_damping = 3; s.compression_damping = 3; s.shear_damping = 3
    s.vertex_group_mass = "pin"
    s.pin_stiffness = 1.0
    cs = cl.collision_settings
    cs.collision_quality = 4
    cs.distance_min = 0.0006
    cs.use_self_collision = False
    cl.point_cache.frame_start = 1; cl.point_cache.frame_end = 120
    ss = dress.modifiers.new("Subdivision", "SUBSURF"); ss.levels = 0; ss.render_levels = 1
    for ob in colliders:
        m = ob.modifiers.new("Collision", "COLLISION")
        ob.collision.thickness_outer = 0.0008
        ob.collision.cloth_friction = 5.0
        ob.collision.damping = 0.5


def pin_color_attribute(dress, pin):
    attr = dress.data.color_attributes.new("cloth_pin", "FLOAT_COLOR", "POINT")
    cols = []
    for w in pin:
        cols += [float(w), float(1 - w), 0.0, 1.0]   # R = pin weight, G = max-distance (1 = free)
    attr.data.foreach_set("color", cols)
    dress.data.color_attributes.active_color = attr
    dress.data.color_attributes.render_color_index = dress.data.color_attributes.find("cloth_pin")


def remove_loose(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data); bm.free(); ob.data.update()


def write_metadata(rig, ctrl, parts, dress, pin, path):
    bones = {}
    for b in rig.data.bones:
        if b.name.startswith(("CTRL_", "ATT_")):
            continue
        e = {"parent": b.parent.name if b.parent and not b.parent.name.startswith("CTRL_") else None,
             "head": [round(c, 5) for c in b.head_local], "tail": [round(c, 5) for c in b.tail_local],
             "deform": b.use_deform}
        key = b.name.split(".")[0]
        if b.name in parts:
            ob = parts[b.name]
            obs = ob if isinstance(ob, list) else [ob]
            mass = sum(fabric_mass(o) if o.name in FABRIC_GSM else
                       mesh_volume(o) * DENSITY[PART_MATERIAL.get(key, "wood")] for o in obs)
            co = np.array([v.co for o in (ob if isinstance(ob, list) else [ob]) for v in o.data.vertices])
            hd, tl = np.array(b.head_local), np.array(b.tail_local)
            radius = float(np.percentile(seg_dist(co, hd, tl), 90))
            e.update({"mass_kg": round(mass, 5),
                      "collider": {"type": "capsule", "radius": round(radius, 5),
                                   "a": [round(c, 5) for c in hd], "b": [round(c, 5) for c in tl]}})
            for tgt in (rig.data.bones[b.name], rig.pose.bones[b.name]):   # pose-bone props -> glTF extras
                tgt["mass_kg"] = round(mass, 5)
                tgt["collider_radius"] = round(radius, 5)
        jl = joint_limit(b.name)
        if jl:
            e["joint"] = jl
            rig.data.bones[b.name]["joint"] = json.dumps(jl)
            rig.pose.bones[b.name]["joint"] = json.dumps(jl)
        bones[b.name] = e
    strings = []
    r5 = lambda p: [round(c, 5) for c in p]
    for name, parent, pos in SOCKETS:
        a = rig.data.bones[name].head_local; t = ctrl.data.bones["ATT_" + name[7:]].head_local
        strings.append({"socket": name, "bone": parent, "position": r5(a),
                        "controller": STRING_TOP[name][0], "controller_point": r5(t),
                        "rest_length": round((t - a).length, 5)})
    controller = {
        "description": "SKKG 9-string cross: main bar with shoulder crossbar and head bar (fixed), "
                       "leg bar and hand bar rock about 'axis' (right-hand rule; + lifts the .L end)",
        "stick_size_m": STICK,
        "bars": [{"name": name, "parent": parent, "pivot": r5(pivot), "axis": list(axis) if axis else None,
                  "input": key,
                  "sticks": [{"a": r5(a), "b": r5(b)} for bar, a, b in CROSS_STICKS if bar == name]}
                 for name, parent, pivot, axis, key in CROSS_BARS],
    }
    edges = np.array([[dress.data.vertices[i].co for i in e.vertices] for e in dress.data.edges])
    el = np.linalg.norm(edges[:, 0] - edges[:, 1], axis=1)
    area = sum(p.area for p in dress.data.polygons)
    meta = {
        "units": "metres", "up": "+Z", "forward": "-Y", "height_m": H,
        "joint_limit_convention": "degrees about bone-local axes (Blender bone space, +Y along the bone); "
                                  "values are estimates, hinge signs verified in the rig",
        "assumptions": ["9-string layout and cross from the SKKG control cross (photos + sketches); "
                        "head bar size/drop and hand bar pivot estimated",
                        "rest pose: arms hanging",
                        "lead-weighted shoes (metal plates visible on the soles)",
                        "silk satin ~80 g/m2", "joint ranges"],
        "source": "SKKG Marionettenpuppe 46154 (CC0), 35 x 14 x 7.5 cm",
        "bones": bones, "strings": strings, "controller": controller,
        "cloth": {"mesh": "Dress", "vertices": len(dress.data.vertices), "faces": len(dress.data.polygons),
                  "area_m2": round(area, 5), "fabric": "silk satin ~80 g/m2",
                  "mass_kg": round(area * 0.08, 5),
                  "edge_length_m": {"min": round(float(el.min()), 5), "median": round(float(np.median(el)), 5),
                                    "max": round(float(el.max()), 5)},
                  "pin_attribute": "vertex colour 'cloth_pin' R = pin (1 skinned / 0 simulated), "
                                   "G = 1 - pin (max-distance style)",
                  "pin_vertex_group": "pin",
                  "suggested": {"stretch_stiffness": 0.9, "bend_stiffness": 0.02, "damping": 0.05,
                                "collision_thickness_m": 0.0008,
                                "colliders": "bones[*].collider capsules (pelvis, chest, thighs, arms)"}},
    }
    with open(path, "w") as f:
        json.dump(meta, f, indent=2, default=float)
    return meta


def make_demo_action(ctrl):
    """Demo of the cross: rest -> hand bar rocks (left hand up, then right) -> leg bar rocks
    (walking steps) -> whole cross bobs. Used to test skinning + cloth."""
    if ctrl.animation_data is None:
        ctrl.animation_data_create()
    act = bpy.data.actions.get("MAR_DemoPull") or bpy.data.actions.new("MAR_DemoPull")
    ctrl.animation_data.action = act
    rock = math.radians(30)
    keys = {  # frame: (hand bar angle, leg bar angle, bar lift in metres)
        1: (0, 0, 0), 15: (0, 0, 0), 30: (rock, 0, 0), 45: (-rock, 0, 0), 55: (0, 0, 0),
        65: (0, rock, 0), 75: (0, -rock, 0), 85: (0, rock, 0), 95: (0, 0, 0),
        105: (0, 0, 0.03), 120: (0, 0, 0)}
    bar, hands, legs = (ctrl.pose.bones[n] for n in ("CTRL_bar", "CTRL_handbar", "CTRL_legbar"))
    for f, (h, l, z) in sorted(keys.items()):
        hands.rotation_euler = (0, h, 0); hands.keyframe_insert("rotation_euler", frame=f)
        legs.rotation_euler = (0, l, 0); legs.keyframe_insert("rotation_euler", frame=f)
        bar.location = bar.bone.matrix_local.to_3x3().inverted() @ Vector((0, 0, z))
        bar.keyframe_insert("location", frame=f)
    for pb in (bar, hands, legs):
        pb.location = (0, 0, 0); pb.rotation_euler = (0, 0, 0)
    return act


def setup_preview_lights(coll):
    """Small studio rig scaled to the 35 cm puppet (preview only)."""
    for name, loc, energy, size, color in (
            ("MAR_Key", (0.35, -0.55, 0.55), 18.0, 0.35, (1.0, 0.96, 0.9)),
            ("MAR_Fill", (-0.55, -0.35, 0.30), 7.0, 0.5, (0.9, 0.95, 1.0)),
            ("MAR_Rim", (0.0, 0.55, 0.50), 10.0, 0.3, (1.0, 1.0, 1.0))):
        ld = bpy.data.lights.get(name) or bpy.data.lights.new(name, "AREA")
        ld.energy = energy; ld.size = size; ld.color = color
        ob = bpy.data.objects.new(name, ld); coll.objects.link(ob)
        ob.location = loc
        target = Vector((0, 0, 0.5 * H))
        ob.rotation_euler = (target - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


# ============================================================================
# main
# ============================================================================

def build():
    clear_previous()
    coll = get_collection()
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"; scene.unit_settings.scale_length = 1.0
    M = build_materials()
    body = sub_collection("Marionette_Body")
    cloth_c = sub_collection("Marionette_Cloth")
    ctrl_c = sub_collection("Marionette_Strings")

    head = build_head(M, body)
    hat, rosette = build_hat(M, body)
    collar = build_collar(M, body)
    pelvis, chest = build_torso(M, body)
    arms = build_arms(M, body)
    legs = build_legs(M, body)
    dress, pin, sleeve_info, grid = build_dress(M, cloth_c)

    rig = build_armature(coll)
    parts = {"head": [head, hat, rosette], "neck": collar, "pelvis": pelvis, "chest": chest}
    parts.update(arms); parts.update(legs)
    for bone, obs in parts.items():
        for ob in (obs if isinstance(obs, list) else [obs]):
            skin_rigid(ob, rig, bone)
    skin_dress(dress, rig, sleeve_info, grid)
    rest_pose_arms_down(rig, list(arms.values()) + [dress])
    settle_dress(dress, [chest, pelvis] + [arms[k] for k in arms if k.startswith("upper_arm")], rig)
    ctrl = build_controller(rig, coll)
    pin_color_attribute(dress, pin)
    remove_loose(dress)                       # grid points inside the armhole cut-outs
    colliders = [pelvis, chest] + [arms[k] for k in arms if not k.startswith("hand")] + \
                [legs[k] for k in legs if k.startswith(("thigh", "shin"))]
    setup_cloth(dress, colliders)
    build_strings(M, rig, ctrl, ctrl_c)
    setup_preview_lights(sub_collection("Marionette_Preview"))
    control_shapes(ctrl, sub_collection("Marionette_Widgets"))
    make_demo_action(ctrl)

    os.makedirs(os.path.join(ROOT, "export"), exist_ok=True)
    meta = write_metadata(rig, ctrl, parts, dress, pin, os.path.join(ROOT, "export", "marionette_rig.json"))
    scene.frame_start, scene.frame_end = 1, 120
    scene.frame_set(1)
    return rig, dress, meta


if __name__ == "__main__":
    rig, dress, meta = build()
    print("built", len(bpy.data.collections[COLL].all_objects), "objects;",
          "dress verts", meta["cloth"]["vertices"], "edge len", meta["cloth"]["edge_length_m"])
