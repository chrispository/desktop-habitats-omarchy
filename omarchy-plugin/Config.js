.pragma library

// Reads and edits ~/.config/desktop-habitats/config.jsonc for the panel. Edits are made
// in place on the text, so the comments people write in the file survive the panel
// changing a value next to them.

var ENVIRONMENTS = ["riverscape", "reefscape"]
var QUALITIES = ["eco", "balanced", "detail", "ultra"]
var FRAMINGS = ["auto", "landscape", "portrait"]

// Kept in step with each scene's COUNT / POPULATION and their ranges.
var FISH = {
  riverscape: [
    { kind: "tetras", label: "Bloodfin tetras", count: 24, min: 1, max: 48 }
  ],
  reefscape: [
    { kind: "clownfish", label: "Clownfish", count: 3, min: 0, max: 4 },
    { kind: "chromis", label: "Green chromis", count: 9, min: 0, max: 18 },
    { kind: "anthias", label: "Anthias", count: 7, min: 0, max: 14 }
  ]
}

var DEFAULTS = {
  enabled: true,
  environment: "riverscape",
  quality: "balanced",
  resolution: "auto",
  fps: 30,
  framing: "auto",
  pan: "auto",
  panSpeed: 5
}

// "auto" pan sweeps from end to end and back. Its speed setting runs 1 to 10, each step
// √2 faster: a round trip takes two minutes at 5 and thirty seconds at 9.
var SWEEP_LEVELS = [1, 10]

function sweepSeconds(level) {
  return 120 / Math.pow(2, (level - 5) / 2)
}

// ---------------------------------------------------------------------------------------
// Reading

// Drop comments outside strings, then trailing commas, as the host does.
function stripComments(text) {
  var out = ""
  var inString = false
  for (var i = 0; i < text.length; i++) {
    var c = text[i], next = text[i + 1]
    if (inString) {
      out += c
      if (c === "\\" && i + 1 < text.length) out += text[++i]
      else if (c === "\"") inString = false
    } else if (c === "\"") {
      inString = true
      out += c
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && next === "*") {
      i += 2
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else {
      out += c
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

// The parsed file, or null when it is missing or not an object.
function parse(text) {
  if (!text || !String(text).trim()) return {}
  try {
    var value = JSON.parse(stripComments(String(text)))
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch (e) {
    return null
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function pick(object, key, allowed, fallback) {
  var value = object ? object[key] : undefined
  if (value === undefined || value === null) return fallback
  if (allowed && allowed.indexOf(String(value).toLowerCase()) < 0) return fallback
  return allowed ? String(value).toLowerCase() : value
}

function applyLevel(base, object) {
  if (!isObject(object)) return base
  var out = Object.assign({}, base)
  if (object.enabled !== undefined) out.enabled = object.enabled !== false
  out.environment = pick(object, "environment", ENVIRONMENTS, out.environment)
  out.quality = pick(object, "quality", QUALITIES, out.quality)
  out.framing = pick(object, "framing", FRAMINGS, out.framing)
  if (object.resolution !== undefined) out.resolution = object.resolution
  var fps = Number(object.fps)
  if (object.fps !== undefined && fps >= 1 && fps <= 60) out.fps = Math.round(fps)
  if (object.pan === "auto") out.pan = "auto"
  else if (typeof object.pan === "number" && object.pan >= -1 && object.pan <= 1) out.pan = object.pan
  var speed = Number(object.panSpeed)
  if (object.panSpeed !== undefined && speed >= SWEEP_LEVELS[0] && speed <= SWEEP_LEVELS[1] && speed === Math.floor(speed))
    out.panSpeed = speed
  out.fish = {}
  for (var tank in base.fish) out.fish[tank] = Object.assign({}, base.fish[tank])
  if (isObject(object.fish)) {
    for (var name in object.fish) {
      if (!isObject(object.fish[name])) continue
      out.fish[name] = Object.assign({}, out.fish[name] || {})
      for (var kind in object.fish[name]) {
        var count = Number(object.fish[name][kind])
        if (isFinite(count) && count >= 0) out.fish[name][kind] = Math.round(count)
      }
    }
  }
  return out
}

function defaultFish() {
  var fish = {}
  for (var tank in FISH) {
    fish[tank] = {}
    for (var i = 0; i < FISH[tank].length; i++) fish[tank][FISH[tank][i].kind] = FISH[tank][i].count
  }
  return fish
}

// What one screen shows: the file's defaults, then that monitor's overrides. With no
// monitor, just the defaults.
function resolve(config, monitor) {
  var base = Object.assign({}, DEFAULTS, { fish: defaultFish() })
  var settings = applyLevel(base, config)
  if (monitor && config && isObject(config.monitors)) settings = applyLevel(settings, config.monitors[monitor])
  return settings
}

// Whether `key` is set at this level (a monitor's own override rather than inherited).
function overrides(config, monitor, key) {
  if (!monitor) return false
  var level = config && isObject(config.monitors) ? config.monitors[monitor] : null
  return isObject(level) && level[key] !== undefined
}

// Where a setting lives: the top level, or under monitors.<name>.
function settingPath(monitor, keys) {
  return monitor ? ["monitors", monitor].concat(keys) : keys
}

// ---------------------------------------------------------------------------------------
// Editing

// A small scanner over JSONC that records where each value and member sits in the text.

function skip(text, i) {
  while (i < text.length) {
    var c = text[i]
    if (c === " " || c === "\t" || c === "\n" || c === "\r") i++
    else if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++ }
    else if (c === "/" && text[i + 1] === "*") {
      var close = text.indexOf("*/", i + 2)
      i = close < 0 ? text.length : close + 2
    }
    else break
  }
  return i
}

function scanString(text, i) {
  i++
  while (i < text.length && text[i] !== "\"") i += text[i] === "\\" ? 2 : 1
  if (i >= text.length) throw new Error("unterminated string")
  return i + 1
}

// Returns { start, end, members? } for the value at i. Object members carry
// { key, start (of the key), node, comma (index of a following comma or -1) }.
function scanValue(text, i) {
  i = skip(text, i)
  var start = i, c = text[i]
  if (c === "{" || c === "[") {
    var object = c === "{", members = []
    i = skip(text, i + 1)
    while (i < text.length && text[i] !== (object ? "}" : "]")) {
      if (object) {
        if (text[i] !== "\"") throw new Error("expected a key at " + i)
        var keyEnd = scanString(text, i)
        var member = { key: JSON.parse(text.slice(i, keyEnd)), start: i, comma: -1 }
        i = skip(text, keyEnd)
        if (text[i] !== ":") throw new Error("expected ':' at " + i)
        member.node = scanValue(text, i + 1)
        members.push(member)
        i = skip(text, member.node.end)
      } else {
        i = skip(text, scanValue(text, i).end)
      }
      if (text[i] === ",") {
        if (object) members[members.length - 1].comma = i
        i = skip(text, i + 1)
      } else if (text[i] !== (object ? "}" : "]")) {
        throw new Error("expected ',' at " + i)
      }
    }
    if (i >= text.length) throw new Error("unterminated " + (object ? "object" : "array"))
    return object ? { start: start, end: i + 1, members: members } : { start: start, end: i + 1 }
  }
  if (c === "\"") return { start: start, end: scanString(text, i) }
  var match = /^[-+0-9.eE]+|^true|^false|^null/.exec(text.slice(i, i + 32))
  if (!match) throw new Error("unexpected '" + c + "' at " + i)
  return { start: start, end: i + match[0].length }
}

function member(node, key) {
  if (!node.members) return null
  for (var i = node.members.length - 1; i >= 0; i--) if (node.members[i].key === key) return node.members[i]
  return null
}

function lineStart(text, i) {
  return text.lastIndexOf("\n", i - 1) + 1
}

function indentOf(text, i) {
  var start = lineStart(text, i), end = start
  while (text[end] === " " || text[end] === "\t") end++
  return text.slice(start, end)
}

function format(value) {
  if (isObject(value)) {
    var parts = []
    for (var key in value) parts.push(JSON.stringify(key) + ": " + format(value[key]))
    return parts.length ? "{ " + parts.join(", ") + " }" : "{}"
  }
  return JSON.stringify(value)
}

// Adds "key": value to the object `node`, in the file's own layout.
function insert(text, node, key, value) {
  var entry = JSON.stringify(key) + ": " + format(value)
  var close = node.end - 1
  var inline = text.slice(node.start, node.end).indexOf("\n") < 0
  var last = node.members[node.members.length - 1]
  if (inline) {
    if (!last) return text.slice(0, node.start) + "{ " + entry + " }" + text.slice(node.end)
    var at = last.comma >= 0 ? last.comma + 1 : last.node.end
    return text.slice(0, at) + (last.comma >= 0 ? " " : ", ") + entry + text.slice(at)
  }
  var indent = last ? indentOf(text, last.start) : indentOf(text, node.start) + "  "
  if (!last) {
    // Put it first, ahead of any commented-out examples.
    return text.slice(0, node.start + 1) + "\n" + indent + entry + text.slice(node.start + 1)
  }
  var after = last.comma >= 0 ? last.comma + 1 : last.node.end
  return text.slice(0, after) + (last.comma >= 0 ? "" : ",") + "\n" + indent + entry + text.slice(after)
}

// Sets the value at `path` (keys from the root), creating objects on the way as needed.
// Returns the new text; throws if the text is not a JSONC object.
function setValue(text, path, value) {
  if (!String(text || "").trim()) text = "{}\n"
  var node = scanValue(text, 0)
  if (!node.members) throw new Error("the settings file is not an object")
  for (var i = 0; i < path.length; i++) {
    var found = member(node, path[i])
    if (!found) {
      var nested = value
      for (var j = path.length - 1; j > i; j--) {
        var wrap = {}
        wrap[path[j]] = nested
        nested = wrap
      }
      return insert(text, node, path[i], nested)
    }
    if (i === path.length - 1 || !found.node.members) {
      if (i < path.length - 1) {
        // A non-object sits where an object is wanted: replace it outright.
        var rest = value
        for (var k = path.length - 1; k > i; k--) {
          var holder = {}
          holder[path[k]] = rest
          rest = holder
        }
        value = rest
      }
      return text.slice(0, found.node.start) + format(value) + text.slice(found.node.end)
    }
    node = found.node
  }
  return text
}

// Removes the member at `path`, so the level above's value applies again.
function removeValue(text, path) {
  var node = scanValue(text, 0), parent = null, found = null
  for (var i = 0; i < path.length; i++) {
    if (!node.members) return text
    found = member(node, path[i])
    if (!found) return text
    parent = node
    node = found.node
  }
  if (!found) return text
  var index = parent.members.indexOf(found)
  var inline = text.slice(parent.start, parent.end).indexOf("\n") < 0
  if (found.comma >= 0) {
    // Take the member, its comma and the space up to whatever comes next.
    var from = inline ? found.start : lineStart(text, found.start)
    if (!inline && text.slice(from, found.start).trim()) from = found.start
    var to = found.comma + 1
    if (inline) while (text[to] === " ") to++
    else {
      var eol = text.indexOf("\n", to)
      if (eol >= 0 && !text.slice(to, eol).trim()) to = eol + 1
    }
    return text.slice(0, from) + text.slice(to)
  }
  if (index > 0) {
    // The last member: take the comma before it instead.
    var previous = parent.members[index - 1]
    return text.slice(0, previous.comma) + text.slice(found.node.end)
  }
  // The only member: take it and its line, and tidy an inline object down to {}.
  var start = found.start, end = found.node.end
  if (inline) {
    var emptied = text.slice(parent.start, start) + text.slice(end, parent.end)
    return text.slice(0, parent.start) + (emptied.slice(1, -1).trim() ? emptied : "{}") + text.slice(parent.end)
  }
  var head = lineStart(text, start)
  if (!text.slice(head, start).trim()) start = head
  var tail = text.indexOf("\n", end)
  if (tail >= 0 && !text.slice(end, tail).trim()) end = tail + 1
  return text.slice(0, start) + text.slice(end)
}
