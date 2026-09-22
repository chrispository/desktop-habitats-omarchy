# Plan: Desktop Habitats as a live wallpaper on Omarchy

Status: proposal. Nothing here is built yet.

## Goal

Run Riverscape and Reefscape as the live desktop background on Omarchy (Arch + Hyprland),
the same way `wallpaper/Wallpaper.swift` does on macOS. The scene code in `scenes/` stays
as it is. Only a new Linux host gets added, plus some Omarchy glue.

## How Omarchy draws the background today

Findings from the installed system (Omarchy shell on Quickshell 0.3.1, Hyprland 0.56):

- **No separate wallpaper daemon.** No swaybg, hyprpaper or swww. The background is drawn
  by a first-party shell plugin, `omarchy.background`
  (`/usr/share/omarchy/shell/plugins/background/Background.qml`), which runs inside the
  long-lived `omarchy-shell` Quickshell process.
- The plugin creates one `PanelWindow` per screen: a wlr-layer-shell surface with namespace
  `omarchy-background`, on layer `Background`, with no keyboard focus and exclusion
  ignored. Each window draws a static `Image` with `PreserveAspectCrop` and a slanted
  reveal transition when the image changes.
- **The source of truth is a symlink:** `~/.local/state/omarchy/current/background`.
  `omarchy theme bg set <img>` updates the symlink, then calls
  `omarchy-shell -q background set <img>` (IPC target `background`). `bg next` and the
  bg-switcher go through the same path. Only image extensions are recognised
  (jpg/png/gif/bmp/webp).
- Double-clicking the desktop opens the background switcher (left button) or the theme
  switcher (right button). That's the plugin's `MouseArea`.
- Other consumers read the same image. The lock screen (`omarchy.lock`) shows a blurred
  copy of the wallpaper.
- Windows get `opacity 0.985 / 0.96` from `default/hypr/windows.lua`, so whatever sits
  under them shows through faintly.

Layer order in Hyprland, bottom to top: `background` < `bottom` < windows < `top` (bar)
< `overlay`.

## Can the scene run inside omarchy-shell? No.

The obvious approach would be to clone `omarchy.background` and replace the `Image` with
a `WebEngineView`. `qt6-webengine` and its QML module are installed, so I tested it
(a minimal `quickshell -p` config containing a `WebEngineView`):

```
FATAL: Argument list is empty, the program name is not passed to QCoreApplication.
base::CommandLine cannot be properly initialized.
```

Quickshell starts Qt without argv, and QtWebEngine also needs initialising before the
QGuiApplication exists. Both are outside what a plugin controls. Even if it worked,
running Chromium inside `omarchy-shell` would let a GPU or renderer crash take down the
bar, notifications, lock screen and polkit agent. The scene has to run in **its own
process**.

## Options for a separate host

| Option | Verdict |
| --- | --- |
| **A. Small C++ Qt6 app: QtWebEngine + layer-shell-qt** | **Recommended.** Both libraries are already installed (`qt6-webengine 6.11`, `layer-shell-qt 6.7`, and cmake/ninja are present). Chromium's GPU path runs WebGL2 well on the RTX 4090 / NVIDIA 610 driver. Its structure maps one-to-one onto `Wallpaper.swift` (per-screen window + web view + custom URL scheme + `runJavaScript`). |
| B. GTK4 + gtk4-layer-shell + WebKitGTK 6.0 (Python/GJS) | Viable fallback. Scripting is lighter, but it needs `webkitgtk-6.0`. WebKitGTK's DMA-BUF renderer has a history of problems on NVIDIA, and `WEBKIT_DISABLE_DMABUF_RENDERER=1` turns it into a slow copy path. It is closest to the macOS WebKit engine, though. |
| C. Chromium `--app` window pinned by Hyprland window rules | Rejected. A client window always sits above the background layers, takes part in tiling and focus, appears in the alt-tab list, and on workspace switches it has to be pinned or duplicated. |
| D. Patch Quickshell to pass argv / init WebEngine | Rejected. Needs an upstream change, and it still has the crash-coupling problem above. |
| E. Pre-rendered video with mpvpaper | Rejected. Loses the interactivity (cursor, feeding) that makes the project what it is. |

## Recommended design

### 1. `linux/` host: `desktop-habitats` (C++ / Qt6, ~500 lines)

A new top-level `linux/` directory next to `wallpaper/` (which remains the macOS app):

```
linux/
  CMakeLists.txt
  src/main.cpp          # app setup, QtWebEngine init, per-screen lifecycle
  src/SceneScheme.cpp   # habitat:// URL scheme -> files under the scene root
  src/Surface.cpp       # one layer-shell window + QQuickWebEngineView / QWebEngineView per QScreen
  src/Hyprland.cpp      # IPC: socket2 events + request socket (coverage, cursor)
  src/Control.cpp       # QLocalServer on $XDG_RUNTIME_DIR/desktop-habitats.sock
  desktop-habitats.service
  install.sh / uninstall.sh
```

**Surfaces.** Create one window per `QScreen`, turned into a layer surface through
`LayerShellQt::Window`:
- `layer = LayerBottom`. This puts the scene *above* Omarchy's static `Background`
  layer and below windows. Leaving `omarchy.background` running is the key choice: it
  stays the fallback if the host crashes or is stopped, and it keeps feeding the lock
  screen and switcher. Disabling it is not needed.
- Anchors on all four edges, `exclusiveZone = -1`, `keyboardInteractivity = None`,
  namespace `desktop-habitats`.
- Follow `QGuiApplication::screenAdded/Removed` so hot-plugging monitors works. Both
  monitors here are 3440×1440@180 and 2560×1440@60.

**Loading the scene.** Register a custom scheme `habitat://` with
`QWebEngineUrlScheme` (flags `SecureScheme | LocalScheme | CorsEnabled`,
before the app object exists). Serve files through a `QWebEngineUrlSchemeHandler`
rooted at the installed scene copy. This mirrors `SceneHandler` in Swift and avoids
`file://`, where Chromium blocks ES-module imports. Load
`habitat://scene/scenes/<env>/wallpaper.html`. That page already sets
`data-motion="host"`, so it waits for host commands.

**Profile.** Use an off-the-record `QWebEngineProfile` (same idea as
`.nonPersistent()` on macOS). Forward console `error`/`warn` and uncaught errors to
stderr/journal via `javaScriptConsoleMessage`.

**Host bridge (unchanged JS API).** Call the same functions the Swift app calls,
through `page()->runJavaScript(...)`:
- `habitatRate(fps)` and `habitatPower(onBattery)`. Send them on load and on change
  only. `start.js` already queues them until the scene module resolves.
- `habitatFeed()`, `habitatPause(bool)`.
- `habitatPointer(x, y)` / `habitatPointerOut()`. Inject them as a user script at
  `DocumentCreation`, copying the Swift `WKUserScript` verbatim.

**Chromium flags.** Set `QTWEBENGINE_CHROMIUM_FLAGS` to
`--ignore-gpu-blocklist --enable-gpu-rasterization`, and only if needed
`--use-gl=angle --use-angle=vulkan` / `egl`. Phase 0 checks that the renderer string is
the NVIDIA GPU and not SwiftShader. `hidden`/occlusion throttling in Chromium has to be
off, or the page may be treated as background (`--disable-background-timer-throttling`,
`--disable-renderer-backgrounding`). The host drives the frame rate itself.

### 2. Render policy (the Hyprland equivalent of the macOS coverage logic)

On macOS the app works out how much of the desktop windows cover and maps that to
30 / 20 / 0 fps. On Hyprland, read the same information over IPC:

- Subscribe to `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock`
  events: `workspace`, `focusedmon`, `openwindow`, `closewindow`, `movewindow`,
  `changefloatingmode`, `fullscreen`, `activespecial`, `monitoradded/removed`.
  Debounce for about 150 ms, then query `j/clients` and `j/monitors` on `.socket.sock`.
- For each monitor, compute the fraction of the monitor rect *not* covered by mapped
  windows on its active workspace (plus any open special workspace). Use a union of
  rectangles, not a sum.
- Map that to the frame rate with the existing table: clearly visible → up to 30 fps
  (the Balanced profile), mostly covered → 20, almost entirely covered or fullscreen →
  0. A tiling WM usually covers the whole desktop, so in practice the tank will often
  stop. That is intended: the last frame stays on screen, faintly visible through the
  0.96 window opacity.
- **Stop at 0** for DPMS off (`dpmsStatus` in `j/monitors`, re-polled on the
  `dpms` hyprland event if present, or every few seconds), and while the session is
  locked. Detect locking through logind `LockedHint` on D-Bus, or by the
  `omarchy.lock` surface appearing. Whichever turns out reliable in phase 0.
- On battery, pass `habitatPower(true)` from `/sys/class/power_supply/*/online`
  (UPower D-Bus if available). This machine is a desktop, so it's low priority but
  cheap.
- If `~/.config/desktop-habitats/state.json` says *paused*, start paused, like the
  Swift app does with Reduce Motion or a saved choice.

### 3. Pointer and feeding

A `Bottom` layer surface only receives pointer events where no window covers it. That is
the same area the fish are visible in, so:

- **Default:** accept pointer input on the layer. Real `pointermove`/`pointerleave` then
  reach the canvas directly, and no polling is needed. Clicking the water drops food, as
  in the browser build. Double-click passes through to the same actions as Omarchy's
  plugin (`omarchy-theme-bg-switcher` on left, theme switcher on right). This keeps
  existing muscle memory. Add a small JS shim, or have the host detect double-clicks.
- **Optional "global cursor" mode:** set an empty input region, which makes the surface
  click-through. Then poll `j/cursorpos` at the current render rate, only while fps > 0,
  and send `habitatPointer` in monitor-local coordinates. This matches the macOS
  behaviour, where fish react even with the cursor over a translucent window.

### 4. Control surface and Omarchy integration

- **CLI / IPC:** the host listens on `$XDG_RUNTIME_DIR/desktop-habitats.sock`, and a
  thin `desktop-habitats` CLI sends `feed`, `pause`, `resume`, `toggle`,
  `env riverscape|reefscape`, `quality eco|balanced|detail`, `status` and `snapshot`.
  State persists in `~/.config/desktop-habitats/state.json`.
- **Omarchy menu:** add a "Habitat" submenu (Environment, Feed, Pause/Resume, Quit)
  through the user extension file `~/.config/omarchy/extensions/omarchy-menu.jsonc`.
  That's the supported, hot-reloaded extension point, and it replaces the macOS
  menu-bar item. Optionally, a small bar widget plugin under
  `~/.config/omarchy/plugins/` with a fish icon that opens the same actions.
- **Keybindings (optional):** e.g. `SUPER+ALT+F` feed, `SUPER+ALT+P` pause, in
  `~/.config/hypr/bindings.lua`.
- **Still image for lock screen and fallback:** on the first frame and on environment
  change, grab a frame (`QQuickWindow::grabWindow` / `QWidget::grab`, or `snapshot` over
  IPC) to `~/Pictures/Desktop Habitats-<env>.png`. Then call `omarchy theme bg set` on
  it. Omarchy's static layer underneath and the blurred lock screen then match the tank,
  just as the macOS installer sets a desktop picture. **This overrides the theme's
  background**, so make it opt-in in the installer and restore the previous symlink
  target on uninstall.
- **Theme changes:** `omarchy theme set` swaps the static background under us, which is
  harmless. An optional `theme-set` hook (`omarchy hook install theme-set`) could
  re-apply the habitat still image.
- **Autostart:** a systemd user unit, `desktop-habitats.service`, with
  `PartOf=graphical-session.target` / `WantedBy=graphical-session.target`,
  `Restart=on-failure`, and the Hyprland env imported (Omarchy already has an active
  `graphical-session.target`). It's more robust than `exec-once` in `autostart.lua` and
  gives `journalctl --user -u desktop-habitats` for logs.

### 5. Install / uninstall

`linux/install.sh`:
1. Check deps: `qt6-webengine layer-shell-qt cmake ninja`. Install missing ones with
   `omarchy pkg add`.
2. Build with `cmake -G Ninja` into `build/linux`.
3. Install the binary to `~/.local/bin/desktop-habitats` and copy the scene
   (`scenes/`, `ui/`, `vendor/`) to `~/.local/share/desktop-habitats/scene/`. This is the
   same "installed copy" rule as the Mac app: editing the repo doesn't change the live
   wallpaper.
4. Install and start the user unit. Add the menu extension (merge rather than overwrite
   if the file exists). Optionally set the still image.

`linux/uninstall.sh` reverses each step and restores the previous background symlink.
Add `npm run wallpaper:linux` / `unwallpaper:linux`, and pick the platform in the
existing npm scripts.

## Phases

**Phase 0: feasibility spike (half a day). Do this before anything else.**
- A throwaway `main.cpp` with one layer-shell window on DP-1 and a `QWebEngineView`
  loading `habitat://…/riverscape/wallpaper.html` at a fixed `habitatRate(30)`.
- Confirm: WebGL2 context on the NVIDIA renderer (log `RENDERER` the way `probe()` in
  Swift does); the surface sits above the Omarchy image and below windows; no black
  frames on workspace switch; CPU/GPU cost at 3440×1440; that frame pacing isn't
  starved when Chromium thinks the view is hidden.
- If WebGL2 falls back to software or layer-shell-qt misbehaves with WebEngine's
  surface, try option B (WebKitGTK) before going further.

**Phase 1: working wallpaper.** Per-screen surfaces, scheme handler, JS bridge,
environment choice, persisted state, a basic fixed 30 fps, systemd unit, installer.

**Phase 2: power-aware.** Hyprland coverage → fps, DPMS/lock → 0, battery flag,
pause-state persistence, screen hot-plug.

**Phase 3: Omarchy integration.** Menu extension, control CLI, keybindings, still-image
sync for lock screen and fallback, optional bar widget, double-click passthrough,
optional global-cursor mode.

**Phase 4: docs and tests.** README "Install on Omarchy / Hyprland" section and FAQ
updates ("Does it work on Linux?"). Unit-test the coverage math (pure function:
monitor rect + window rects → visible fraction) alongside the existing `tests/*.mjs`
style, or as a small C++ test.

## Open questions

1. Should the host be a first-class Omarchy "theme background" (e.g. a
   `backgrounds/*.habitat` marker the switcher could pick), or stay a separate
   toggle? The switcher only lists image files, so a first-class entry needs Omarchy
   changes. I suggest a separate toggle for now.
2. Should pointer mode default to native (desktop gaps only) or global-cursor polling?
3. Should the installer replace the Omarchy background with the habitat still by
   default, or only opt-in? I suggest opt-in.
4. Is a generic wlroots build (Sway, river, niri) a goal? Everything except the Hyprland
   coverage module is compositor-agnostic. Make that module optional (constant 30 fps
   when `HYPRLAND_INSTANCE_SIGNATURE` is unset).
