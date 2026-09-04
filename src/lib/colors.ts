/**
 * Colour encodings for every quantitative display in the app.
 *
 * Value Score and the heatmaps use a **red → yellow → green** scale, carried
 * over from the original SLA app: red is bad, green is good, yellow is middling.
 * This is the convention the league already reads fluently, and matching it was
 * an explicit product decision.
 *
 * Red/green scales are hard to read with the most common forms of colour-vision
 * deficiency, so every surface using one carries a second, non-colour channel:
 *
 *  - Every heatmap cell prints its own number, and each heatmap has a
 *    Heatmap/Table toggle that drops the fills entirely.
 *  - Value and matchup chips print their score inside the chip.
 *  - Boom/bust wears the reserved status palette *and* always ships an arrow
 *    icon plus a text label.
 *
 * Chart series are the exception: those stay on the validated categorical pair
 * (#2a78d6/#eb6834 light, #3987e5/#d95926 dark), which clears lightness, chroma,
 * CVD separation and 3:1 surface contrast in both modes. Lines can't print their
 * value at every point, so they need the safe palette.
 */

import { clamp01 } from './stats';

/* -------------------------------------------------------------------------- */
/* OKLab conversion — used to interpolate ramps perceptually rather than in     */
/* sRGB, which is what keeps the diverging arms lightness-monotone.            */
/* -------------------------------------------------------------------------- */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) => {
    const n = Math.round(clamp01(v) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${to(r)}${to(g)}${to(b)}`;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function rgbToOklab(c: Rgb): Oklab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(c: Oklab): Rgb {
  const l = (c.L + 0.3963377774 * c.a + 0.2158037573 * c.b) ** 3;
  const m = (c.L - 0.1055613458 * c.a - 0.0638541728 * c.b) ** 3;
  const s = (c.L - 0.0894841775 * c.a - 1.291485548 * c.b) ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Perceptually-uniform mix between two hex colours. `t` runs 0→1. */
export function mixOklab(fromHex: string, toHex: string, t: number): string {
  const a = rgbToOklab(hexToRgb(fromHex));
  const b = rgbToOklab(hexToRgb(toHex));
  const k = clamp01(t);
  return rgbToHex(
    oklabToRgb({
      L: a.L + (b.L - a.L) * k,
      a: a.a + (b.a - a.a) * k,
      b: a.b + (b.b - a.b) * k,
    }),
  );
}

/** Relative luminance, for choosing readable text on a generated fill. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Picks whichever ink reads better on a generated background.
 * Needed because heatmap fills are computed, not hand-picked.
 */
export function inkFor(background: string, mode: Mode): string {
  const light = mode === 'dark' ? '#ffffff' : '#0b0b0b';
  const dark = mode === 'dark' ? '#0b0b0b' : '#ffffff';
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export type Mode = 'light' | 'dark';

/** Two-series categorical slots. Slot 1 = projected, slot 2 = actual. */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

/**
 * Stable categorical colours for fantasy teams.
 *
 * The same roster id keeps the same colour across standings and charts, while
 * separate light/dark palettes keep team names readable against either surface.
 * Colour is never the only identifier: every mark is paired with the team name.
 */
export const TEAM_COLORS = {
  light: ['#1769aa', '#9c4a00', '#08765b', '#6f52b5', '#a23b72', '#006d77'],
  dark: ['#74b7ff', '#ffad73', '#65d7ad', '#c3a8ff', '#ff92c7', '#67d4df'],
} as const;

export function teamColor(teamId: number, mode: Mode): string {
  const palette = TEAM_COLORS[mode];
  const index = Math.abs(Math.trunc(teamId) - 1) % palette.length;
  return palette[index];
}

/**
 * The red → yellow → green scale, per mode.
 *
 * `mid` is a true yellow rather than a neutral, matching the original app: the
 * middle of the range reads as "average", not as "no data". Steps are
 * interpolated in OKLab so the perceived brightness climbs smoothly instead of
 * spiking through the yellow, which is what makes naive RGB red→green ramps
 * look banded.
 */
const RYG = {
  light: { low: '#d92d20', mid: '#e8a704', high: '#129d4e' },
  dark: { low: '#f04438', mid: '#fac515', high: '#2bb673' },
} as const;

/**
 * Samples the red→yellow→green scale at `t` (0 = worst, 1 = best).
 * Exported so charts and legends can draw the same ramp.
 */
export function rygColor(t: number, mode: Mode): string {
  const { low, mid, high } = RYG[mode];
  const k = clamp01(t);
  return k < 0.5 ? mixOklab(low, mid, k * 2) : mixOklab(mid, high, (k - 0.5) * 2);
}

/** Reserved status palette. Never themed, never reused for a series. */
export const STATUS_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/* -------------------------------------------------------------------------- */
/* Encodings                                                                   */
/* -------------------------------------------------------------------------- */

export interface HeatCell {
  background: string;
  ink: string;
}

/**
 * Heatmap cell fill on the red → yellow → green scale.
 *
 * `t` is the value's position within its column, normalised to 0..1 with 0.5
 * meaning "at the league median" — see `divergingPosition`. Centring on the
 * median keeps yellow honest as "typical" even when one team has a runaway
 * week and would otherwise drag a min/max scale.
 *
 * Fills are washed toward the surface so the printed number stays legible on
 * top; the selected team's row uses a stronger wash to stand out without
 * changing hue.
 */
export function heatmapCell(t: number, mode: Mode, emphasis = false): HeatCell {
  const pure = rygColor(t, mode);
  const surface = mode === 'dark' ? '#1a1a19' : '#fcfcfb';

  // A full-strength fill behind every cell is overwhelming across a whole grid,
  // so the colour is muted toward the surface and the selected row less so.
  const background = mixOklab(pure, surface, emphasis ? 0.3 : 0.55);

  return { background, ink: inkFor(background, mode) };
}

/**
 * Normalises a value against a column of values, centred on the median.
 *
 * Centring on the median (rather than the midpoint of min/max) is what makes
 * the diverging encoding honest: the neutral colour genuinely means "typical",
 * even when one team has a runaway week.
 */
export function divergingPosition(value: number, column: number[]): number {
  if (column.length < 2) return 0.5;

  const sorted = [...column].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  if (value === mid || max === min) return 0.5;

  if (value < mid) {
    const span = mid - min;
    return span <= 0 ? 0.5 : 0.5 * clamp01((value - min) / span);
  }

  const span = max - mid;
  return span <= 0 ? 0.5 : 0.5 + 0.5 * clamp01((value - mid) / span);
}

/** Neutral chip used whenever a score is missing. */
function emptyChip(mode: Mode): HeatCell {
  return {
    background: mode === 'dark' ? '#2c2c2a' : '#e1e0d9',
    ink: mode === 'dark' ? '#c3c2b7' : '#52514e',
  };
}

/**
 * Value Score chip (0–1000) on the red → yellow → green scale.
 *
 * Real scores cluster between roughly 420 and 850, so the ramp is anchored
 * there rather than to the nominal 0–1000 range — otherwise every player would
 * land in the same narrow band of green and the colour would say nothing.
 */
export function valueScoreFill(score: number | null, mode: Mode): HeatCell {
  if (score === null || !Number.isFinite(score)) return emptyChip(mode);

  const background = rygColor(clamp01((score - 420) / (850 - 420)), mode);
  return { background, ink: inkFor(background, mode) };
}

/**
 * Matchup Score chip (0–100), where 100 is the softest defence to face.
 * Same scale as Value so the two read as the same kind of quantity.
 */
export function matchupScoreFill(score: number | null, mode: Mode): HeatCell {
  if (score === null || !Number.isFinite(score)) return emptyChip(mode);

  const background = rygColor(clamp01(score / 100), mode);
  return { background, ink: inkFor(background, mode) };
}
