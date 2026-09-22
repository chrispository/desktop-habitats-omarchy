# Desktop Habitats - Omarchy Port

[![Desktop Habitats aquarium demo](docs/images/demo.gif)](docs/videos/demo.mp4)

Desktop Habitats is a live aquarium wallpaper for Omarchy and other Wayland desktops using Hyprland. Choose **Riverscape**, a planted freshwater tank, or **Reefscape**, a saltwater tank. Both scenes are rendered locally with Three.js and WebGL2.

![Reefscape, a saltwater tank with clownfish around an anemone](docs/images/reefscape-wide.png)

## Configuration

The wallpaper reads `~/.config/desktop-habitats/config.jsonc`. It creates this file with defaults the first time it starts. The file uses JSONC, so comments are allowed. Changes are picked up while the wallpaper is running.

```jsonc
{
  "environment": "riverscape", // "riverscape" or "reefscape"
  "quality": "balanced",      // "eco", "balanced", "detail" or "ultra"
  "resolution": "auto",        // "auto", "native" or a scale from 0.25 to 2
  "fps": 30,                   // 1 to 60
  "framing": "auto",           // "auto", "landscape" or "portrait"
  "pan": "auto",               // "auto" sweeps end to end, or -1 (left end) to 1 (right end)
  "panSpeed": 5,               // auto's speed, 1 to 10 (5: 2 min round trip, 9: 30 s)
  "fish": {
    "riverscape": { "tetras": 24 },                              // 1-48
    "reefscape": { "clownfish": 3, "chromis": 9, "anthias": 7 }  // 0-4, 0-18, 0-14
  },
  "monitors": {
    // Per-output overrides; use `hyprctl monitors` to find output names.
    // "DP-2": { "environment": "reefscape", "framing": "portrait" },
    // "HDMI-A-1": { "enabled": false }
  }
}
```

`auto` framing chooses a composition to fit each screen's shape. `pan` moves a narrow (portrait) screen's view along the tank: `auto` sweeps it slowly from one end to the other and back, and a number holds it in place. It has no effect on a screen already wide enough to show the whole tank. Fish counts, pan, pan speed and fps apply to the running tank: new fish swim in and leavers go, with no restart. Changing the tank, quality, resolution or framing reloads it. `auto` resolution scales the render to fill the screen within the selected quality profile; `native` renders at screen resolution. You can override settings for a single run with command-line options such as `--env reefscape`. See all options with `./build/linux/desktop-habitats --help`.

## Run on Omarchy (Hyprland)

The Linux host in `linux/` uses Qt6 WebEngine and LayerShellQt. On Omarchy, install the build dependencies with:

```sh
sudo pacman -S --needed qt6-webengine layer-shell-qt cmake ninja base-devel
```

Then build from the project folder:

```sh
cmake -G Ninja -S linux -B build/linux -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build/linux
```

Start or restart the wallpaper from the project folder:

```sh
pkill -f '^\./build/linux/desktop-habitats'; setsid -f ./build/linux/desktop-habitats > build/live.log 2>&1
```

The app creates a wallpaper layer for each enabled display and loads scenes directly from this project folder. Scene edits take effect when the app restarts. Its log is written to `build/live.log`.

This is a manual, project-local install; it does not add a login autostart or system service. To stop it and remove the built app:

```sh
pkill -f '^\./build/linux/desktop-habitats'
rm -rf build/linux
```

Your settings in `~/.config/desktop-habitats/config.jsonc` are kept. To remove them too, delete `~/.config/desktop-habitats`.

### Bar widget

`omarchy-plugin/` is an Omarchy bar widget for choosing the tank, fish, framing and quality for each screen from the top bar. See [its README](omarchy-plugin/README.md) to install it.

## Try it in a browser

With Node.js installed, run this from the project folder:

```sh
npm start
```

Open [the local preview](http://127.0.0.1:8080). No package installation is needed; Three.js is included in the repository. Use `PORT=8081 npm start` if port 8080 is busy, and Ctrl+C to stop the server. The browser preview supports clicking the water to feed fish, pointer interaction, and the on-screen controls. Press **Space** to pause or resume, **F** for fullscreen, and **H** to hide or show controls while the scene has focus.

The **Quality** control offers Eco (20 fps), Balanced (30 fps), and Detail (60 fps). These are frame-rate caps; lower profiles also reduce rendering resolution. Serve the page over HTTP; opening `index.html` directly will not load its JavaScript modules.

## Credits and license

Desktop Habitats is [MIT licensed](LICENSE). Three.js 0.180.0 is bundled under its [MIT license](vendor/THREE-LICENSE.txt).

Riverscape's sand textures come from Poly Haven under [CC0](https://polyhaven.com/license): [Sand 01](https://polyhaven.com/a/sand_01). Its Bark maps are from Fab's [Grassland African Tree Bark Wood Rough 04](https://www.fab.com/listings/fe5a998a-ca25-46c1-9420-f8039065b7e3); the two 2K Cave Rock sets are from [Cave Rock](https://www.fab.com/listings/4de392b5-2e2c-4025-8667-ae8a95f2293f) and [Cave Rock](https://www.fab.com/listings/e24f6893-548a-45d0-8277-2fa16d67f25d). The scene uses each set's base color, normal, and roughness maps. Reefscape's rock mesh, pore maps, coral texture, and organism meshes are procedural, generated by the scripts in `tools/`.
