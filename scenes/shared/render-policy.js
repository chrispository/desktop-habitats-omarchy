export function framebufferSize(width, height, scale, maxDimension = 8192, maxPixels = Infinity) {
  if (!(width > 0 && height > 0 && scale > 0)) return null;
  const safeScale = Math.min(scale, maxDimension / width, maxDimension / height, Math.sqrt(maxPixels / (width * height)));
  return {
    width: Math.max(1, Math.round(width * safeScale)),
    height: Math.max(1, Math.round(height * safeScale)),
    scale: safeScale,
  };
}

// Presentation cadence is shared; scene-specific lighting and geometry stay local.
export const QUALITY_PRESETS = Object.freeze({
  eco: Object.freeze({ fps: 20, pixels: 1050000, dpr: 1 }),
  balanced: Object.freeze({ fps: 30, pixels: 1800000, dpr: 1.25 }),
  detail: Object.freeze({ fps: 60, pixels: 3000000, dpr: 1.5 }),
  // No pixel budget: every device pixel is drawn, up to a 2x supersampled display.
  ultra: Object.freeze({ fps: 60, pixels: Infinity, dpr: 2 }),
});

// A host can ask for an exact render scale in place of the quality's pixel budget.
// "native" draws one pixel per device pixel; a number scales that (0.5 is half, 1.5
// supersampled). Anything else leaves the quality in charge.
export function resolutionScale(value) {
  if (value === 'native') return 1;
  if (value === null || value === undefined || value === '') return null;
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.25 && scale <= 2 ? scale : null;
}

// How a host wants the tank composed, whatever shape the screen is: "landscape" keeps
// the wide composition, "portrait" the narrow one, "auto" picks from the screen.
export function framingAspect(framing, aspect) {
  if (framing === 'landscape') return Math.max(aspect, 1.3);
  if (framing === 'portrait') return Math.min(aspect, 0.65);
  return aspect;
}

// Where a narrow screen looks along the tank: -1 is its left end, 0 the middle and 1 its
// right end, where the ends are those the wide composition shows. Anything else is null,
// which leaves the choice to the scene.
export function panPosition(value) {
  if (value === null || value === undefined || value === '' || value === 'auto') return null;
  const pan = Number(value);
  return Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : null;
}

// How far to slide the camera sideways for a pan. `reach` is the half-width the wide
// composition shows at the target; a view already that wide has nowhere to slide.
export function panOffset(pan, fov, aspect, distance, reach) {
  const half = distance * Math.tan((fov * Math.PI) / 360) * aspect;
  return pan * Math.max(0, reach - half);
}

// The auto pan: a slow sweep from one end of the tank to the other and back, easing
// through each end. A round trip takes SWEEP_SECONDS at speed 1.
export const SWEEP_SECONDS = 120;
// Sweep speed settings run 1 to 10, each √2 faster than the last: 5 is a two-minute round
// trip, 9 thirty seconds. Returns the multiplier on SWEEP_SECONDS' pace.
export const SWEEP_LEVELS = [1, 10];
export const SWEEP_DEFAULT = 5;
export function sweepSpeed(value) {
  const level = Math.round(Number(value));
  const setting = value === null || value === undefined || value === '' || !Number.isFinite(level)
    ? SWEEP_DEFAULT : Math.min(SWEEP_LEVELS[1], Math.max(SWEEP_LEVELS[0], level));
  return 2 ** ((setting - SWEEP_DEFAULT) / 2);
}

// Advances the sweep's phase by dt seconds. The phase, not the time, carries the sweep,
// so a change of speed carries on from where the view is rather than jumping.
export function sweepPhase(phase, dt, speed) {
  return (phase + (dt * speed * 2 * Math.PI) / SWEEP_SECONDS) % (2 * Math.PI);
}

// The pan a sweep phase stands for, -1 to 1.
export function sweepPan(phase) {
  return Math.sin(phase);
}

// The wide composition's half-width at the target, for a 16:9 screen.
export function wideReach(fov, distance) {
  return distance * Math.tan((fov * Math.PI) / 360) * (16 / 9);
}

// A host's fish counts, "name:count,name:count", clamped to each kind's [min, max].
// Kinds not named keep their defaults.
export function fishCounts(value, defaults, limits) {
  const counts = { ...defaults };
  for (const pair of String(value || '').split(',')) {
    const [name, raw] = pair.split(':');
    if (!Object.hasOwn(counts, name)) continue;
    const count = Math.round(Number(raw));
    if (Number.isFinite(count)) counts[name] = Math.min(limits[name][1], Math.max(limits[name][0], count));
  }
  return counts;
}

export function qualityName(value) {
  return Object.hasOwn(QUALITY_PRESETS, value) ? value : 'balanced';
}

export function frameRate(quality, requested = 60, onBattery = false) {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(QUALITY_PRESETS[qualityName(quality)].fps, requested, onBattery ? 30 : 60);
}

export function renderScale(quality, pixelRatio = 1, onBattery = false) {
  const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return Math.min(dpr, QUALITY_PRESETS[qualityName(quality)].dpr) * (onBattery ? 0.9 : 1);
}
