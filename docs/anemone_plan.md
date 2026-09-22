# Plan: Swap Reefscape's host anemone for the rigged Blender model

Status: proposal. Nothing here is built yet.

## Goal

Replace the procedural host anemone in Reefscape (`scenes/reefscape/src/anemone.js`, the
first entry of `ANEMONES` in `layout.js`) with the rigged model in `3d_models/anemone.blend`.
Blender provides only the model and the rig. All of the animation is done in three.js.
Then make it move like a living animal: it should sway in the pump current, react when the
clownfish bathe in it, grab food, and pull in when startled. The four small compact
anemones stay procedural for now (see Later).

"Realistic" here means behaviour based on how host anemones really act, run as cheap
springs and rules. It is not a fluid simulation. The scene is a wallpaper that runs for
hours on laptops, so the anemone has to stay within the frame budget the current one uses.

## What exists today

- **Host rendering.** `anemone.js` draws one merged body mesh for all five specimens, plus
  one `InstancedMesh` for every tentacle (about 168 on the host, from
  `round(110·S^1.3)`). The vertex shader bends each tentacle as an arc, plus a sway
  term from `reefResponse()`. That is the GPU copy of the pump-flow model in `water.js`,
  low-pass filtered per tentacle with a time constant `tau`, so long tentacles lag behind.
  Nothing on the CPU tracks tentacle state, and the fish can't touch it.
- **Quality levels.** `crownBudget()` keeps 57% of the tentacles on `eco`, 70% on
  `balanced` and 100% above that. They are sorted by `crownOrder()` (farthest-point) so
  every setting still covers all six angular sectors of the crown.
- **Fish.** In `simulation.js` the clownfish choose goals around `HOST`. About a third of
  their outings are a **bathe**: `hold > 0`, `state === 'bathe'`, with a goal only
  0.20–0.46 above the disc, so the fish dives into the crown. On an alarm they shelter at
  `HOST`. Other fish are pushed away from a sphere of radius 2.4 around the host. Food
  pellets (`simulation.food`) sink, and fish eat them.
- **Determinism.** The capture mode (`?capture&time=`) and `window.reef.advance()` call
  only `simulation.step(FIXED_STEP)`, with `FIXED_STEP = 1/60`. Anything that has to
  replay the same way twice must be advanced inside `simulation.step`.
- **Assets.** There is no glTF anywhere. Assets are custom binaries (`live-rock.bin`,
  `rock-support.bin`) baked by the Python scripts in `tools/`, loaded with `fetch`, and
  validated in `tests/assets.mjs`. `vendor/` holds only the three.js core, not its
  add-ons.
- **Shading.** Every organism uses the `underwater()` material wrapper in `water.js`
  (caustics, extinction, transmission). Shadows are baked once (`shadowMap.autoUpdate =
  false`), and moving organisms don't cast them.

## The model as it stands

`3d_models/build_anemone.py` builds the whole thing. `anemone.blend` is its saved output.
The units are tank units (1 BU = 10 cm), and Z is up in Blender.

| Part | Contents |
|---|---|
| `Anemone_Body` | Short stub column (the upper 2/5 of the host's column), a flared rim, a domed oral disc and a slit mouth. About 5.9k verts, colours stored per vertex. |
| `Anemone_Tentacles` | 96 tentacles, 27k verts, yellow shafts with white tips. UV `v` runs from the root (0) to the tip (1). |
| `Anemone_Rig` | 389 bones: `root`, `column.01–03`, `disc`, and `tentacle.NNN.01–04`. Local **X** is each tentacle's bend axis (+X curls it outward, −X inward), and **Z** swings it sideways. Each base bone carries `ring`, `angle` and `phase`. |

Every vertex has at most 2 bone influences, so skinning is cheap.

## Architecture

Blender does the model and the rig, and nothing else: no actions, keyframes or drivers.
Every movement is made in three.js at runtime.

```
3d_models/anemone.blend              model + rig, authored/built in Blender
   │  File ▸ Export ▸ glTF 2.0 (.glb): skinning on, animation off, custom props on
   ▼
scenes/reefscape/assets/host-anemone.glb   (mesh, skin, 389-bone skeleton, vertex colors)
   │  GLTFLoader (vendored)
   ▼
host-anemone.js        takes the SkinnedMeshes, swaps in underwater() materials, LOD
host-dynamics.js       pure JS: per-bone angular springs, contacts, behaviour states
   ▲  stepped from ReefSimulation.step(), so it stays deterministic
simulation.js          fish ⇄ anemone coupling (bathing, food, alarm, avoidance)
```

### 1. Export: a plain GLB, no animation

Export straight from Blender's glTF exporter. It handles the pieces that matter:

- It converts Z-up to Y-up.
- It writes the skin: joints, inverse bind matrices, and `JOINTS_0`/`WEIGHTS_0`.
- It writes the `Col` attribute as `COLOR_0`, and UVs as `TEXCOORD_0`.
- Bone custom properties (`ring`, `angle`, `phase`) go into glTF `extras`, which
  `GLTFLoader` puts on each bone's `userData`. The dynamics read their per-tentacle
  parameters straight from the skeleton.

Export settings:
- Include: selected objects only (the `Anemone` collection).
- Custom Properties on.
- Skinning on.
- Animation **off**.
- Draco off: the geometry is small, and it saves vendoring a decoder.

Expect a file of about 2–3 MB.

**The loader.** `vendor/` has only the three.js core (r180). Add
`vendor/addons/loaders/GLTFLoader.js` and `vendor/addons/utils/BufferGeometryUtils.js`,
both from the same r180 release, so they match the core. The import map already resolves
`three`, and the loader imports nothing else. That's the one new dependency, and it's
first-party three.js.

**What's still done in three.js, not the exporter:**
- **Tentacle order for the quality levels.** At load time, group the tentacle triangles by
  the base bone of their chain. Then reorder the index buffer farthest-point first, using
  each base bone's `angle` and `ring` and the existing `crownOrder()` logic. A quality level
  then becomes a single `drawRange`.
- **Scale.** Fit the crown to `HOST.radius` with a uniform scale on the root object (see
  below).
- **Shader data.** Put per-tentacle `ring` and `seed` into a small vertex attribute, looked
  up from each vertex's skin index.

The build script stays the source of the model. Re-running `3d_models/build_anemone.py`
and re-exporting is the whole asset pipeline. A small `tools/export-anemone.py` can do
that export headlessly, so it runs the same way every time:

```
blender -b 3d_models/anemone.blend -P tools/export-anemone.py
```

**Placement.** `HOST` stays the single source of truth: `x, y, z` is the centre of the
oral disc, and `lean` tilts the axis. The loader places the model so its disc centre lands
on `HOST`, with the same lean-and-slope frame that `specimen()` uses today.

The stub brings one real change. I measured the rock under the current `HOST`: the rock
surface there is 0.88 below the disc, and the baked rock surface is 2.68 under where the
stub's base would land. **At the current `HOST.y` the stub's base would float about 0.55
(5.5 cm) above the rock.** There are two options:

- **(a) Recommended:** lower `HOST.y` from 3.72 to about 3.20, so the stub sits down into
  the shoulder of the rock, the way a real host nestles into a crevice. The clownfish
  goals, shelter and avoidance all key off `HOST`, so they follow it automatically. I'd
  still check the `views.js` framing afterwards.
- **(b)** Add an invisible "sunk" skirt under the stub in `build_anemone.py`, like the one
  `bodyGeometry` builds today, and leave `HOST` where it is. That undoes the look you asked
  for, though, because the column would show again.

A test asserts that the base of the stub ends up below `supportHeight()` at its footprint.

**Scale.** The model's crown reaches 1.39, and `HOST.radius` is 1.25. I'd scale the model
uniformly by 0.90 at load, so none of the fish behaviour needs retuning. The other
option is to raise `HOST.radius` to 1.39 and accept an 11% wider clownfish range.

### 2. Rendering: `host-anemone.js`

- Two `THREE.SkinnedMesh`es, body and tentacles, sharing one `Skeleton` of 389 bones.
  WebGL2 keeps bone matrices in a texture, so the bone count isn't a problem.
  - This replaces one instanced draw with two skinned draws.
  - The host's vertex count drops from about 44k (168 × 260 in instances) to about 33k.
- **Materials.** `GLTFLoader` gives a plain `MeshStandardMaterial`. Replace it with
  `underwater(new MeshStandardMaterial({vertexColors: true}), …)`. The wrapper computes `vReefWorld` from `transformed` after `#include <worldpos_vertex>`, and
  three.js has already applied skinning to `transformed` by then, so caustics and
  extinction follow the pose. This needs a check on screen, because the wrapper's
  `USE_INSTANCING` branch was written for the instanced version.
- **Porting the tentacle look.** I'd move today's per-fragment effects onto `uv.y` (the
  axis) plus the per-tentacle `ring` and `seed` attribute built at load (section 1):
  - the mottled pigment;
  - "buried" darkening deep inside the crown;
  - light glowing through the thin tentacle edges;
  - more light passing through toward the tips.

  The yellow and white colours stay as you picked them. The existing shader's comment warns
  that under the reef lamp a brighter gold turns cream. Expect a round of in-scene tuning
  from capture screenshots, so the tips read white and not blown out.
- **Quality levels.** The tentacle triangles are reordered farthest-point first at load
  time (section 1), so `eco` and
  `balanced` only set `geometry.drawRange` to 57% or 70% of the index count. That's the
  same coverage guarantee as `crownBudget()`, with no rebuild. The hidden tentacles' bones
  are skipped in the dynamics too.
- **Changes to `anemone.js`.** It builds only `ANEMONES.slice(1)`, meaning the compact
  specimens. `main.js` awaits `createHostAnemone(scene, simulation)` next to
  `createAnemone(scene)`, and `diagnostics()` reports the host's tentacles and bones.
- **Shadows.** The body keeps `castShadow` and is baked into the static map in its rest
  pose. Sway is small at the column, so the mismatch won't show. The tentacles cast no
  shadow, the same as today.

### 3. Motion: `host-dynamics.js`

A pure module with no three.js dependency, working on typed arrays, so node tests can
drive it. `ReefSimulation` owns an instance (`this.host`) and calls
`this.host.step(dt, this)` once per `FIXED_STEP`. Capture mode and `advance()` then replay
it exactly.

**State.** Every tentacle joint has two angles, curl (about X) and swing (about Z), plus
their velocities. That's 384 joints × 4 floats. The column gets two sway angles per bone,
and the disc gets a contraction scalar.

**Integration.** Semi-implicit Euler with angular springs, damped slightly past critical
(tissue in water doesn't ring):

```
θ̈ = −k_j (θ − θ_target) − c_j θ̇ + τ_flow + τ_contact
```

- **Stiffness** falls toward the tip: `k` ≈ 1 : 0.6 : 0.35 : 0.2. A push from the flow or
  a fish bends the tips first and ripples down the tentacle, which reads as soft tissue.
- **Flow torque.** Use `responseAt(p, t, tau)`, the CPU twin of the GPU `reefResponse`,
  at each bone's head. Take its component perpendicular to the bone, in the bone's local
  X/Z frame, and scale it by segment length times girth.
  - Per-tentacle `tau` comes from length plus `phase`, so the crown ripples rather than
    swinging in lockstep, the way today's `aCurve.z` lag works.
  - A small seeded low-frequency wobble per tentacle adds the independent twitching real
    tentacles show.
- **Column.** It sways on the same flow with a long `tau` (about 2 s) and a small limit
  (about 6°). The disc takes its tilt, and every tentacle chain hangs off the disc, so the
  whole crown rides along.
- **Pose output.** The step writes local quaternions into a `Float32Array`. The renderer
  copies them into the `Bone`s once per rendered frame. It doesn't interpolate between
  steps, just as the fish don't.

**Cost.** About 1.5k joint updates per step, plus forward kinematics for the contact tests.
That's roughly 0.1–0.2 ms of JS at 60 Hz. On `eco`, the dynamics run every other step and
skip the tentacles that aren't drawn.

### 4. Fish ⇄ anemone interaction

These are the behaviours, most important first. Each is based on something real host
anemones and clownfish do.

1. **Clownfish bathing.** The clownfish is the host's only visitor. It rubs and wriggles
   through the tentacles to keep its protective coat of the anemone's mucus.
   - Treat each clownfish as a capsule: its own length along its heading, radius about 0.2
     of its length.
   - Test the capsule against the tentacle segments near it. Only fish within
     `HOST.radius + 1` qualify, and at most 3–4 clownfish, so this is cheap.
   - Where they overlap, a torque pushes the segment out, and a tangential drag pulls it
     along the fish's velocity and its tail and pectoral wiggle. The tentacles part around
     the fish, drape over its back and sweep back once it leaves.
   - During `bathe`, the fish's `hold` goal sinks to the actual disc height from the
     dynamics, not a fixed `HOST.y + .20`, so it really goes down between the tentacles.
2. **Feeding.** A pellet (from a click) that sinks into the crown gets caught.
   - The test is a pellet within about 1.5 girths of a tentacle's tip segment, while
     sinking slowly.
   - That tentacle's curl target swings toward the mouth over 3–5 s, carrying the pellet
     pinned to its tip bone. Two or three neighbours join in at half strength.
   - When the tip reaches the mouth, the mouth "gulps" and the pellet counts as consumed.
     This needs a small `mouth` bone added to the Blender rig: a scale on the lip vertices.
   - Clownfish sometimes carry food to their host. That can be an extension later: a fed
     clownfish, near the host, drops its pellet into the crown instead of eating it.
3. **Startle and retraction.** Anemones pull in their tentacles when disturbed.
   - Triggers: a fast pointer sweep near the host (the existing `pointer.speed` alarm), or
     all the clownfish going into `shelter` at once.
   - Response: the tentacles curl inward and shorten through bone Y-scale down to about
     0.8, and the disc scales to about 0.85. It happens in about 1.5 s.
   - It then re-expands slowly, over 20–40 s, as a real anemone does.
   - While it is contracted, the crown envelope the simulation uses shrinks, so sheltering
     clownfish hold tighter, and the avoidance sphere for other fish shrinks too.
4. **Other fish.** They're already steered away. If one still touches the tentacles (the
   test is rare and cheap), those tentacles stick to it for a moment and curl toward it,
   and the fish gets a small `spook` to flinch away. That's the sting reaction.
5. **Idle life.** A slow inflate and deflate over a few minutes: disc scale ±3% and
   tentacle length ±5%. The shape stays on the slow, calm timescale of a wallpaper.

Everything the simulation reads back from the anemone goes through one small interface:
disc centre, crown radius, contraction, and "is the point inside the crown". Fish
behaviour code never touches bones.

### 5. Tests

- **`tests/assets.mjs`**:
  - `host-anemone.glb` parses with `GLTFLoader.parse()` in node;
  - it has 389 joints, and every tentacle base bone carries `ring`, `angle` and `phase` in `userData`;
  - it contains no animation clips (all motion lives in code);
  - finite attributes, indices in range, skin weights summing to 1;
  - the load-time tentacle reorder: farthest-point prefixes cover all six sectors at 57% and 70%.
- **`tests/anemone.mjs`** (updated):
  - the compact specimens only;
  - the host placement: the stub's base is below `supportHeight()`, and the disc centre is
    at `HOST`.
- **New `tests/host-dynamics.mjs`**:
  - deterministic replay;
  - bounded angles over 10 minutes of flow;
  - with no flow, the pose returns to rest;
  - a clownfish capsule parked in the crown pushes the nearest tentacles out of its volume;
  - a pellet dropped over the crown is captured and consumed within N seconds;
  - after contraction the anemone is fully expanded again within 60 s.
- **Added to `npm test`**, plus a capture-mode screenshot pass to compare the look with the
  current host.

## Phases

1. **Rig touch-up and export:** add the `mouth` bone in `build_anemone.py`, vendor the r180
   `GLTFLoader`, and write `tools/export-anemone.py`. Once this is done,
   `host-anemone.glb` exists and the asset tests pass.
2. **Static swap:** `host-anemone.js`, materials, placement, the `HOST.y` change and quality levels.
   Once this is done, the scene looks right in the rest pose and the compact anemones are
   unchanged. Screenshots are compared.
3. **Current-driven motion:** `host-dynamics.js`, stepped from the simulation. Once this is
   done, the motion matches or beats today's sway, and it is deterministic.
4. **Interaction:** bathing contacts, food capture, retraction, and the non-host sting.
5. **Performance and polish:** frame-time comparison against the current anemone on
   `eco`/`balanced`, colour tuning under the lamp, and updates to `assets/README.md`.

Each phase leaves the scene working, so it can stop at any point.

## Risks

- **Loader version.** `GLTFLoader` must come from the same three.js release as
  `vendor/three.core.js` (r180). Upgrading three.js later means upgrading both together.
- **Look in the scene.** The Blender render uses Blender's own lights. Under the reef lamp,
  its tone mapping and the water's extinction, the yellow and white will shift. Budget time
  for tuning.
- **Shader injection plus skinning.** The `underwater()` wrapper hasn't been used with a
  `SkinnedMesh`. It should work, since `transformed` is already skinned by
  `worldpos_vertex`, but it needs checking early (phase 2).
- **Fewer, thicker tentacles.** The model has 96 fat tentacles where the procedural host
  has about 168 thin ones. That's the look you chose. The clownfish will look relatively
  smaller inside the crown, though, and the contact tuning has to allow for the thickness.
- **Laptop cost.** The CPU dynamics are small, but the bone texture uploads every frame
  (389 × 64 B ≈ 25 KB), where the current host uploads nothing. That's fine in practice,
  but it gets measured in phase 5.

## Later

- **Compact specimens.** `build_anemone.py` has settings for this: a compact variant
  (short tentacles, a wider disc, 36–96 tentacles) can be built from the same script. The
  four small anemones could then share one skinned asset with per-instance transforms.
  They would stay on the cheap GPU sway, with no per-bone dynamics.
- **Clownfish sleeping.** Clownfish nestle deep in the crown when the light is low.
  Worth it if the scene ever gets a day/night cycle.

## Open questions

1. Lower `HOST.y` to about 3.20 so the stub sits in the rock (recommended), or keep the
   current height with an invisible sunk skirt?
2. Scale the model to `HOST.radius = 1.25`, or widen `HOST.radius` to 1.39?
3. Keep the compact anemones procedural for now, or make them part of this job?
