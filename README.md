# Marionette Theatre, back in 3D

How can we bring the Marionette Paper Theatre back into the 3-dimensional space? What can be experienced in this theatre?

## Architecture

Decisions, setup and phases: [docs/architecture.md](docs/architecture.md)



## Marionette model (SKKG Marionettenpuppe 46154)

Procedural, rigged, cloth-ready Blender model of the SKKG marionette (CC0 photos in
`assets/`). Real size 35 x 14 x 7.5 cm, so the model is built at **H = 0.35 m**
(Z up, facing -Y, character left = +X / `.L`).

| File | What |
|---|---|
| `blender/marionette.blend` | The model, rig, controller, preview cloth sim and demo animation |
| `blender/build_marionette.py` | Rebuilds everything in the `Marionette` collection (all proportions live here, in units of H) |
| `blender/validate_cloth.py` | Cloth mesh checks: topology, edge lengths, body clearance, pinned penetrations |
| `blender/render_reference_check.py` + `tools/overlay_check.py` | Ortho renders framed like the reference photos, overlaid for proportion checks |
| `blender/export_game.py` | Writes `export/marionette.glb` and `export/marionette.fbx` |
| `export/marionette_rig.json` | Engine metadata: bones, masses, capsule colliders, joint limits, strings, cloth info |
| `tools/extract_textures.py` | Builds `assets/textures/*` from photo 3 (exposure from the colour chart, strings inpainted, face TPS-warped onto the head UVs) |

Rebuild: in Blender run `blender/build_marionette.py` (it only touches the `Marionette*` collections),
then `blender/export_game.py`.

### Construction
Carved wooden head, hands, lower legs, and lead-weighted shoes. Stuffed linen torso, upper arms
and thighs (the thigh is visible through the skirt tear in photo 3). Lacquered bonnet with a
ribbon rosette, ribbed turtleneck with a velvet ribbon. Every rigid part is skinned 100 % to one bone.

### Rig
* `MarionetteRig` is the game skeleton. It has `root`, `pelvis`, `chest`, `neck`, `head`,
  `upper_arm/forearm/hand.L/R` and `thigh/shin/foot.L/R`.
* It also has 9 string sockets (`string_head.L/R`, `string_shoulder.L/R`, `string_back`,
  `string_hand.L/R`, `string_knee.L/R`). A socket's head is the attach point; its tail points up.
* `MarionetteControls` is the wooden "airplane" controller used for animating in Blender:
  * `CTRL_bar` carries the puppet.
  * `CTRL_handbar` pulls the hands (IK).
  * `CTRL_legbar` pulls the knees (IK).
  * The `ATT_*` bones are the upper string ends.
* The visual strings use Stretch-To constraints. This armature is not exported.
* `MAR_DemoPull` action (frames 1-120): arms drop, left hand string pulled, knee string pulled,
  controller bob.

### Cloth (`Dress`)
* One welded single-layer quad mesh: bodice + gathered skirt + puffed sleeves sewn into the armholes.
  6520 verts, 0 non-manifold edges, 4 boundary loops (hem, neckline, 2 cuffs).
* Edges in the simulated region are about 1.4–4.9 mm (5th–95th percentile). The rest pose doesn't
  intersect the body.
* Velvet trims (V-neck, belt, sleeve bands) are a second material on the same mesh, not extra geometry.
* Pin weights:
  * vertex group `pin`, and vertex colour `cloth_pin` (exported as `COLOR_0`): R = pin (1 = skinned,
    0 = simulated), G = 1 − R (max-distance style);
  * bodice, waist, armhole seams, elastic bands and cuffs are pinned; the skirt and sleeve puffs are free;
  * no pinned vertex penetrates a collider in the demo poses.
* The dress is also skinned, so it works without simulation. Collider capsules and masses are in
  `export/marionette_rig.json`.
* The Blender cloth modifier is a preview only. Bake it from the Physics tab (about 30 s for 120 frames).
  * Open artifact: with the arms hanging, the stuffed upper arm shows faintly through the sleeve in a
    few spots. This is the collision margin of the preview solver at this scale.
* Export contents:
  * `export/marionette.glb` contains the render `Dress`. glTF splits it at UV seams and material
    borders (about 9.8k vertices, 2 primitives).
  * It also contains `Dress_Sim`: the same welded 6520-vertex cloth mesh with one primitive, no UVs,
    skin weights and `COLOR_0` pins. Simulate `Dress_Sim` and drive `Dress` from it (or weld `Dress`
    by position).

### Engine metadata, conventions and assumptions
* Bone extras in the GLB: `mass_kg`, `collider_radius`, `joint`.
* Joint limits are degrees about **bone-local** axes (+Y along the bone). The hinge signs were verified
  in the rig:
  * knee (`shin.*`): local X, 0…140°;
  * elbow: local Z, −150…0° on `forearm.L` and 0…150° on `forearm.R` (mirrored rolls).
* Assumptions (not visible in the photos):
  * the 9-string layout (photo 3 only shows head and hand threads);
  * lead-weighted shoes (metal plates on the soles);
  * satin of about 80 g/m²;
  * the joint ranges.
