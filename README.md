# Marionette Theatre, back in 3D

How can we bring the Marionette Paper Theatre back into the 3-dimensional space? What can be experienced in this theatre?

## Architecture

Decisions, setup and phases: [docs/architecture.md](docs/architecture.md)

## Tuning

### Stage lighting: the light desk

The lighting is tuned live, not in code: **Lichtpult** in the debug button panel (shown in debug mode: Shift+D or `?debug`) opens the light desk, with one slider per parameter of the lighting rig. The rig follows the advice of a theatre lighting designer; every light is on a dimmer (0 … 100 %).

| Group on the desk | The light | Parameters |
|---|---|---|
| Vorderlicht (2 × 45°) | Two white lights out front, 45° above the stage and 45° to either side. Diffuse, over the full stage width. | Helligkeit, Farbtemperatur (3000 … 5600 K) |
| Profilscheinwerfer (Verfolger) | The focus light: one follow spot per puppet, on a bar in front of the stage, tracking it. Nearly parallel and hard, with a soft rim; the only light casting shadows. | Helligkeit, Farbtemperatur, Öffnung (beam angle, 8 … 45°), Weicher Rand (0 % is a hard edge), Strahl im Dunst (the beam drawn in the air) |
| Oberlicht | Area light above the stage: the mood light. 40 % in the neutral scene. | Helligkeit, Farbe |
| Seitenlicht (Gassen) | Area lights in the wings on both sides: plasticity. | Helligkeit, Farbtemperatur |
| Rampe (Fussrampe) | Striplight along the front edge of the stage, shining up at 45° into the faces. | Helligkeit, Farbe |
| Raum | Reflections of the room on the puppet's glossy materials, and a little light from everywhere. | Raumlicht |

The top, side and strip lights are area lights without a visible source. The renderer has no tone mapping, so light adds up to white: with several groups high, light clothes burn out. The painted backdrops are unlit; they take their tint from the dimmers (mostly the front light), so a dark scene also darkens the backdrop. A bright or coloured striplight shows as a thin line on the gold band at the foot of the wall behind the stage, which mirrors it.

**Lighting scenes** are sets of these values:

- The list at the top of the desk chooses a scene; **Licht: …** (or the L key) steps through them with a 1.5 s fade. `?light=abend`, `?light=morgen`, `?light=dramatisch` (or a saved scene's key) starts in one.
- **Speichern** saves the desk's values under the name typed above it (empty: the current scene). Saved scenes live in this browser only (`localStorage`). Saving under the name of a built-in scene replaces it; **Zurücksetzen** brings the built-in one back, **Löschen** removes a scene of your own.
- **Als Code kopieren** copies the scene as an entry for `PRESETS` in `src/stage/lighting.ts`. That is the way a tuned scene gets into the repo, to the rest of the team and onto the phone.

Built-in scenes (dimmers in %):

| Scene | Vorderlicht | Profil | Oberlicht | Seitenlicht | Rampe | Raum |
|---|---|---|---|---|---|---|
| Neutral | 50, 5600 K | 27, 5200 K, 17° | 40, warm white | 30, 5000 K | 10, warm white | 30 |
| Abendstimmung | 30, 3000 K | 22, 3200 K, 20°, soft | 55, violet | 50, 3000 K | 30, orange | 15 |
| Morgenstimmung (outdoors) | 80, 5600 K | 10, 36°, very soft, no beam | 70, sky blue | 40, 5600 K | 20, pale yellow | 50 |
| Dramatisch | 3 | 40, 5600 K, 14°, hard, strong beam | 85, red | 35, 5600 K | 0 | 6 |

In the code (`src/stage/lighting.ts`): the `…_FULL` constants are what 100 % means for each light, `TOP_HEIGHT`, `SIDE_HEIGHT`, `SIDE_Y`, `STRIP_HEIGHT` and `STRIP_TILT` place the area lights (their width and depth come from the stage floor), `FADE_SECONDS` is the time a switch takes.

### Follow spots (`src/stage/spotlights.ts`)

The look of the spots (brightness, colour, beam angle, rim, haze) comes from the lighting scene, see above. What is fixed in the code:

| Constant | Value | What it changes |
|---|---|---|
| `BAR_Y`, `BAR_Z` | 1.2 m, 1.6 m | Height of the lighting bar and its distance in front of the stage centre: the angle the light comes in at. It has to stay under the top of the proscenium opening and out of the camera's view. |
| `SLOTS_X` | −0.5, 0.5, 0, −0.9, 0.9 m | Where the spots hang along the bar, in the order the puppets arrive. Off-centre gives the puppet some modelling shadow. |
| `DROP` | 0.1 m | How far the lens hangs below the bar. |
| `BEAM_PAST` | 1.2 | How far the drawn beam reaches past the puppet, in beam lengths (about to the floor). |
| `FOLLOW` | 6 /s | How fast the spot catches up with its puppet. Lower lags more, like a slow spot operator. |
| `MAX_SHADOW_SPOTS` | 3 (phones: 1) | How many spots cast shadows; shadow maps are costly on phones. |

## Marionette model (SKKG Marionettenpuppe 46154)

Procedural, rigged, cloth-ready Blender model of the SKKG marionette (CC0 photos in
`assets/`). Real size 35 x 14 x 7.5 cm, so the model is built at **H = 0.35 m**
(Z up, facing -Y, character left = +X / `.L`). Rest pose: arms hanging down.

| File | What |
|---|---|
| `blender/marionette.blend` | The model, rig, controller, preview cloth sim and demo animation |
| `blender/build_marionette.py` | Rebuilds everything in the `Marionette` collection (all proportions live here, in units of H) |
| `blender/validate_cloth.py` | Cloth mesh checks: topology, edge lengths, folds, self-intersections, body clearance, pinned penetrations |
| `blender/render_reference_check.py` + `tools/overlay_check.py` | Ortho renders framed like the reference photos, overlaid for proportion checks |
| `blender/export_game.py` | Writes `export/marionette.glb` and `export/marionette.fbx` |
| `export/marionette_rig.json` | Engine metadata: bones, masses, capsule colliders, joint limits, strings, cloth info |
| `tools/extract_textures.py` | Builds `assets/textures/*` from photo 3 (exposure from the colour chart, strings inpainted; face projected onto the head's 3D front surface from `head_front_depth.json`, TPS-corrected, hidden far cheek filled from the mirrored near side) |

Rebuild: in Blender run `blender/build_marionette.py` (it only touches the `Marionette*` collections),
then `blender/export_game.py`. The build also writes `assets/textures/head_front_depth.json`; after
changing the head shape run `tools/extract_textures.py` again and rebuild.

### Construction
Carved wooden head, hands, ivory-painted lower legs, and lead-weighted shoes (lead plate under the
right sole, green paint under the left). Stuffed linen torso, upper arms and thighs (the thigh is
visible through the skirt tear in photo 3). Soft black fabric hat with a ribbon rosette, ribbed
turtleneck with a velvet ribbon. Every rigid part is skinned 100 % to one bone.
The wooden arms are generated along X and turned down in two steps. First spread out a bit
(`ARM_SPREAD_DEG`, 45°): in this pose the sleeves are lofted around the arms (`sleeve_rings`), with a
fan of rings from the armhole over the sleeve cap, so armpit and shoulder come out clean. Then down
to the rest pose (`ARM_HANG_DEG`, 87°), where the same sleeve rings are lofted again around the
hanging arms, flattened where they lie against the bodice; the arms are never rotated into the dress
by skinning. `settle_dress` then dents the skirt where sleeves and hands rest on it and removes any
remaining intersection. `build(stage="spread")` stops at the spread pose for checking.

### Rig
* `MarionetteRig` is the game skeleton. It has `root`, `pelvis`, `chest`, `neck`, `head`,
  `upper_arm/forearm/hand.L/R` and `thigh/shin/foot.L/R`.
* It also has 9 string sockets (`string_head.L/R`, `string_shoulder.L/R`, `string_back`,
  `string_hand.L/R`, `string_knee.L/R`). A socket's head is the attach point; its tail points up.
* Head strings sit on the sides of the head above the ears (under the hat flaps), in line with
  the head's centre of mass.
* `MarionetteControls` is the real SKKG 9-string control cross (`CROSS_*` in the build script,
  sticks 9 mm square):
  * `CTRL_bar`: the 16 cm main bar (front-back) carries the puppet. Back string at its rear end,
    shoulder strings on the fixed 11 cm crossbar.
  * `CTRL_headbar`: the head bar, hinged at its centre on a post below the shoulder crossbar;
    rocking it (bone-local Y, up to ±45°) lifts one head string and lowers the other, so the head
    tilts (in Blender a preview driver on the head bone).
  * `CTRL_legbar`: 12 cm bar on a post under the middle; rocking it (bone-local Y) lifts one knee
    and lowers the other (walking). Knee IK targets follow by drivers.
  * `CTRL_handbar`: 15 cm bar on a pivot at the front tip; rocking it lifts one hand (IK). It only
    clings to the tip (like a magnet): the second hand can take it off and move the puppet's hands
    freely (`"detachable": true` in the rig JSON; the Blender rig only rocks it).
  * In `marionette_rig.json` each rocking bar has `limit_deg` (head 45°, legs 50°, hands 34.4°).
  * The `ATT_*` bones are the eyes (upper string ends). Head bar size/drop and the hand bar pivot
    are estimates, the head bar hinge and the detachable hand bar are as specified for the project
    (not measured on the object); the rest from the photos and hand sketches.
* The visual strings use Stretch-To constraints. This armature is not exported.
* `MAR_DemoPull` action (frames 1-120): hand bar rocks (left hand, then right), leg bar rocks
  (steps), head bar rocks (head tilts) while the cross bobs.

### Cloth (`Dress`)
* One welded single-layer quad mesh: bodice + gathered skirt + puffed sleeves sewn into the armholes.
  6520 verts, 0 non-manifold edges, 4 boundary loops (hem, neckline, 2 cuffs).
* Edges in the simulated region are about 1.4–5.0 mm (5th–95th percentile), median 3.4 mm, longest
  6.5 mm. In the rest pose (`validate_cloth.py`, last run): no folded face pairs, no faces cutting
  through each other, no vertex inside a collider. Under the arms the sleeve rings bunch up (edges
  down to 0.4 mm); that strip is pinned. The skirt dent under the arms is baked into the rest mesh,
  so it stays when the arms lift.
* Velvet trims (V-neck, belt, sleeve bands) are a second material on the same mesh, not extra geometry.
* Pin weights:
  * vertex group `pin`, and vertex colour `cloth_pin` (exported as `COLOR_0`): R = pin (1 = skinned,
    0 = simulated), G = 1 − R (max-distance style);
  * bodice, waist, armhole seams, elastic bands and cuffs are pinned, and the strip of each sleeve
    that is trapped between arm and body; the skirt and the rest of the sleeve puffs are free;
  * pinned vertices stay out of the colliders.
* The dress is also skinned, so it works without simulation. Collider capsules and masses are in
  `export/marionette_rig.json`.
* The Blender cloth modifier is a preview only. Bake it from the Physics tab (about 30 s for 120 frames).
  * Open artifact (preview only): once the knees lift (frame 60 on) the skirt crumples and rides
    up, because the lifted lower leg goes straight through it (the preview rig has no gravity on
    the shin). The dress stays on the body (x within about ±5.8 cm) through the whole demo.
* Export contents:
  * `export/marionette.glb` contains the render `Dress`. glTF splits it at UV seams and material
    borders (about 9.8k vertices, 2 primitives).
  * It also contains `Dress_Sim`: the same welded 6520-vertex cloth mesh with one primitive, no UVs,
    skin weights and `COLOR_0` pins. Simulate `Dress_Sim` and drive `Dress` from it (or weld `Dress`
    by position).

### Engine metadata, conventions and assumptions
* Bone extras in the GLB: `mass_kg`, `collider_radius`, `joint`.
* Joints (`bones[*].joint`) are one of three types; angles are degrees about **bone-local** axes
  (+Y along the bone), ± from the rest pose:
  * `cone` (`swing`: leaning off the rest direction, `twist`: turning about the bone): waist 20/15,
    head 45/70, shoulders 110/60, wrists 60/30;
  * `hinge` (`axis`, `min`, `max`; signs verified in the rig):
    * knee (`shin.*`): local X, 0…140°;
    * hip (`thigh.*`): local X, −95…30° (− lifts the knee forwards); a hinge so the angled knee
      strings don't twist the legs;
    * elbow: local Z, −150…0° on `forearm.L` and 0…150° on `forearm.R` (mirrored rolls);
  * `fixed` (rigid on the parent, no joint):
    * the feet: a marionette's shoes are mounted on the shins at 90° (standing), without an ankle
      joint. Their collider is a capsule lying along the sole, so the puppet stands flat;
    * the neck (collar piece): part of the torso; the head has one joint on top of it.
* Assumptions (not visible in the photos):
  * the string-to-bar layout of the cross (from the photos and hand sketches);
  * lead-weighted shoes (metal plates on the soles);
  * satin of about 80 g/m²;
  * the joint ranges.
