import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Config.js" as Config

// Bar button and popup for the Desktop Habitats wallpaper. Everything it changes goes
// into ~/.config/desktop-habitats/config.jsonc, which the wallpaper watches; the file
// stays the one source of truth, and hand edits to it show up here straight away.
//
// Colours come only from the bar and the theme (bar.foreground, Color.*) and the
// shared qs.Ui controls, so the panel follows theme switches like the built-in ones.
// Text is set in a proportional face; glyphs stay in the bar's Nerd Font.
Panel {
  id: root
  moduleName: "chrispository.desktop-habitats"
  ipcTarget: "chrispository.desktop-habitats"
  // This panel owns the target's one IpcHandler, to add the tank commands below.
  manageIpc: false

  readonly property string configPath: Quickshell.env("HOME") + "/.config/desktop-habitats/config.jsonc"
  // The plugin folder holds the wallpaper too: ../wallpaper starts, restarts and stops it.
  readonly property string wallpaperScript: decodeURIComponent(String(Qt.resolvedUrl("../wallpaper")).replace(/^file:\/\//, ""))
  readonly property string wallpaperBinary: decodeURIComponent(String(Qt.resolvedUrl("../build/linux/desktop-habitats")).replace(/^file:\/\//, ""))
  // From this widget's shell.json entry: false leaves starting the wallpaper to you.
  readonly property bool autostart: setting("autostart", true) !== false

  // nf-md-fish
  readonly property string glyph: String.fromCodePoint(0xf023a)

  // Adwaita Sans ships with Omarchy; any other system falls back to its sans alias.
  readonly property string uiFont: Qt.fontFamilies().indexOf("Adwaita Sans") >= 0 ? "Adwaita Sans" : "sans-serif"
  readonly property string iconFont: root.bar.fontFamily
  readonly property color fg: root.bar.foreground
  readonly property color subtle: Util.alpha(fg, 0.62)
  readonly property color hairline: Util.alpha(fg, 0.14)

  property string configText: ""
  property var config: ({})
  property bool configBroken: false
  // Set once the file has been read (or found missing). Until then there is no text to
  // edit, and an edit would write a file holding nothing but that one change.
  property bool configLoaded: false
  property string error: ""
  property bool running: false
  // False when the wallpaper has not been built yet (setup has not run).
  property bool built: true
  // "*" for the settings every screen shares, or an output name for one screen's own.
  property string target: "*"

  readonly property string monitor: target === "*" ? "" : target
  readonly property var effective: Config.resolve(config || {}, monitor)
  readonly property var fishKinds: Config.FISH[effective.environment] || []
  readonly property bool panAuto: effective.pan === "auto"
  // Where Fixed holds: the last fixed pan set here, so Auto and back returns to it.
  property real fixedPan: 0
  onEffectiveChanged: if (effective.pan !== "auto") fixedPan = effective.pan
  readonly property var monitorOverrides: {
    var level = monitor && config && config.monitors ? config.monitors[monitor] : null
    var keys = []
    if (level && typeof level === "object") for (var key in level) if (key !== "enabled") keys.push(key)
    return keys
  }

  readonly property var screenOptions: {
    var options = [{ value: "*", label: "All screens" }]
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++) options.push({ value: screens[i].name, label: screens[i].name })
    return options
  }

  readonly property string statusText: {
    if (configBroken) return "Settings file has an error"
    if (running) return "Running"
    return built ? "Stopped" : "Not built yet: run setup"
  }

  // ---------- Settings file ----------

  // Edits made here and not yet written, oldest first.
  property var pendingEdits: []

  function applyEdit(text, change) {
    return change.value === undefined ? Config.removeValue(text, change.path) : Config.setValue(text, change.path, change.value)
  }

  function applyPending(text) {
    for (var i = 0; i < pendingEdits.length; i++) text = applyEdit(text, pendingEdits[i])
    return text
  }

  function load(text) {
    var parsed = Config.parse(text)
    configBroken = parsed === null
    configLoaded = true
    if (configBroken) {
      configText = String(text || "")
      return
    }
    // Edits of ours still waiting to be written stay on top of what is on disk.
    try {
      configText = applyPending(String(text || ""))
    } catch (e) {
      configText = String(text || "")
    }
    config = Config.parse(configText) || parsed
  }

  // Shows an edit at once and queues it; commit() writes the queue after `delay` ms, so
  // a slider drag or a run of fish clicks becomes one write.
  function edit(path, value, delay) {
    if (configBroken || !configLoaded) return
    var change = { path: path, value: value }
    var next
    try {
      next = applyEdit(configText, change)
    } catch (e) {
      error = String(e.message || e)
      return
    }
    error = ""
    pendingEdits = pendingEdits.concat([change])
    configText = next
    config = Config.parse(next) || config
    flush.interval = Math.max(1, delay || 0)
    flush.restart()
  }

  // Writes the queued edits onto the file as it is on disk now, never onto a copy held
  // here: every bar has its own copy of this widget, and one writing out a stale copy
  // would undo whatever another had changed since.
  function commit() {
    configFile.reload()
    configFile.waitForJob()
    var text = configFile.loaded ? String(configFile.text() || "") : ""
    if (Config.parse(text) === null) {
      pendingEdits = []
      load(text)
      return
    }
    var next
    try {
      next = applyPending(text)
    } catch (e) {
      error = String(e.message || e)
      pendingEdits = []
      return
    }
    pendingEdits = []
    configFile.setText(next)
    load(next)
  }

  function set(keys, value, delay) { edit(Config.settingPath(monitor, keys), value, delay) }

  function resetMonitor() {
    for (var i = 0; i < monitorOverrides.length; i++) edit(["monitors", monitor, monitorOverrides[i]], undefined, 0)
  }

  function setFish(kind, count) {
    set(["fish", effective.environment, kind], count, 250)
  }

  function setPan(value) {
    if (value !== "auto") fixedPan = Math.round(value * 100) / 100
    set(["pan"], value === "auto" ? "auto" : fixedPan, 150)
  }

  function setPanSpeed(level) {
    set(["panSpeed"], Math.max(Config.SWEEP_LEVELS[0], Math.min(Config.SWEEP_LEVELS[1], level)), 150)
  }

  // "2 min", the round trip at a sweep speed setting.
  function sweepText(level) {
    var seconds = Math.round(Config.sweepSeconds(level))
    return seconds < 90 ? seconds + " s" : Math.round(seconds / 6) / 10 + " min"
  }

  // "start", "restart" or "stop".
  function wallpaper(action) {
    Quickshell.execDetached([wallpaperScript, action])
    running = action !== "stop"
    statusDelay.restart()
  }

  function swapTank() {
    set(["environment"], effective.environment === "reefscape" ? "riverscape" : "reefscape", 0)
  }

  function refreshStatus() {
    if (!statusProc.running) statusProc.running = true
  }

  onOpenedChanged: if (opened) {
    configFile.reload()
    refreshStatus()
  }

  // omarchy-shell ipc call chrispository.desktop-habitats <method> [args], e.g. from a
  // Hyprland keybind. These change the settings every screen shares.
  IpcHandler {
    target: "chrispository.desktop-habitats"

    function open() { root.open() }
    function close() { root.close() }
    function show() { root.open() }
    function hide() { root.close() }
    function toggle() { root.toggle() }
    function swapTank() {
      root.edit(["environment"], Config.resolve(root.config, "").environment === "reefscape" ? "riverscape" : "reefscape", 0)
    }
    function setTank(name: string) { if (Config.ENVIRONMENTS.indexOf(name) >= 0) root.edit(["environment"], name, 0) }
    function setPanSpeed(value: string) {
      var level = Number(value)
      if (level >= Config.SWEEP_LEVELS[0] && level <= Config.SWEEP_LEVELS[1]) root.edit(["panSpeed"], Math.round(level), 0)
    }
    function setPan(value: string) {
      root.edit(["pan"], value === "auto" ? "auto" : Math.max(-1, Math.min(1, Number(value) || 0)), 0)
    }
    function start() { root.wallpaper("start") }
    function restart() { root.wallpaper("restart") }
    function stop() { root.wallpaper("stop") }
  }

  FileView {
    id: configFile
    path: root.configPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.load(text())
    onLoadFailed: root.load("")
    onFileChanged: reload()
  }

  Timer {
    id: flush
    repeat: false
    onTriggered: root.commit()
  }

  // Exits 0 while the wallpaper runs, 1 when it is stopped, 2 when it is not built.
  Process {
    id: statusProc
    command: ["sh", "-c", "pidof desktop-habitats >/dev/null && exit 0; test -x \"$0\" && exit 1; exit 2", root.wallpaperBinary]
    onExited: function(exitCode) {
      root.running = exitCode === 0
      root.built = exitCode !== 2
    }
  }

  Timer { interval: 4000; running: root.opened; repeat: true; onTriggered: root.refreshStatus() }
  Timer { id: statusDelay; interval: 1500; onTriggered: root.refreshStatus() }
  Component.onCompleted: {
    // The shell loads with the session, so this is the wallpaper's login start. Each
    // screen's bar asks; the script starts it once.
    if (autostart) Quickshell.execDetached([wallpaperScript, "start"])
    statusDelay.restart()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    slotSize: Style.bar.iconSlot
    // nf-md-fish sits small in its em box; this brings its ink up to the other bar icons.
    fontSize: Style.bar.iconFont * 1.2
    tooltipText: ""
    onPressed: function(b) {
      if (b === Qt.RightButton) root.swapTank()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(18)

        // ---------- Hero: what it is, whether it runs ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroTile.height, heroLabels.implicitHeight)

          Rectangle {
            id: heroTile
            width: Style.space(40)
            height: width
            radius: Math.min(Style.cornerRadius * 1.5, width / 2)
            color: root.running ? Util.alpha(Color.accent, 0.18) : root.hairline
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            Behavior on color { ColorAnimation { duration: 200 } }

            Text {
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: root.glyph
              color: root.running ? Color.accent : root.fg
              font.family: root.iconFont
              font.pixelSize: Style.font.heading * 1.25
            }
          }

          Column {
            id: heroLabels
            anchors.left: heroTile.right
            anchors.leftMargin: Style.space(12)
            anchors.right: heroActions.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(3)

            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: "Desktop Habitats"
              color: root.fg
              font.family: root.uiFont
              font.pixelSize: Style.font.heading
              font.weight: Font.DemiBold
              elide: Text.ElideRight
            }

            Row {
              spacing: Style.space(6)
              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(6)
                height: width
                radius: width / 2
                color: root.configBroken || !root.built ? Color.urgent : (root.running ? Color.accent : Color.muted)
              }
              Text {
                textFormat: Text.PlainText
                text: root.statusText
                color: root.subtle
                font.family: root.uiFont
                font.pixelSize: Style.font.bodySmall
              }
            }
          }

          Row {
            id: heroActions
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Button {
              visible: root.running
              anchors.verticalCenter: parent.verticalCenter
              iconText: String.fromCodePoint(0xf0709) // nf-md-restart
              tooltipText: "Restart"
              fontFamily: root.iconFont
              foreground: root.fg
              onClicked: root.wallpaper("restart")
            }

            ToggleSwitch {
              anchors.verticalCenter: parent.verticalCenter
              enabled: root.built
              opacity: enabled ? 1 : 0.4
              checked: root.running
              foreground: root.fg
              onToggled: root.wallpaper(root.running ? "stop" : "start")
            }
          }
        }

        Text {
          visible: root.configBroken || root.error !== ""
          width: parent.width
          wrapMode: Text.Wrap
          textFormat: Text.PlainText
          text: root.configBroken
            ? "config.jsonc does not parse, so the panel will not touch it. Fix it by hand (Edit settings, below)."
            : root.error
          color: Color.urgent
          font.family: root.uiFont
          font.pixelSize: Style.font.bodySmall
        }

        // ---------- Screen ----------
        Section {
          title: "Screen"

          Chips {
            options: root.screenOptions
            value: root.target
            onChanged: function(value) { root.target = value }
          }

          Item {
            visible: root.monitor !== ""
            width: parent.width
            implicitHeight: Math.max(enabledLabel.implicitHeight, enabledSwitch.implicitHeight)

            Column {
              id: enabledLabel
              anchors.left: parent.left
              anchors.right: enabledSwitch.left
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)
              Label { text: "Aquarium on " + root.monitor }
              Caption {
                width: parent.width
                text: root.monitorOverrides.length
                  ? root.monitorOverrides.length + " setting" + (root.monitorOverrides.length > 1 ? "s" : "") + " differ from all screens"
                  : "Following the all-screens settings"
              }
            }

            ToggleSwitch {
              id: enabledSwitch
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              checked: root.effective.enabled
              foreground: root.fg
              onToggled: root.set(["enabled"], !root.effective.enabled, 0)
            }
          }

          Button {
            visible: root.monitor !== "" && root.monitorOverrides.length > 0
            text: "Match all screens"
            fontSize: Style.font.bodySmall
            foreground: root.fg
            fontFamily: root.uiFont
            bordered: true
            onClicked: root.resetMonitor()
          }
        }

        // Everything below describes what a screen shows; a switched-off screen shows nothing.
        Column {
          visible: root.effective.enabled
          width: parent.width
          spacing: Style.space(18)

          // ---------- Tank ----------
          Section {
            title: "Tank"

            Row {
              width: parent.width
              spacing: Style.space(8)

              TankTile {
                width: (parent.width - parent.spacing) / 2
                value: "riverscape"
                glyph: String.fromCodePoint(0xf032a) // nf-md-leaf
                title: "Riverscape"
                subtitle: "Planted freshwater"
              }
              TankTile {
                width: (parent.width - parent.spacing) / 2
                value: "reefscape"
                glyph: String.fromCodePoint(0xf078d) // nf-md-waves
                title: "Reefscape"
                subtitle: "Saltwater reef"
              }
            }
          }

          // ---------- Fish ----------
          Section {
            title: "Fish"

            Repeater {
              model: root.fishKinds

              Item {
                required property var modelData
                readonly property int count: {
                  var tank = root.effective.fish[root.effective.environment] || {}
                  var value = tank[modelData.kind]
                  return value === undefined ? modelData.count : value
                }
                width: parent.width
                implicitHeight: Math.max(fishLabel.implicitHeight, stepper.implicitHeight)

                Label {
                  id: fishLabel
                  anchors.left: parent.left
                  anchors.right: stepper.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.label
                }

                Stepper {
                  id: stepper
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  value: parent.count
                  minimum: modelData.min
                  maximum: modelData.max
                  onStepped: function(value) { root.setFish(modelData.kind, value) }
                }
              }
            }
          }

          // ---------- Framing ----------
          Section {
            title: "Framing"

            Chips {
              options: [
                { value: "auto", label: "Auto", tooltip: "Picked from the screen's shape" },
                { value: "landscape", label: "Wide" },
                { value: "portrait", label: "Tall" }
              ]
              value: root.effective.framing
              onChanged: function(value) { root.set(["framing"], value, 0) }
            }

            Item {
              width: parent.width
              implicitHeight: Math.max(panLabel.implicitHeight, panMode.implicitHeight)
              Column {
                id: panLabel
                anchors.left: parent.left
                anchors.right: panMode.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)
                Label { text: "Pan" }
                Caption {
                  width: parent.width
                  text: "For screens too narrow for the whole tank"
                }
              }
              Chips {
                id: panMode
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                options: [{ value: "auto", label: "Sweep" }, { value: "fixed", label: "Fixed" }]
                value: root.panAuto ? "auto" : "fixed"
                onChanged: function(value) { root.setPan(value === "auto" ? "auto" : root.fixedPan) }
              }
            }

            // Sweep: how fast, on a dial.
            Item {
              visible: root.panAuto
              width: parent.width
              implicitHeight: speedKnob.implicitHeight

              Knob {
                id: speedKnob
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                value: root.effective.panSpeed
                minimum: Config.SWEEP_LEVELS[0]
                maximum: Config.SWEEP_LEVELS[1]
                onMoved: function(value) { root.setPanSpeed(value) }
              }

              Column {
                anchors.left: speedKnob.right
                anchors.leftMargin: Style.space(14)
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(2)
                Label { text: "Speed " + root.effective.panSpeed }
                Caption {
                  width: parent.width
                  text: "End to end and back in " + root.sweepText(root.effective.panSpeed) + ". Drag or scroll to turn."
                }
              }
            }

            // Fixed: where it holds.
            Column {
              visible: !root.panAuto
              width: parent.width
              spacing: Style.space(4)

              PanelSlider {
                width: parent.width
                bar: root.bar
                minimum: -1
                maximum: 1
                step: 0.05
                tickCount: 3
                value: root.panAuto ? root.fixedPan : root.effective.pan
                onMoved: function(value) { root.setPan(value) }
                onReleased: function(value) { root.setPan(value) }
              }

              Item {
                width: parent.width
                implicitHeight: leftEnd.implicitHeight
                Caption { id: leftEnd; anchors.left: parent.left; text: "Left end"; wrapMode: Text.NoWrap }
                Caption { anchors.horizontalCenter: parent.horizontalCenter; text: "Middle"; wrapMode: Text.NoWrap }
                Caption { anchors.right: parent.right; text: "Right end"; wrapMode: Text.NoWrap }
              }
            }
          }

          // ---------- Quality ----------
          Section {
            title: "Quality"

            Chips {
              options: [
                { value: "eco", label: "Eco" },
                { value: "balanced", label: "Balanced" },
                { value: "detail", label: "Detail" },
                { value: "ultra", label: "Ultra", tooltip: "4K textures and the finest shadows" }
              ]
              value: root.effective.quality
              onChanged: function(value) { root.set(["quality"], value, 0) }
            }

            Item {
              width: parent.width
              implicitHeight: fpsLabel.implicitHeight
              Label { id: fpsLabel; anchors.left: parent.left; text: "Frame rate" }
              Label {
                anchors.right: parent.right
                text: root.effective.fps + " fps"
                color: root.subtle
                font.features: { "tnum": 1 }
              }
            }

            PanelSlider {
              width: parent.width
              bar: root.bar
              minimum: 1
              maximum: 60
              step: 1
              integer: true
              value: root.effective.fps
              onMoved: function(value) { root.set(["fps"], Math.round(value), 300) }
              onReleased: function(value) { root.set(["fps"], Math.round(value), 0) }
            }
          }
        }

        Rectangle { width: parent.width; height: 1; color: root.hairline }

        // ---------- Footer ----------
        Item {
          width: parent.width
          implicitHeight: editButton.implicitHeight

          Button {
            id: editButton
            anchors.left: parent.left
            anchors.leftMargin: -horizontalPadding
            text: "Edit settings file"
            fontSize: Style.font.bodySmall
            foreground: root.subtle
            fontFamily: root.uiFont
            onClicked: {
              Quickshell.execDetached(["omarchy-launch-editor", root.configPath])
              root.close()
            }
          }

          Caption {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: "Right-click the fish to swap tanks"
            wrapMode: Text.NoWrap
          }
        }
      }
    }
  }

  // ---------- Pieces ----------

  component Section: Column {
    property string title: ""
    width: parent ? parent.width : 0
    spacing: Style.space(10)

    Text {
      textFormat: Text.PlainText
      text: parent.title.toUpperCase()
      color: root.subtle
      font.family: root.uiFont
      font.pixelSize: Style.font.caption
      font.weight: Font.DemiBold
      font.letterSpacing: 1.1
    }
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: root.fg
    font.family: root.uiFont
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
  }

  component Caption: Text {
    textFormat: Text.PlainText
    color: root.subtle
    font.family: root.uiFont
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }

  // Pick one of a few, in the shell's own chip style.
  component Chips: ButtonGroup {
    foreground: root.fg
    fontFamily: root.uiFont
    fontSize: Style.font.bodySmall
    focusable: false
  }

  // One tank to choose: glyph, name and what kind of water.
  component TankTile: Rectangle {
    id: tile
    property string value: ""
    property string glyph: ""
    property string title: ""
    property string subtitle: ""
    readonly property bool selected: root.effective.environment === value

    implicitHeight: tileRow.implicitHeight + Style.space(12) * 2
    radius: Style.cornerRadius
    color: tileMouse.pressed ? Style.pressedFillFor(root.fg, Color.accent)
      : selected ? Style.selectedFillFor(root.fg, Color.accent)
      : tileMouse.containsMouse ? Style.hoverFillFor(root.fg, Color.accent)
      : "transparent"
    border.width: 1
    border.color: selected ? Util.alpha(Color.accent, 0.7) : root.hairline
    Behavior on color { ColorAnimation { duration: 120 } }

    Row {
      id: tileRow
      anchors.left: parent.left
      anchors.leftMargin: Style.space(12)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(10)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: tile.glyph
        color: tile.selected ? Color.accent : root.subtle
        font.family: root.iconFont
        font.pixelSize: Style.font.heading * 1.2
      }

      Column {
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width - x
        spacing: Style.space(1)
        Label {
          width: parent.width
          text: tile.title
          font.weight: tile.selected ? Font.DemiBold : Font.Normal
        }
        Caption { width: parent.width; text: tile.subtitle; elide: Text.ElideRight; wrapMode: Text.NoWrap }
      }
    }

    MouseArea {
      id: tileMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.set(["environment"], tile.value, 0)
    }
  }

  // − count +, in one pill.
  component Stepper: Rectangle {
    id: stepper
    property int value: 0
    property int minimum: 0
    property int maximum: 10
    signal stepped(int value)

    implicitWidth: stepRow.implicitWidth
    implicitHeight: Style.spacing.controlHeight * 0.8
    radius: Math.min(Style.cornerRadius, height / 2)
    color: "transparent"
    border.width: 1
    border.color: root.hairline

    Row {
      id: stepRow
      anchors.fill: parent

      StepButton { text: "−"; enabled: stepper.value > stepper.minimum; onClicked: stepper.stepped(stepper.value - 1) }
      Text {
        width: Style.space(30)
        height: parent.height
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        textFormat: Text.PlainText
        text: String(stepper.value)
        color: root.fg
        font.family: root.uiFont
        font.pixelSize: Style.font.body
        font.weight: Font.DemiBold
        font.features: { "tnum": 1 }
      }
      StepButton { text: "+"; enabled: stepper.value < stepper.maximum; onClicked: stepper.stepped(stepper.value + 1) }
    }
  }

  component StepButton: Rectangle {
    id: step
    property string text: ""
    signal clicked()
    width: height
    height: parent ? parent.height : 0
    radius: Math.min(Style.cornerRadius, height / 2)
    color: stepMouse.pressed ? Style.pressedFillFor(root.fg, Color.accent)
      : stepMouse.containsMouse && enabled ? Style.hoverFillFor(root.fg, Color.accent)
      : "transparent"
    opacity: enabled ? 1 : 0.35

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: step.text
      color: root.fg
      font.family: root.uiFont
      font.pixelSize: Style.font.subtitle
    }

    MouseArea {
      id: stepMouse
      anchors.fill: parent
      hoverEnabled: true
      enabled: step.enabled
      cursorShape: Qt.PointingHandCursor
      onClicked: step.clicked()
    }
  }

  // A dial for a small whole-number range: a 270° track, lit up to the value, with the
  // number in the middle. Drag up or right, or scroll, to turn it up.
  component Knob: Item {
    id: knob
    property int value: 0
    property int minimum: 0
    property int maximum: 10
    signal moved(int value)

    readonly property real progress: Math.max(0, Math.min(1, (value - minimum) / Math.max(1, maximum - minimum)))
    readonly property real stroke: Math.max(3, Math.round(width * 0.075))
    readonly property real ring: width / 2 - stroke / 2 - 1
    readonly property bool hot: knobMouse.containsMouse || knobMouse.pressed

    implicitWidth: Style.space(58)
    implicitHeight: implicitWidth

    function turn(to) {
      var next = Math.max(minimum, Math.min(maximum, Math.round(to)))
      if (next !== value) moved(next)
    }

    Rectangle {
      anchors.centerIn: parent
      width: knob.ring * 2 - knob.stroke * 2.2
      height: width
      radius: width / 2
      color: knob.hot ? Style.hoverFillFor(root.fg, Color.accent) : Util.alpha(root.fg, 0.05)
      Behavior on color { ColorAnimation { duration: 120 } }
    }

    Shape {
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        strokeColor: Util.alpha(root.fg, 0.2)
        strokeWidth: knob.stroke
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: knob.width / 2; centerY: knob.height / 2
          radiusX: knob.ring; radiusY: knob.ring
          startAngle: 135; sweepAngle: 270
        }
      }

      ShapePath {
        strokeColor: Color.accent
        strokeWidth: knob.stroke
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        PathAngleArc {
          centerX: knob.width / 2; centerY: knob.height / 2
          radiusX: knob.ring; radiusY: knob.ring
          startAngle: 135; sweepAngle: Math.max(0.5, 270 * knob.progress)
        }
      }
    }

    // The thumb, where the lit arc ends.
    Rectangle {
      readonly property real angle: (135 + 270 * knob.progress) * Math.PI / 180
      width: knob.stroke * 1.9
      height: width
      radius: width / 2
      x: knob.width / 2 + knob.ring * Math.cos(angle) - width / 2
      y: knob.height / 2 + knob.ring * Math.sin(angle) - height / 2
      color: root.fg
      border.width: Math.max(1, knob.stroke * 0.35)
      border.color: Color.accent
    }

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: String(knob.value)
      color: root.fg
      font.family: root.uiFont
      font.pixelSize: Style.font.heading
      font.weight: Font.DemiBold
      font.features: { "tnum": 1 }
    }

    MouseArea {
      id: knobMouse
      anchors.fill: parent
      hoverEnabled: true
      preventStealing: true
      cursorShape: pressed ? Qt.ClosedHandCursor : Qt.OpenHandCursor
      property real startX: 0
      property real startY: 0
      property int startValue: 0
      onPressed: function(mouse) {
        startX = mouse.x
        startY = mouse.y
        startValue = knob.value
      }
      // One step per ~10 px of travel, up or to the right.
      onPositionChanged: function(mouse) {
        if (!pressed) return
        knob.turn(startValue + ((mouse.x - startX) - (mouse.y - startY)) / Style.space(10))
      }
      onWheel: function(wheel) {
        var delta = wheel.angleDelta.y !== 0 ? wheel.angleDelta.y : wheel.angleDelta.x
        if (delta !== 0) knob.turn(knob.value + (delta > 0 ? 1 : -1))
      }
    }
  }
}
