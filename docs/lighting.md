# Stage lighting and follow spots

How the stage light is tuned in the app and in the code. The decisions behind it are in [architecture.md](architecture.md) (§2).

## Stage lighting: the light desk

The lighting is tuned live, not in code, on the light desk: one slider per parameter of the lighting rig. The desk is the **Licht** page of the scene editor (impro mode, the Licht button on the right); on the other pages **Lichtpult** in the debug button panel (debug mode: Shift+D or `?debug`) opens it. The rig follows the advice of a theatre lighting designer; every light is on a dimmer (0 … 100 %).

| Group on the desk | The light | Parameters |
|---|---|---|
| Vorderlicht (2 × 45°) | Two white lights out front, 45° above the stage and 45° to either side. Diffuse, over the full stage width. | Helligkeit, Farbtemperatur (3000 … 5600 K) |
| Profilscheinwerfer (Verfolger) | The focus light: one follow spot per puppet, on a bar in front of the stage, tracking it. Nearly parallel and hard, with a soft rim; the only light casting shadows. | Helligkeit, Farbtemperatur, Öffnung (beam angle, 8 … 45°), Weicher Rand (0 % is a hard edge), Strahl im Dunst (the beam drawn in the air) |
| Oberlicht | Area light above the stage: the mood light. 40 % in the neutral scene. | Helligkeit, Farbe |
| Seitenlicht (Gassen) | Area lights in the wings on both sides: plasticity. | Helligkeit, Farbtemperatur |
| Rampe (Fussrampe) | Striplight along the front edge of the stage, shining up at 45° into the faces. | Helligkeit, Farbe |
| Raum | Reflections of the room on the puppet's glossy materials, and a little light from everywhere. | Raumlicht |

The top, side and strip lights are area lights without a visible source. The renderer has no tone mapping, so light adds up to white: with several groups high, light clothes burn out. The painted backdrops are unlit; they take their tint from the dimmers (mostly the front light), so a dark scene also darkens the backdrop. A bright or coloured striplight shows as a thin line on the gold band at the foot of the wall behind the stage, which mirrors it.

**Lighting scenes** are named sets of these values. They form one library for all plays: a JSON file per scene in `assets/lights/` (Neutral is built in).

- The buttons at the top of the desk choose a scene, with a 1.5 s fade; **Licht: …** in the debug panel (or the L key) steps through them. `?light=morgenstimmung`, `?light=abenddaemmerung`, `?light=dramatisch` (the file name) starts in one.
- **Lichtszene speichern** with a name adds a new lighting scene, which every scene of every play can use from then on and which is a starting point for more. Without a name it overwrites the chosen one; that changes the light of every scene that uses it.
- With the dev server, saving writes `assets/lights/<id>.json` (commit it) and **Löschen** removes the file. A build cannot write: it keeps the scene in this browser and downloads the file, to be put into `assets/lights/` by hand.
- **Light of a play's scene:** choose the scene in the director bar, set the light on the Licht page, press **Speichern** in the director bar. The play file then holds `"light": { "scene": "<id>" }`; if sliders were moved without saving a lighting scene, their values are kept next to it. A scene without `light` is lit with Neutral.

A lighting scene file (colours as `"#rrggbb"`; a value left out is Neutral's):

```json
{
  "name": "Abenddämmerung",
  "values": { "front": 0.3, "frontKelvin": 3000, "spot": 0.22, "spotKelvin": 3200, "spotAngle": 20, "spotEdge": 0.6, "spotBeam": 0.18, "top": 0.55, "topColor": "#5a48e8", "side": 0.5, "sideKelvin": 3000, "strip": 0.3, "stripColor": "#ff6a3a", "room": 0.15 }
}
```

The scenes that come with the repo (dimmers in %):

| Scene | Idea | Vorderlicht | Profil | Oberlicht | Seitenlicht | Rampe | Raum |
|---|---|---|---|---|---|---|---|
| Neutral (built in) | Plain, even stage light | 50, 5600 K | 27, 5200 K, 17° | 40, warm white | 30, 5000 K | 10, warm white | 30 |
| Morgenstimmung | Daylight outdoors: bright and cool from the front and above, a low warm sun from the wings | 62, 5600 K | 10, 36°, very soft, no beam | 60, sky blue | 40, 4200 K | 15, pale yellow | 45 |
| Abenddämmerung | Dusk: little, warm front light, a low sun from the wings, violet from above, an orange glow from the strip | 30, 3000 K | 22, 3200 K, 20°, soft | 55, violet | 50, 3000 K | 30, orange | 15 |
| Dramatisch | Next to no front light, red from above, a narrow hard spot with its beam in the air | 3 | 40, 5600 K, 14°, hard, strong beam | 85, red | 35, 5600 K | 0 | 6 |

In the code (`src/stage/lighting.ts`): the `…_FULL` constants are what 100 % means for each light, `TOP_HEIGHT`, `SIDE_HEIGHT`, `SIDE_Y`, `STRIP_HEIGHT` and `STRIP_TILT` place the area lights (their width and depth come from the stage floor), `FADE_SECONDS` is the time a switch takes.

## Follow spots (`src/stage/spotlights.ts`)

The look of the spots (brightness, colour, beam angle, rim, haze) comes from the lighting scene, see above. What is fixed in the code:

| Constant | Value | What it changes |
|---|---|---|
| `BAR_Y`, `BAR_Z` | 1.2 m, 1.6 m | Height of the lighting bar and its distance in front of the stage centre: the angle the light comes in at. It has to stay under the top of the proscenium opening and out of the camera's view. |
| `SLOTS_X` | −0.5, 0.5, 0, −0.9, 0.9 m | Where the spots hang along the bar, in the order the puppets arrive. Off-centre gives the puppet some modelling shadow. |
| `DROP` | 0.1 m | How far the lens hangs below the bar. |
| `BEAM_PAST` | 1.2 | How far the drawn beam reaches past the puppet, in beam lengths (about to the floor). |
| `FOLLOW` | 6 /s | How fast the spot catches up with its puppet. Lower lags more, like a slow spot operator. |
| `MAX_SHADOW_SPOTS` | 3 (phones: 1) | How many spots cast shadows; shadow maps are costly on phones. |
