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
