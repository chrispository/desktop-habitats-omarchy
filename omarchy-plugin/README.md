# Desktop Habitats for the Omarchy bar

A bar widget for the [Desktop Habitats](../README.md) live aquarium wallpaper. Click the
fish in the bar to pick the tank, the fish, the framing and the quality, for every screen
at once or one screen at a time. Right-click it to swap between Riverscape and Reefscape.

The panel edits `~/.config/desktop-habitats/config.jsonc`, the same file you can edit by
hand. It changes only the values you touch, so your comments in the file stay. The
wallpaper applies changes as soon as the file is saved. Fish swim in or leave without
the tank restarting.

The panel takes its colours from the current Omarchy theme and changes with it.

## What it controls

- **Screen**: *All screens* edits the shared settings. Pick an output (such as `DP-2`) to
  switch the aquarium off on that screen or give it its own settings. **Match all
  screens** removes that screen's own settings.
- **Tank**: Riverscape (freshwater) or Reefscape (saltwater).
- **Fish**: how many of each kind are in the tank shown on that screen.
- **Framing**: *Auto* picks a layout from the screen's shape; *Wide* and *Tall* force
  one. **Pan** moves a narrow (portrait) screen's view along the tank. *Auto* sweeps it
  from one end to the other and back, at a **Speed** from 1 to 10 (5 is a two-minute
  round trip, 9 thirty seconds); *Fixed* holds it where you put the slider.
- **Quality** and **Frame rate**.
- **Edit settings** opens the file in your editor.

## Install

The wallpaper itself has to be built and running first; see the main README.

Copy this folder into Omarchy's plugin folder and enable it. Omarchy does not accept a
plugin folder that contains symlinks, so use a copy, not a link:

```sh
dest=~/.config/omarchy/plugins/chrispository.desktop-habitats
mkdir -p "$dest" && cp omarchy-plugin/{manifest.json,Panel.qml,Config.js,LICENSE} "$dest"/
omarchy-shell shell rescanPlugins
omarchy plugin enable chrispository.desktop-habitats --section right
```

Copy the files again after changing them. The bar reloads the widget by itself, but if
you have changed its IPC commands, restart the shell with `omarchy-restart-shell`.

### Start and Restart button

To get a **Start** / **Restart** button in the panel, add the command that launches the
wallpaper to the widget's entry in `~/.config/omarchy/shell.json`:

```json
{
  "id": "chrispository.desktop-habitats",
  "command": "cd ~/path/to/desktop-habitats-omarchy && exec ./build/linux/desktop-habitats > build/live.log 2>&1"
}
```

## Commands

The widget accepts IPC calls, for use in Hyprland keybindings. These change the settings
shared by all screens:

```sh
omarchy-shell chrispository.desktop-habitats toggle          # open or close the panel
omarchy-shell chrispository.desktop-habitats swapTank
omarchy-shell chrispository.desktop-habitats setTank reefscape
omarchy-shell chrispository.desktop-habitats setPan -0.5     # -1 to 1, or auto
omarchy-shell chrispository.desktop-habitats setPanSpeed 9   # 1 to 10
```

For example, in `~/.config/hypr/bindings.conf`:

```
bind = SUPER ALT, A, exec, omarchy-shell chrispository.desktop-habitats swapTank
```

## Tests

```sh
node omarchy-plugin/tests/config.mjs
```
