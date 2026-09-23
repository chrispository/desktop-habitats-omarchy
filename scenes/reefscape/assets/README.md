# Reefscape assets

`live-rock.bin` is the deterministic signed-density limestone surface, with indexed geometry, normals, and a per-vertex stream of baked sky visibility, coralline thickness and coralline hue. `rock-support.bin` contains the top-surface field rasterized from that mesh. Rebuild both with `tools/bake-live-rock.py`.

`live-rock-surface.png` (relief, coralline cover, algae film) and `live-rock-normal.png` (relief normal, encrusting speckle) are the seamless procedural atlas the rock shader composes its crust from, rebuilt by `tools/bake-rock-detail.py`. `aragonite.png` (grain albedo and normal) is the sand bed's grain, rebuilt by `tools/bake-sand.py`.

`host-anemone.glb` is the clownfish host, a copy of `3d_models/anemone.glb`: the model and 389-bone rig that `3d_models/build_anemone.py` builds, exported from Blender with skinning and no animation. `src/host-anemone.js` does all of its motion. Re-export and copy it here after changing the model.

These assets are part of this project's procedural artwork. The generated tank-reference images live only under documentation, never in the runtime environment.
