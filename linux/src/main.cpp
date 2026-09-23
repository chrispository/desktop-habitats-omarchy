// Desktop Habitats for Wayland compositors with wlr-layer-shell (Hyprland / Omarchy).
//
// One layer-shell surface per screen on the `bottom` layer, which sits above Omarchy's
// own static background (layer `background`) and below windows. Each surface holds a
// Chromium web view showing a scene's wallpaper.html, driven through its habitat*
// functions. Settings come from a commented JSON file that is watched for changes, so an
// edit shows up on the desktop as soon as it is saved.

#include <LayerShellQt/window.h>

#include <QApplication>
#include <QBuffer>
#include <QCommandLineParser>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMimeDatabase>
#include <QRegularExpression>
#include <QSaveFile>
#include <QScreen>
#include <QStandardPaths>
#include <QTimer>
#include <QUrlQuery>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlScheme>
#include <QWebEngineUrlSchemeHandler>
#include <QWebEngineView>

#include <cmath>
#include <cstdio>
#include <functional>
#include <map>

static const QByteArray sceneScheme = "habitat";
static const QString sceneHost = "scene";

template <typename... Values>
static void say(const char *format, Values... values) {
  std::fprintf(stderr, "desktop-habitats: ");
  if constexpr (sizeof...(values) == 0) std::fputs(format, stderr);
  else std::fprintf(stderr, format, values...);
  std::fputc('\n', stderr);
}

// ---------------------------------------------------------------------------------------
// Settings

static const char *defaultConfig = R"JSONC(// Desktop Habitats: live aquarium wallpaper.
// Changes apply as soon as this file is saved.
{
  // Which tank to show: "riverscape" (planted freshwater) or "reefscape" (saltwater).
  "environment": "riverscape",

  // Rendering detail: "eco", "balanced", "detail" or "ultra".
  // Ultra has no pixel budget and the most shadow and plant detail; it wants a
  // strong GPU.
  "quality": "balanced",

  // Render resolution.
  //   "auto"   - whatever the quality allows, scaled up to fill the screen
  //   "native" - one rendered pixel per screen pixel, nothing stretched
  //   a number - a scale of native: 0.5 is half, 1.5 supersamples for extra smoothness
  "resolution": "auto",

  // Frames per second, 1 to 60. Lower saves power; the fish move at the same speed.
  "fps": 30,

  // How the tank is composed:
  //   "auto"      - picked from the screen's shape
  //   "landscape" - the wide composition, even on a portrait screen
  //   "portrait"  - the tall composition, even on a landscape screen
  "framing": "auto",

  // Where a narrow (portrait) screen looks along the tank: "auto" sweeps slowly from one
  // end to the other and back, or a number holds it from -1 (left end) through 0
  // (middle) to 1 (right end).
  "pan": "auto",
  // How fast "auto" sweeps, 1 to 10: each step is a little faster. At 5 a round trip
  // takes two minutes, at 9 thirty seconds.
  "panSpeed": 5,

  // How many of each fish, per tank. Fish join or leave the running tank.
  "fish": {
    "riverscape": { "tetras": 24 },                              // 1-48
    "reefscape": { "clownfish": 3, "chromis": 9, "anthias": 7 }  // 0-4, 0-18, 0-14
  },

  // Per-monitor overrides, by output name (run `hyprctl monitors` to see names).
  // Any setting above can go here; "enabled": false leaves a monitor alone.
  "monitors": {
    // "DP-2": { "environment": "reefscape", "framing": "portrait" },
    // "HDMI-A-1": { "enabled": false }
  }
}
)JSONC";

/// What one screen shows.
struct ScreenSettings {
  bool enabled = true;
  QString environment = "riverscape";
  QString quality = "balanced";
  QString resolution = "auto";
  int fps = 30;
  QString framing = "auto";
  QString pan = "auto";
  int panSpeed = 5;
  /// Fish counts by tank, then by kind. The page clamps them to what each tank allows.
  std::map<QString, std::map<QString, int>> fish;

  /// The counts for this screen's tank, as the page reads them: "kind:count,...".
  QString fishQuery() const {
    QStringList pairs;
    if (auto found = fish.find(environment); found != fish.end())
      for (const auto &[kind, count] : found->second) pairs << kind + ':' + QString::number(count);
    return pairs.join(',');
  }

  /// Everything that needs a page reload to change; fps, pan and the fish do not.
  QString page() const { return environment + '|' + quality + '|' + resolution + '|' + framing; }
};

/// Drop // and /* */ comments outside strings, then trailing commas, so people can
/// annotate the file and leave a comma behind without breaking it.
static QByteArray stripJsonComments(const QByteArray &text) {
  QByteArray out;
  out.reserve(text.size());
  bool inString = false;
  for (qsizetype i = 0; i < text.size(); ++i) {
    const char c = text[i];
    const char next = i + 1 < text.size() ? text[i + 1] : '\0';
    if (inString) {
      out += c;
      if (c == '\\' && i + 1 < text.size()) out += text[++i];
      else if (c == '"') inString = false;
    } else if (c == '"') {
      inString = true;
      out += c;
    } else if (c == '/' && next == '/') {
      while (i < text.size() && text[i] != '\n') ++i;
      out += '\n';
    } else if (c == '/' && next == '*') {
      i += 2;
      while (i + 1 < text.size() && !(text[i] == '*' && text[i + 1] == '/')) ++i;
      ++i;
    } else {
      out += c;
    }
  }
  static const QRegularExpression trailingComma(R"(,(\s*[}\]]))");
  return QString::fromUtf8(out).replace(trailingComma, "\\1").toUtf8();
}

/// Reads the keys a settings object sets over `base`, ignoring (and reporting) bad values.
static ScreenSettings apply(ScreenSettings base, const QJsonObject &object, const QString &where) {
  auto choice = [&](const char *key, QString &field, const QStringList &allowed) {
    if (!object.contains(key)) return;
    const QString value = object[key].toString().toLower();
    if (allowed.contains(value)) field = value;
    else say("%s: %s must be one of %s", qPrintable(where), key, qPrintable(allowed.join(", ")));
  };
  if (object.contains("enabled")) base.enabled = object["enabled"].toBool(true);
  choice("environment", base.environment, {"riverscape", "reefscape"});
  choice("quality", base.quality, {"eco", "balanced", "detail", "ultra"});
  choice("framing", base.framing, {"auto", "landscape", "portrait"});
  if (object.contains("resolution")) {
    const QJsonValue value = object["resolution"];
    const QString text = value.isDouble() ? QString::number(value.toDouble()) : value.toString().toLower();
    bool number = false;
    const double scale = text.toDouble(&number);
    if (text == "auto" || text == "native" || (number && scale >= 0.25 && scale <= 2)) base.resolution = text;
    else say("%s: resolution must be \"auto\", \"native\" or a number from 0.25 to 2", qPrintable(where));
  }
  if (object.contains("pan")) {
    const QJsonValue value = object["pan"];
    if (value.isString() && value.toString().toLower() == "auto") base.pan = "auto";
    else if (value.isDouble() && value.toDouble() >= -1 && value.toDouble() <= 1)
      base.pan = QString::number(value.toDouble());
    else say("%s: pan must be \"auto\" or a number from -1 to 1", qPrintable(where));
  }
  if (object.contains("panSpeed")) {
    const double speed = object["panSpeed"].toDouble(-1);
    if (speed >= 1 && speed <= 10 && speed == std::floor(speed)) base.panSpeed = int(speed);
    else say("%s: panSpeed must be a whole number from 1 to 10", qPrintable(where));
  }
  // Merged a kind at a time, so a monitor can change one count and keep the rest.
  const QJsonObject tanks = object["fish"].toObject();
  for (auto tank = tanks.begin(); tank != tanks.end(); ++tank) {
    const QJsonObject kinds = tank.value().toObject();
    for (auto kind = kinds.begin(); kind != kinds.end(); ++kind) {
      if (kind.value().isDouble() && kind.value().toDouble() >= 0)
        base.fish[tank.key()][kind.key()] = qRound(kind.value().toDouble());
      else say("%s: fish.%s.%s must be a count", qPrintable(where), qPrintable(tank.key()),
               qPrintable(kind.key()));
    }
  }
  if (object.contains("fps")) {
    const int fps = object["fps"].toInt(0);
    if (fps >= 1 && fps <= 60) base.fps = fps;
    else say("%s: fps must be from 1 to 60", qPrintable(where));
  }
  return base;
}

struct Config {
  ScreenSettings defaults;
  QJsonObject monitors;
  QJsonObject overrides;

  ScreenSettings forScreen(const QString &name) const {
    ScreenSettings settings = defaults;
    if (monitors.contains(name)) settings = apply(settings, monitors[name].toObject(), "monitors." + name);
    // The command line wins over the file, for trying something out.
    return apply(settings, overrides, "command line");
  }
};

static Config readConfig(const QString &path) {
  Config config;
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly)) return config;
  QJsonParseError error;
  const QJsonDocument document = QJsonDocument::fromJson(stripJsonComments(file.readAll()), &error);
  if (!document.isObject()) {
    say("%s: %s; using the defaults", qPrintable(path), qPrintable(error.errorString()));
    return config;
  }
  const QJsonObject root = document.object();
  config.defaults = apply(config.defaults, root, path);
  config.monitors = root["monitors"].toObject();
  return config;
}

// ---------------------------------------------------------------------------------------
// Page plumbing

/// Serves the scene files from disk under habitat://scene/. file:// would block the
/// ES-module imports, and a local HTTP server would be one more thing to run.
class SceneHandler : public QWebEngineUrlSchemeHandler {
public:
  explicit SceneHandler(const QDir &root, QObject *parent) : QWebEngineUrlSchemeHandler(parent),
    root(root.canonicalPath()) {}

  void requestStarted(QWebEngineUrlRequestJob *job) override {
    const QUrl url = job->requestUrl();
    const QString wanted = QDir::cleanPath(root + "/" + url.path());
    const QString path = QFileInfo(wanted).canonicalFilePath();
    if (url.host() != sceneHost || path.isEmpty() || !path.startsWith(root + "/")) {
      job->fail(QWebEngineUrlRequestJob::UrlNotFound);
      return;
    }
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
      job->fail(QWebEngineUrlRequestJob::UrlNotFound);
      return;
    }
    auto *body = new QBuffer(job);
    body->setData(file.readAll());
    body->open(QIODevice::ReadOnly);
    job->reply(mimeType(path), body);
  }

private:
  static QByteArray mimeType(const QString &path) {
    // Module scripts are refused unless served as JavaScript.
    if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
    if (path.endsWith(".bin")) return "application/octet-stream";
    return QMimeDatabase().mimeTypeForFile(path, QMimeDatabase::MatchExtension).name().toUtf8();
  }

  QString root;
};

/// Sends what the page reports to the journal; the wallpaper has no window to look at.
class ScenePage : public QWebEnginePage {
public:
  ScenePage(QWebEngineProfile *profile, QString screen, QObject *parent)
    : QWebEnginePage(profile, parent), screen(std::move(screen)) {}

protected:
  void javaScriptConsoleMessage(JavaScriptConsoleMessageLevel level, const QString &message,
                                int line, const QString &source) override {
    if (level == InfoMessageLevel) return;
    say("[%s] %s (%s:%d)", qPrintable(screen), qPrintable(message), qPrintable(source), line);
  }

private:
  QString screen;
};

/// A pointer shim injected into every page, so the host can move the fish without
/// the surface taking input.
static const char *pointerShim = R"JS(
window.habitatPointerCount = 0;
window.habitatPointer = (x, y) => {
  const canvas = document.querySelector('#scene');
  window.habitatPointerCount++;
  if (canvas)
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
};
window.habitatPointerOut = () => {
  const canvas = document.querySelector('#scene');
  if (canvas) canvas.dispatchEvent(new PointerEvent('pointerleave'));
};
)JS";

static const char *probeScript = R"JS(
(() => {
  const canvas = document.querySelector('#scene');
  const context = canvas && canvas.getContext('webgl2');
  const debug = context && context.getExtension('WEBGL_debug_renderer_info');
  return JSON.stringify({
    url: location.search,
    pixels: canvas && [canvas.width, canvas.height],
    loading: !document.querySelector('#loading').hidden,
    webgl2: Boolean(context),
    gpu: context && context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER),
    stats: typeof window.habitatStats === 'function' ? window.habitatStats() : null,
  });
})()
)JS";

/// One screen's worth of aquarium.
class Surface : public QWebEngineView {
public:
  Surface(QScreen *screen, QWebEngineProfile *profile, const ScreenSettings &settings)
    : screen(screen), settings(settings) {
    setPage(new ScenePage(profile, screen->name(), this));
    page()->setBackgroundColor(QColor("#0b1825"));
    setContextMenuPolicy(Qt::NoContextMenu);

    connect(page(), &QWebEnginePage::loadFinished, this, [this](bool ok) {
      if (!ok) say("[%s] the scene did not load", qPrintable(name()));
      else {
        sendRate();
        sendPan();
        sendPanSpeed();
        sendFish();
      }
    });

    QUrl url(QString("%1://%2/scenes/%3/wallpaper.html").arg(sceneScheme, sceneHost, settings.environment));
    QUrlQuery query;
    query.addQueryItem("quality", settings.quality);
    if (settings.resolution != "auto") query.addQueryItem("scale", settings.resolution);
    query.addQueryItem("framing", settings.framing);
    if (const QString fish = settings.fishQuery(); !fish.isEmpty()) query.addQueryItem("fish", fish);
    url.setQuery(query);
    load(url);

    // Every window in this process is a layer surface (main() selects the layer-shell
    // integration). This has to come after load(): the page adds an OpenGL child, which
    // makes Qt replace the top-level QWindow, and settings on the old one are lost. The
    // Wayland surface itself is only made on show().
    createWinId();
    QWindow *window = windowHandle();
    window->setScreen(screen);
    if (auto *layer = LayerShellQt::Window::get(window)) {
      layer->setScope("desktop-habitats");
      layer->setLayer(LayerShellQt::Window::LayerBottom);
      layer->setAnchors({LayerShellQt::Window::AnchorTop | LayerShellQt::Window::AnchorBottom |
                         LayerShellQt::Window::AnchorLeft | LayerShellQt::Window::AnchorRight});
      layer->setExclusiveZone(-1);
      layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityNone);
    }
    resize(screen->size());
    show();
    say("[%s] %s, %s quality, %s resolution, %d fps, %s framing, %s pan", qPrintable(name()),
        qPrintable(settings.environment), qPrintable(settings.quality),
        qPrintable(settings.resolution), settings.fps, qPrintable(settings.framing),
        qPrintable(settings.pan));
  }

  QString name() const { return screen->name(); }
  const ScreenSettings &current() const { return settings; }

  void setFps(int fps) {
    settings.fps = fps;
    sendRate();
  }

  void setPan(const QString &pan) {
    settings.pan = pan;
    sendPan();
  }

  void setPanSpeed(int speed) {
    settings.panSpeed = speed;
    sendPanSpeed();
  }

  void setFish(const std::map<QString, std::map<QString, int>> &fish) {
    settings.fish = fish;
    say("[%s] fish %s", qPrintable(name()), qPrintable(settings.fishQuery()));
    sendFish();
  }

  void probe() {
    page()->runJavaScript(probeScript, [name = name()](const QVariant &value) {
      say("[%s] page state: %s", qPrintable(name), qPrintable(value.toString()));
    });
  }

  void snapshot(const QString &folder) {
    const QString path = QDir(folder).filePath(name() + ".png");
    if (grab().save(path)) say("[%s] wrote %s", qPrintable(name()), qPrintable(path));
    else say("[%s] could not write %s", qPrintable(name()), qPrintable(path));
  }

private:
  void sendRate() {
    page()->runJavaScript(QString("typeof habitatRate === 'function' && habitatRate(%1)").arg(settings.fps));
  }

  void sendFish() {
    const QString fish = settings.fishQuery();
    if (fish.isEmpty()) return;
    page()->runJavaScript(QString("typeof habitatFish === 'function' && habitatFish('%1')").arg(fish));
  }

  void sendPanSpeed() {
    page()->runJavaScript(QString("typeof habitatSweep === 'function' && habitatSweep(%1)").arg(settings.panSpeed));
  }

  void sendPan() {
    const QString value = settings.pan == "auto" ? "null" : settings.pan;
    page()->runJavaScript(QString("typeof habitatPan === 'function' && habitatPan(%1)").arg(value));
  }

  QScreen *screen;
  ScreenSettings settings;
};

// ---------------------------------------------------------------------------------------

/// Keeps one surface per enabled screen in step with the config file and the outputs.
class Host : public QObject {
public:
  Host(QWebEngineProfile *profile, QString configPath, QJsonObject overrides, QString only)
    : profile(profile), configPath(std::move(configPath)), overrides(std::move(overrides)),
      only(std::move(only)) {
    // Editors often replace the file rather than write into it, so watch the folder too,
    // and let a burst of events settle before reading.
    debounce.setSingleShot(true);
    debounce.setInterval(200);
    connect(&debounce, &QTimer::timeout, this, &Host::sync);
    connect(&watcher, &QFileSystemWatcher::fileChanged, &debounce, qOverload<>(&QTimer::start));
    connect(&watcher, &QFileSystemWatcher::directoryChanged, &debounce, qOverload<>(&QTimer::start));
    watcher.addPath(QFileInfo(this->configPath).absolutePath());
    connect(qApp, &QGuiApplication::screenAdded, &debounce, qOverload<>(&QTimer::start));
    connect(qApp, &QGuiApplication::screenRemoved, this, [this](QScreen *screen) {
      if (auto found = surfaces.find(screen->name()); found != surfaces.end()) {
        delete found->second;
        surfaces.erase(found);
      }
    });
    sync();
  }

  ~Host() override {
    for (auto &[name, surface] : surfaces) delete surface;
  }

  void each(const std::function<void(Surface *)> &act) {
    for (auto &[name, surface] : surfaces) act(surface);
  }

private:
  void sync() {
    if (QFile::exists(configPath) && !watcher.files().contains(configPath)) watcher.addPath(configPath);
    Config config = readConfig(configPath);
    config.overrides = overrides;

    std::map<QString, QScreen *> screens;
    for (QScreen *screen : QGuiApplication::screens())
      if (only.isEmpty() || screen->name() == only) screens[screen->name()] = screen;

    for (auto it = surfaces.begin(); it != surfaces.end();) {
      const ScreenSettings wanted = config.forScreen(it->first);
      Surface *surface = it->second;
      if (!screens.contains(it->first) || !wanted.enabled || wanted.page() != surface->current().page()) {
        delete surface;
        it = surfaces.erase(it);
        continue;
      }
      if (wanted.fps != surface->current().fps) surface->setFps(wanted.fps);
      if (wanted.pan != surface->current().pan) surface->setPan(wanted.pan);
      if (wanted.panSpeed != surface->current().panSpeed) surface->setPanSpeed(wanted.panSpeed);
      if (wanted.fishQuery() != surface->current().fishQuery()) surface->setFish(wanted.fish);
      ++it;
    }
    for (auto &[name, screen] : screens) {
      const ScreenSettings wanted = config.forScreen(name);
      if (wanted.enabled && !surfaces.contains(name))
        surfaces[name] = new Surface(screen, profile, wanted);
    }
  }

  QWebEngineProfile *profile;
  QString configPath;
  QJsonObject overrides;
  QString only;
  QFileSystemWatcher watcher;
  QTimer debounce;
  std::map<QString, Surface *> surfaces;
};

int main(int argc, char **argv) {
  // The page is a wallpaper: the host decides when it runs, not Chromium's idea of
  // whether the view is visible.
  if (qEnvironmentVariableIsEmpty("QTWEBENGINE_CHROMIUM_FLAGS"))
    qputenv("QTWEBENGINE_CHROMIUM_FLAGS",
            "--ignore-gpu-blocklist --enable-gpu-rasterization "
            "--disable-background-timer-throttling --disable-renderer-backgrounding "
            "--disable-backgrounding-occluded-windows");

  // Per-window opt-in through LayerShellQt::Window::get() comes too late for a QWidget,
  // whose native window already exists by the time it has a QWindow to hand over.
  qputenv("QT_WAYLAND_SHELL_INTEGRATION", "layer-shell");

  QWebEngineUrlScheme scheme(sceneScheme);
  scheme.setSyntax(QWebEngineUrlScheme::Syntax::Host);
  scheme.setFlags(QWebEngineUrlScheme::SecureScheme | QWebEngineUrlScheme::LocalScheme |
                  QWebEngineUrlScheme::LocalAccessAllowed | QWebEngineUrlScheme::CorsEnabled |
                  QWebEngineUrlScheme::FetchApiAllowed);
  QWebEngineUrlScheme::registerScheme(scheme);

  QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);
  QApplication app(argc, argv);
  // Every screen can be switched off in the settings; the host has to outlive that and
  // keep watching the file, or a screen could never be switched back on.
  app.setQuitOnLastWindowClosed(false);
  QApplication::setApplicationName("desktop-habitats");

  const QString configHome = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
  QCommandLineParser options;
  options.setApplicationDescription("Live aquarium wallpaper for Wayland (layer-shell) desktops.");
  options.addHelpOption();
  options.addOption({"config", "Settings file (created with defaults if missing).", "path",
                     configHome + "/desktop-habitats/config.jsonc"});
  options.addOption({"root", "Folder holding scenes/, ui/ and vendor/.", "path", QDir::currentPath()});
  options.addOption({"screen", "Only this output (e.g. DP-1).", "name"});
  options.addOption({"env", "Override the environment.", "name"});
  options.addOption({"quality", "Override the quality.", "name"});
  options.addOption({"resolution", "Override the resolution.", "value"});
  options.addOption({"fps", "Override the frame rate.", "fps"});
  options.addOption({"framing", "Override the framing.", "name"});
  options.addOption({"pan", "Override the pan: auto, or -1 to 1.", "value"});
  options.addOption({"probe", "Log each page's state every N seconds.", "seconds", "0"});
  options.addOption({"snapshot", "Save a PNG of each screen into this folder after --snapshot-after.", "folder"});
  options.addOption({"snapshot-after", "Seconds to wait before the snapshot.", "seconds", "12"});
  options.addOption({"quit-after", "Exit after N seconds.", "seconds", "0"});
  options.process(app);

  const QDir root(options.value("root"));
  if (!root.exists("scenes/riverscape/wallpaper.html")) {
    say("no scenes under %s (use --root)", qPrintable(root.absolutePath()));
    return 2;
  }

  const QString configPath = options.value("config");
  if (!QFile::exists(configPath)) {
    QDir().mkpath(QFileInfo(configPath).absolutePath());
    QSaveFile file(configPath);
    if (file.open(QIODevice::WriteOnly) && file.write(defaultConfig) >= 0 && file.commit())
      say("wrote default settings to %s", qPrintable(configPath));
  }

  QJsonObject overrides;
  if (options.isSet("env")) overrides["environment"] = options.value("env");
  if (options.isSet("quality")) overrides["quality"] = options.value("quality");
  if (options.isSet("resolution")) overrides["resolution"] = options.value("resolution");
  if (options.isSet("fps")) overrides["fps"] = options.value("fps").toInt();
  if (options.isSet("framing")) overrides["framing"] = options.value("framing");
  if (options.isSet("pan")) {
    bool number = false;
    const double pan = options.value("pan").toDouble(&number);
    overrides["pan"] = number ? QJsonValue(pan) : QJsonValue(options.value("pan"));
  }

  // No storage name makes the profile off the record: nothing is kept between runs.
  auto *profile = new QWebEngineProfile(&app);
  profile->installUrlSchemeHandler(sceneScheme, new SceneHandler(root, profile));
  profile->settings()->setAttribute(QWebEngineSettings::WebGLEnabled, true);
  profile->settings()->setAttribute(QWebEngineSettings::Accelerated2dCanvasEnabled, true);
  profile->settings()->setAttribute(QWebEngineSettings::ShowScrollBars, false);
  QWebEngineScript shim;
  shim.setName("habitat-pointer");
  shim.setSourceCode(pointerShim);
  shim.setInjectionPoint(QWebEngineScript::DocumentCreation);
  shim.setWorldId(QWebEngineScript::MainWorld);
  shim.setRunsOnSubFrames(false);
  profile->scripts()->insert(shim);

  auto *host = new Host(profile, configPath, overrides, options.value("screen"));

  if (const int every = options.value("probe").toInt(); every > 0) {
    auto *timer = new QTimer(&app);
    QObject::connect(timer, &QTimer::timeout, [host] { host->each([](Surface *s) { s->probe(); }); });
    timer->start(every * 1000);
  }
  if (options.isSet("snapshot")) {
    const QString folder = options.value("snapshot");
    QDir().mkpath(folder);
    QTimer::singleShot(options.value("snapshot-after").toInt() * 1000, &app,
                       [host, folder] { host->each([&](Surface *s) { s->snapshot(folder); }); });
  }
  if (const int after = options.value("quit-after").toInt(); after > 0)
    QTimer::singleShot(after * 1000, &app, &QApplication::quit);

  const int status = app.exec();
  delete host;
  delete profile;
  return status;
}
