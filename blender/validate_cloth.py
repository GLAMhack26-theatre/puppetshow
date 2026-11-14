"""Checks that the Dress mesh is usable for GPU cloth simulation. Run inside Blender.

Reports: topology (non-manifold / loose / boundary loops), edge-length spread for
simulated vs pinned regions, degenerate faces, folds (neighbouring faces facing each
other), faces of the dress cutting through each other, and whether any cloth vertex
starts inside (or too close to) a body collider in the current pose.
"""
import bpy
import bmesh
import collections
import numpy as np
from mathutils.bvhtree import BVHTree

COLLIDERS = ["Pelvis", "Chest", "Thigh.L", "Thigh.R", "UpperArm.L", "UpperArm.R",
             "Forearm.L", "Forearm.R", "Shin.L", "Shin.R"]


def validate(name="Dress", evaluated=True, margin=0.0005):
    ob = bpy.data.objects[name]
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    if evaluated:
        # deformed by the armature only (cloth result would be pose dependent)
        mods = [(m, m.show_viewport) for m in ob.modifiers if m.type in ("CLOTH", "SUBSURF")]
        for m, _ in mods:
            m.show_viewport = False
        dg.update()
        bm.from_object(ob, dg)
        for m, v in mods:
            m.show_viewport = v
    else:
        bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table()
    rep = {}
    rep["verts"], rep["faces"] = len(bm.verts), len(bm.faces)
    rep["tris"] = sum(1 for f in bm.faces if len(f.verts) == 3)
    rep["ngons"] = sum(1 for f in bm.faces if len(f.verts) > 4)
    rep["non_manifold_edges"] = sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary)
    rep["loose_verts"] = sum(1 for v in bm.verts if not v.link_faces)
    bnd = [e for e in bm.edges if e.is_boundary]
    adj = collections.defaultdict(list)
    for e in bnd:
        a, b = e.verts
        adj[a.index].append(b.index); adj[b.index].append(a.index)
    seen, loops = set(), 0
    for v in list(adj):
        if v in seen:
            continue
        loops += 1; st = [v]
        while st:
            x = st.pop()
            if x not in seen:
                seen.add(x); st += adj[x]
    rep["boundary_loops"] = loops       # expected 4: hem, neckline, 2 cuffs
    pin = np.zeros(len(bm.verts))
    g = ob.vertex_groups["pin"].index
    for v in ob.data.vertices:
        for ge in v.groups:
            if ge.group == g:
                pin[v.index] = ge.weight
    L = np.array([e.calc_length() for e in bm.edges])
    sim = np.array([min(pin[e.verts[0].index], pin[e.verts[1].index]) < 0.999 for e in bm.edges])
    for key, m in (("edges_all_mm", np.ones_like(sim)), ("edges_simulated_mm", sim)):
        x = L[m] * 1000
        rep[key] = {k: round(float(f(x)), 2) for k, f in (
            ("min", np.min), ("p5", lambda a: np.percentile(a, 5)), ("median", np.median),
            ("p95", lambda a: np.percentile(a, 95)), ("max", np.max))}
    rep["min_face_area_mm2"] = round(min(f.calc_area() for f in bm.faces) * 1e6, 3)
    rep["flipped_neighbour_faces"] = sum(1 for e in bm.edges if e.is_manifold and
                                         e.link_faces[0].normal.dot(e.link_faces[1].normal) < -0.5)
    # faces cutting through each other (e.g. a sleeve through the bodice); the fold count
    # above only sees neighbours. Faces sharing a vertex always touch: not counted
    bm.faces.ensure_lookup_table()
    own = BVHTree.FromBMesh(bm)
    rep["self_intersecting_face_pairs"] = sum(
        1 for a, b in own.overlap(own)
        if a < b and not {v.index for v in bm.faces[a].verts} & {v.index for v in bm.faces[b].verts})
    trees = [(n, BVHTree.FromObject(bpy.data.objects[n], dg)) for n in COLLIDERS if n in bpy.data.objects]
    inside, inside_pinned, close, mind = collections.Counter(), collections.Counter(), 0, 1.0
    for v in bm.verts:
        for n, t in trees:
            loc, nrm, _, dist = t.find_nearest(v.co)
            if loc is None:
                continue
            if (v.co - loc).dot(nrm) < 0:
                inside[n] += 1
                if pin[v.index] >= 0.5:            # a solver cannot push these out
                    inside_pinned[n] += 1
            elif dist < margin:
                close += 1
            mind = min(mind, dist)
    rep["verts_inside_colliders"] = dict(inside)
    rep["pinned_verts_inside_colliders"] = dict(inside_pinned)
    rep["verts_closer_than_margin"] = close
    rep["min_body_distance_mm"] = round(mind * 1000, 2)
    bm.free()
    return rep


if __name__ == "__main__":
    import json
    print(json.dumps(validate(), indent=1))
