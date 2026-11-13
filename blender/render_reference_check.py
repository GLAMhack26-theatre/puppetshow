"""Render orthographic views framed exactly like the reference photos, for overlay checks.

Run inside Blender after build_marionette.py. Writes /tmp/marionette_check_{front,side}.png
(override with env MARIONETTE_CHECK_DIR). tools/overlay_check.py blends them with the photos.
"""
import bpy
import os
import math
from mathutils import Euler

H = 0.35
OUT = os.environ.get("MARIONETTE_CHECK_DIR", "/tmp")

# (image size, px per H, pixel of world origin (x or y axis, ground)) measured on the photos
VIEWS = {
    # T-pose photo: hat top y=112, sole y=1050, body centre x=452
    "front": dict(res=(896, 1200), px_per_h=938.0, origin_px=(452.0, 1050.0), cam="front"),
    # photo 1 side view: neck axis x=451 (world y=0), ground y=1047
    "side": dict(res=(843, 1264), px_per_h=862.0, origin_px=(451.0, 1047.0), cam="side"),
    # photo 1 front view (hanging arms): body centre x=175, ground y=1047 -> render at a hanging frame
    "front_hang": dict(res=(843, 1264), px_per_h=862.0, origin_px=(175.0, 1047.0), cam="front", frame=45),
}


def render(view):
    v = VIEWS[view]
    sc = bpy.context.scene
    cam_data = bpy.data.cameras.get("MAR_CheckCam") or bpy.data.cameras.new("MAR_CheckCam")
    cam = bpy.data.objects.get("MAR_CheckCam") or bpy.data.objects.new("MAR_CheckCam", cam_data)
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cam_data.type = "ORTHO"
    w, h = v["res"]
    m_per_px = H / v["px_per_h"]
    cam_data.ortho_scale = max(w, h) * m_per_px
    cx = (w / 2 - v["origin_px"][0]) * m_per_px          # horizontal world offset of image centre
    cz = (v["origin_px"][1] - h / 2) * m_per_px          # height of image centre
    if v["cam"] == "front":
        cam.location = (cx, -2.0, cz); cam.rotation_euler = Euler((math.pi / 2, 0, 0))
    else:  # camera on +X looking at -X: image right = +Y
        cam.location = (2.0, cx, cz); cam.rotation_euler = Euler((math.pi / 2, 0, math.pi / 2))
    cam_data.clip_end = 10
    frame_before = sc.frame_current
    sc.frame_set(v.get("frame", 1))
    old = (sc.camera, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage,
           sc.render.filepath, sc.render.film_transparent)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.film_transparent = True
    sc.render.filepath = os.path.join(OUT, f"marionette_check_{view}.png")
    hidden = []
    for ob in bpy.data.collections["Marionette"].all_objects:
        if ob.name.startswith(("String_", "Controller_")) and not ob.hide_render:
            ob.hide_render = True; hidden.append(ob)
    bpy.ops.render.render(write_still=True)
    for ob in hidden:
        ob.hide_render = False
    sc.frame_set(frame_before)
    (sc.camera, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage,
     sc.render.filepath, sc.render.film_transparent) = old
    return os.path.join(OUT, f"marionette_check_{view}.png")


if __name__ == "__main__":
    for v in VIEWS:
        print(render(v))
