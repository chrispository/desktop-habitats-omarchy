import QtQuick
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
Panel {
  id: root
  moduleName: "chrispository.desktop-habitats"
  ipcTarget: "chrispository.desktop-habitats"
  // This panel owns the target's one IpcHandler, to add the tank commands below.
  manageIpc: false

  readonly property string configPath: Quickshell.env("HOME") + "/.config/desktop-habitats/config.jsonc"
  // Optional, from this widget's shell.json entry: how to start the wallpaper, for the
  // Start / Restart button. Without it the panel only edits settings.
  readonly property string command: String(setting("command", ""))

  // nf-md-fish
  readonly property string glyph: String.fromCodePoint(0xf023a)

  property string configText: ""
  property var config: ({})
  property bool configBroken: false
  // Set once the file has been read (or found missing). Until then there is no text to
  // edit, and an edit would write a file holding nothing but that one change.
  property bool configLoaded: false
  property string error: ""
  property bool running: false
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
    return running ? "Running" : "Not running"
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

  // "a 2 min round trip", from a sweep speed setting.
  function sweepText(level) {
    var seconds = Math.round(Config.sweepSeconds(level))
    return "a " + (seconds < 90 ? seconds + " s" : Math.round(seconds / 6) / 10 + " min") + " round trip"
  }

  function startWallpaper() {
    if (!command) return
    // pidof matches the program itself; a pattern match on command lines would also
    // catch this very shell, whose arguments contain the command.
    Quickshell.execDetached(["sh", "-c",
      "pids=$(pidof desktop-habitats) && kill $pids; sleep 0.5; setsid -f sh -c \"$0\" >/dev/null 2>&1", command])
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

  Process {
    id: statusProc
    command: ["pidof", "desktop-habitats"]
    onExited: function(exitCode) { root.running = exitCode === 0 }
  }

  Timer { interval: 4000; running: root.opened; repeat: true; onTriggered: root.refreshStatus() }
  Timer { id: statusDelay; interval: 1500; onTriggered: root.refreshStatus() }
  Component.onCompleted: refreshStatus()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph
    slotSize: Style.bar.iconSlot
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
    contentWidth: panel.fittedContentWidth(Style.space(400))
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
        spacing: Style.space(14)

        // ---------- Hero ----------
        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            text: root.glyph
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: startButton.visible ? startButton.left : parent.right
            anchors.rightMargin: Style.space(10)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Desktop Habitats"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Row {
              spacing: Style.space(6)
              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(7)
                height: width
                radius: width / 2
                color: root.configBroken ? Color.urgent : (root.running ? Color.accent : Color.muted)
              }
              Text {
                textFormat: Text.PlainText
                text: root.statusText.toUpperCase()
                color: Qt.darker(root.bar.foreground, 1.4)
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }
            }
          }

          Button {
            id: startButton
            visible: root.command !== ""
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.running ? "Restart" : "Start"
            fontSize: Style.font.bodySmall
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.startWallpaper()
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
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        // ---------- Screen ----------
        Section {
          title: "SCREEN"

          ButtonGroup {
            width: parent.width
            options: root.screenOptions
            value: root.target
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            fontSize: Style.font.bodySmall
            focusable: false
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
              foreground: root.bar.foreground
              onToggled: root.set(["enabled"], !root.effective.enabled, 0)
            }
          }

          Button {
            visible: root.monitor !== "" && root.monitorOverrides.length > 0
            text: "Match all screens"
            fontSize: Style.font.bodySmall
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
            bordered: true
            onClicked: root.resetMonitor()
          }
        }

        // Everything below describes what a screen shows; a switched-off screen shows nothing.
        Column {
          visible: root.effective.enabled
          width: parent.width
          spacing: Style.space(14)

          PanelSeparator { foreground: root.bar.foreground }

          // ---------- Tank ----------
          Section {
            title: "TANK"

            ButtonGroup {
              width: parent.width
              options: [{ value: "riverscape", label: "Riverscape" }, { value: "reefscape", label: "Reefscape" }]
              value: root.effective.environment
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.bodySmall
              focusable: false
              onChanged: function(value) { root.set(["environment"], value, 0) }
            }
          }

          // ---------- Fish ----------
          Section {
            title: "FISH"

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
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.label
                }

                Row {
                  id: stepper
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(6)

                  Button {
                    text: "−"
                    fontSize: Style.font.body
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    bordered: true
                    enabled: parent.parent.count > modelData.min
                    opacity: enabled ? 1 : 0.4
                    onClicked: root.setFish(modelData.kind, parent.parent.count - 1)
                  }
                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(34)
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    text: String(parent.parent.count)
                    color: root.bar.foreground
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Button {
                    text: "+"
                    fontSize: Style.font.body
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    bordered: true
                    enabled: parent.parent.count < modelData.max
                    opacity: enabled ? 1 : 0.4
                    onClicked: root.setFish(modelData.kind, parent.parent.count + 1)
                  }
                }
              }
            }
          }

          PanelSeparator { foreground: root.bar.foreground }

          // ---------- Framing ----------
          Section {
            title: "FRAMING"

            ButtonGroup {
              width: parent.width
              options: [
                { value: "auto", label: "Auto", tooltip: "Picked from the screen's shape" },
                { value: "landscape", label: "Wide" },
                { value: "portrait", label: "Tall" }
              ]
              value: root.effective.framing
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.bodySmall
              focusable: false
              onChanged: function(value) { root.set(["framing"], value, 0) }
            }

            Item {
              width: parent.width
              implicitHeight: Math.max(panLabel.implicitHeight, panControls.implicitHeight)
              Label {
                id: panLabel
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                text: "Pan"
              }
              Row {
                id: panControls
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(10)

                // Auto's speed, 1-10, beside the Auto button.
                Row {
                  visible: root.panAuto
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(4)
                  Caption {
                    anchors.verticalCenter: parent.verticalCenter
                    rightPadding: Style.space(2)
                    text: "Speed"
                  }
                  Button {
                    text: "−"
                    fontSize: Style.font.bodySmall
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    bordered: true
                    enabled: root.effective.panSpeed > Config.SWEEP_LEVELS[0]
                    opacity: enabled ? 1 : 0.4
                    onClicked: root.setPanSpeed(root.effective.panSpeed - 1)
                  }
                  Text {
                    anchors.verticalCenter: parent.verticalCenter
                    width: Style.space(22)
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    text: String(root.effective.panSpeed)
                    color: root.bar.foreground
                    font.family: root.bar.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                  Button {
                    text: "+"
                    fontSize: Style.font.bodySmall
                    foreground: root.bar.foreground
                    fontFamily: root.bar.fontFamily
                    bordered: true
                    enabled: root.effective.panSpeed < Config.SWEEP_LEVELS[1]
                    opacity: enabled ? 1 : 0.4
                    onClicked: root.setPanSpeed(root.effective.panSpeed + 1)
                  }
                }

                ButtonGroup {
                  id: panMode
                  anchors.verticalCenter: parent.verticalCenter
                  options: [{ value: "auto", label: "Auto" }, { value: "fixed", label: "Fixed" }]
                  value: root.panAuto ? "auto" : "fixed"
                  foreground: root.bar.foreground
                  fontFamily: root.bar.fontFamily
                  fontSize: Style.font.bodySmall
                  focusable: false
                  onChanged: function(value) { root.setPan(value === "auto" ? "auto" : root.fixedPan) }
                }
              }
            }

            Caption {
              width: parent.width
              text: root.panAuto
                ? "Sweeps from end to end and back, " + root.sweepText(root.effective.panSpeed) + "."
                : "Holds the view at one place."
            }

            // Fixed: where it holds.
            PanelSlider {
              visible: !root.panAuto
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
              visible: !root.panAuto
              width: parent.width
              implicitHeight: leftEnd.implicitHeight
              Caption { id: leftEnd; anchors.left: parent.left; text: "Left end" }
              Caption { anchors.horizontalCenter: parent.horizontalCenter; text: "Middle" }
              Caption { anchors.right: parent.right; text: "Right end" }
            }

            Caption {
              width: parent.width
              text: "Pan moves only a screen too narrow to show the whole tank."
            }
          }

          PanelSeparator { foreground: root.bar.foreground }

          // ---------- Quality ----------
          Section {
            title: "QUALITY"

            ButtonGroup {
              width: parent.width
              options: [
                { value: "eco", label: "Eco" },
                { value: "balanced", label: "Balanced" },
                { value: "detail", label: "Detail" },
                { value: "ultra", label: "Ultra" }
              ]
              value: root.effective.quality
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
              fontSize: Style.font.bodySmall
              focusable: false
              onChanged: function(value) { root.set(["quality"], value, 0) }
            }

            Item {
              width: parent.width
              implicitHeight: fpsLabel.implicitHeight
              Label { id: fpsLabel; anchors.left: parent.left; text: "Frame rate" }
              Label { anchors.right: parent.right; text: root.effective.fps + " fps" }
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

        PanelSeparator { foreground: root.bar.foreground }

        Button {
          text: "Edit settings"
          iconText: String.fromCodePoint(0xf03eb) // nf-md-pencil
          fontSize: Style.font.bodySmall
          foreground: root.bar.foreground
          fontFamily: root.bar.fontFamily
          bordered: true
          onClicked: {
            Quickshell.execDetached(["omarchy-launch-editor", root.configPath])
            root.close()
          }
        }
      }
    }
  }

  component Section: Column {
    property string title: ""
    width: parent ? parent.width : 0
    spacing: Style.space(10)

    PanelSectionHeader {
      text: parent.title
      foreground: root.bar.foreground
      fontFamily: root.bar.fontFamily
    }
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: root.bar.foreground
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }

  component Caption: Text {
    textFormat: Text.PlainText
    color: root.bar.foreground
    opacity: 0.6
    font.family: root.bar.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }
}
