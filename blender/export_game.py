"""Export the deform skeleton, body parts and the cloth mesh for a game engine.
Run inside Blender after build_marionette.py. Writes export/marionette.glb and export/marionette.fbx.

- Strings, controller, widgets, lights are not exported (the game draws its own strings);
  string sockets are exported as bones named string_* (see export/marionette_rig.json).
- The Dress is exported in its rest state with skin weights; the cloth simulation
  is meant to run in the engine. Pin weights travel as vertex colour 'cloth_pin' (R).
"""
import bpy
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "export")


def export():
    os.makedirs(OUT, exist_ok=True)
    sc = bpy.context.scene
    sc.frame_set(1)
    rig = bpy.data.objects["MarionetteRig"]
    keep = [rig] + [o for o in bpy.data.collections["Marionette_Body"].all_objects] + \
           [o for o in bpy.data.collections["Marionette_Cloth"].all_objects]
    # rest pose, no cloth / preview subdivision during export
    saved_pose = rig.data.pose_position
    rig.data.pose_position = "REST"
    toggled = []
    for o in keep:
        for m in getattr(o, "modifiers", []):
            if m.type in ("CLOTH", "COLLISION") or (m.type == "SUBSURF" and o.name == "Dress"):
                toggled.append((m, m.show_viewport, m.show_render))
                m.show_viewport = m.show_render = False
    # Seam-free simulation proxy: glTF/FBX split vertices at UV seams and material borders
    # (the render Dress becomes ~9.8k verts in 2 primitives). Dress_Sim keeps the welded
    # 6520-vertex topology, skin weights and the cloth_pin colour, with no UVs / one material.
    src = bpy.data.objects["Dress"]
    sim = src.copy(); sim.data = src.data.copy(); sim.name = sim.data.name = "Dress_Sim"
    src.users_collection[0].objects.link(sim)
    while sim.data.uv_layers:
        sim.data.uv_layers.remove(sim.data.uv_layers[0])
    sim.data.materials.clear()
    sim.data.polygons.foreach_set("material_index", [0] * len(sim.data.polygons))
    for m in list(sim.modifiers):
        if m.type != "ARMATURE":
            sim.modifiers.remove(m)
    keep.append(sim)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in keep:
        o.hide_set(False); o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    try:
        glb = os.path.join(OUT, "marionette.glb")
        bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True,
                                  export_apply=True, export_skins=True, export_def_bones=True,
                                  export_animations=False, export_extras=True,
                                  export_vertex_color="ACTIVE", export_all_vertex_colors=False,
                                  export_yup=True)
        fbx = os.path.join(OUT, "marionette.fbx")
        bpy.ops.export_scene.fbx(filepath=fbx, use_selection=True, use_mesh_modifiers=True,
                                 add_leaf_bones=False, use_armature_deform_only=True, bake_anim=False,
                                 path_mode="COPY", embed_textures=True, colors_type="LINEAR",
                                 apply_unit_scale=True, use_custom_props=True)
    finally:
        me = sim.data
        bpy.data.objects.remove(sim, do_unlink=True); bpy.data.meshes.remove(me)
        for m, v, r in toggled:
            m.show_viewport, m.show_render = v, r
        rig.data.pose_position = saved_pose
    return glb, fbx


if __name__ == "__main__":
    print(export())
