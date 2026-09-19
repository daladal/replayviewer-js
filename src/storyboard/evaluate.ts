/**
 * Pure per-frame evaluation of a compiled storyboard sprite: the value of each property at time
 * `t` and the resulting draw state. Mirrors what osu!framework's transform tracker converges to
 * after `StoryboardSprite.ApplyTransforms` has pre-applied every command — the transform with
 * the latest start time that has begun wins, holds its end value after its end, and the first
 * command of each property seeds the value before it starts.
 *
 * The hot path allocates nothing: state is written into a caller-owned {@link SpriteState}, and
 * each track remembers the command it last resolved so forward playback is O(1) per property.
 */

import { applyEasing } from './easing.js';
import type { Cmd } from './types.js';
import type { CompiledSprite, CompiledAnimation, CompiledVideo, PropertyTrack } from './StoryboardCompiler.js';

/** `Drawable.IsPresent` cutoff (`visibility_cutoff` in osu!framework). */
const VISIBILITY_CUTOFF = 0.0001;

/** Colour tweens run in linear light (`Interpolation.ValueAt(Color4)` converts through `ToLinear`). */
const COLOUR_LERP_LINEAR = true;

export type Lerp<T> = (a: T, b: T, k: number) => T;

export const lerpNumber: Lerp<number> = (a, b, k) => a + (b - a) * k;
export const lerpVector: Lerp<[number, number]> = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

function toLinearExact(c: number): number { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function toSRGBExact(c: number): number { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

// Thousands of tinted sprites per frame make the two `Math.pow` conversions measurable. Colour
// endpoints are 8-bit values, so sRGB → linear is an exact 256-entry table; linear → sRGB is a
// 1024-entry table with linear interpolation (max error ≈ 0.3/255, below the 8-bit quantisation
// the tint cache applies anyway).
const LINEAR_OF_8BIT = new Float64Array(256);
for (let i = 0; i < 256; i++) LINEAR_OF_8BIT[i] = toLinearExact(i / 255);
const SRGB_STEPS = 1024;
const SRGB_OF_LINEAR = new Float64Array(SRGB_STEPS + 1);
for (let i = 0; i <= SRGB_STEPS; i++) SRGB_OF_LINEAR[i] = toSRGBExact(i / SRGB_STEPS);

function toLinear(c: number): number {
  const i = c * 255;
  const j = i | 0;
  return i === j && j >= 0 && j <= 255 ? LINEAR_OF_8BIT[j]! : toLinearExact(c);
}
function toSRGB(c: number): number {
  if (!(c > 0)) return 0;
  if (c >= 1) return 1;
  const x = c * SRGB_STEPS;
  const i = x | 0;
  const f = x - i;
  return SRGB_OF_LINEAR[i]! + (SRGB_OF_LINEAR[i + 1]! - SRGB_OF_LINEAR[i]!) * f;
}

function lerpChannel(x: number, y: number, k: number): number {
  if (x === y) return x;
  return COLOUR_LERP_LINEAR ? toSRGB(toLinear(x) + (toLinear(y) - toLinear(x)) * k) : x + (y - x) * k;
}

/** Per-channel lerp with `k` clamped to 0..1 (the framework clamps for colours only). */
export const lerpColour: Lerp<[number, number, number]> = (a, b, k) => {
  const kk = k < 0 ? 0 : k > 1 ? 1 : k;
  return [lerpChannel(a[0], b[0], kk), lerpChannel(a[1], b[1], kk), lerpChannel(a[2], b[2], kk)];
};

/** Parameter commands are step functions: the start value holds until the end time. */
export const stepValue = <T>(a: T): T => a;

/**
 * Index of the command in force at `t` — the last one with `startTime <= t` — or -1 before the
 * first. Checks the track's cached index and its successor before falling back to a binary
 * search, so a monotonically advancing clock resolves each property in constant time.
 */
function findCommand<T>(track: PropertyTrack<T>, t: number): number {
  const starts = track.starts;
  const n = starts.length;
  const last = track.last;
  if (last >= 0 && last < n && starts[last]! <= t) {
    if (last + 1 >= n || starts[last + 1]! > t) return last;
    if (last + 2 >= n || starts[last + 2]! > t) { track.last = last + 1; return last + 1; }
  } else if (last < 0 && n > 0 && starts[0]! > t) {
    return -1;
  }
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  track.last = ans;
  return ans;
}

/** Normalised, eased progress of `c` at `t` (0 at/before start, 1 at/after end). */
function progress<T>(c: Cmd<T>, t: number): number {
  if (t <= c.startTime) return 0;
  if (t >= c.endTime) return 1;
  return applyEasing(c.easing, (t - c.startTime) / (c.endTime - c.startTime));
}

/**
 * Value of one property at `t`. `track` holds every command for the property sorted by
 * (startTime, application order). Before the first command the first command's start value
 * applies (`ApplyInitialValue`); for parameter commands only when that command is instantaneous
 * (`IStoryboardCommand.ApplyInitialValue`: "only apply the start value if they have zero duration").
 */
export function valueAt<T>(track: PropertyTrack<T>, t: number, defaultValue: T, lerp: Lerp<T>, isParameter = false): T {
  const cmds = track.cmds;
  if (cmds.length === 0) return defaultValue;
  const i = findCommand(track, t);
  if (i < 0) {
    const first = cmds[0]!;
    return isParameter && first.startTime !== first.endTime ? defaultValue : first.startValue;
  }
  return interpolate(cmds[i]!, t, lerp);
}

/** `TransformCustom.valueAt` + `Interpolation.ValueAt` for one command. */
export function interpolate<T>(c: Cmd<T>, t: number, lerp: Lerp<T>): T {
  if (t < c.startTime) return c.startValue;
  if (t >= c.endTime) return c.endValue;
  if (c.startValue === c.endValue) return c.startValue;
  const current = t - c.startTime;
  if (current === 0) return c.startValue;
  const duration = c.endTime - c.startTime;
  return lerp(c.startValue, c.endValue, applyEasing(c.easing, current / duration));
}

/** Scalar property, allocation-free. */
function numberAt(track: PropertyTrack<number>, t: number, defaultValue: number): number {
  const cmds = track.cmds;
  if (cmds.length === 0) return defaultValue;
  const i = findCommand(track, t);
  if (i < 0) return cmds[0]!.startValue;
  const c = cmds[i]!;
  if (t >= c.endTime) return c.endValue;
  const k = progress(c, t);
  return c.startValue + (c.endValue - c.startValue) * k;
}

/** Parameter property (`P`), allocation-free. */
function parameterAt<T>(track: PropertyTrack<T>, t: number, defaultValue: T): T {
  const cmds = track.cmds;
  if (cmds.length === 0) return defaultValue;
  const i = findCommand(track, t);
  if (i < 0) {
    const first = cmds[0]!;
    return first.startTime !== first.endTime ? defaultValue : first.startValue;
  }
  const c = cmds[i]!;
  return t >= c.endTime ? c.endValue : c.startValue;
}

export interface SpriteState {
  /** Storyboard units. */
  x: number;
  y: number;
  scale: number;
  vsx: number;
  vsy: number;
  /** Radians, clockwise on the y-down canvas. */
  rotation: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  additive: boolean;
  flipH: boolean;
  flipV: boolean;
}

/** A fresh state object for {@link spriteStateInto}. */
export function newSpriteState(): SpriteState {
  return { x: 0, y: 0, scale: 1, vsx: 1, vsy: 1, rotation: 0, r: 1, g: 1, b: 1, alpha: 1, additive: false, flipH: false, flipV: false };
}

/**
 * Draw state of a sprite at `t` written into `out`; false when it is not drawn: outside its
 * lifetime, invisible (`alpha % 1` wrap included — `DrawableStoryboardSprite.Update`:
 * `if (Alpha > 1) Alpha %= 1;`, the flicker idiom stable storyboards rely on), or at a NaN position.
 */
export function spriteStateInto(s: CompiledSprite, t: number, out: SpriteState): boolean {
  if (t < s.startTime || t >= s.endTimeForDisplay) return false;
  let alpha = numberAt(s.alpha, t, 1);
  if (alpha > 1) alpha = alpha % 1;
  if (!(alpha > VISIBILITY_CUTOFF)) return false;
  const x = numberAt(s.x, t, s.initialX);
  const y = numberAt(s.y, t, s.initialY);
  if (Number.isNaN(x) || Number.isNaN(y)) return false;
  out.alpha = alpha;
  out.x = x;
  out.y = y;
  out.scale = numberAt(s.scale, t, 1);
  out.rotation = numberAt(s.rotation, t, 0);

  const vs = s.vectorScale.cmds;
  if (vs.length === 0) { out.vsx = 1; out.vsy = 1; }
  else {
    const i = findCommand(s.vectorScale, t);
    if (i < 0) { const v = vs[0]!.startValue; out.vsx = v[0]; out.vsy = v[1]; }
    else {
      const c = vs[i]!;
      const k = progress(c, t);
      out.vsx = c.startValue[0] + (c.endValue[0] - c.startValue[0]) * k;
      out.vsy = c.startValue[1] + (c.endValue[1] - c.startValue[1]) * k;
    }
  }

  const cs = s.colour.cmds;
  if (cs.length === 0) { out.r = 1; out.g = 1; out.b = 1; }
  else {
    const i = findCommand(s.colour, t);
    if (i < 0) { const v = cs[0]!.startValue; out.r = v[0]; out.g = v[1]; out.b = v[2]; }
    else {
      const c = cs[i]!;
      let k = progress(c, t);
      if (k < 0) k = 0; else if (k > 1) k = 1;
      const a = c.startValue, b = c.endValue;
      out.r = lerpChannel(a[0], b[0], k);
      out.g = lerpChannel(a[1], b[1], k);
      out.b = lerpChannel(a[2], b[2], k);
    }
  }

  out.additive = parameterAt(s.blending, t, 'inherit') === 'additive';
  out.flipH = parameterAt(s.flipH, t, false);
  out.flipV = parameterAt(s.flipV, t, false);
  return true;
}

/** Allocating convenience over {@link spriteStateInto}: the state at `t`, or null when not drawn. */
export function spriteStateAt(s: CompiledSprite, t: number): SpriteState | null {
  const out = newSpriteState();
  return spriteStateInto(s, t, out) ? out : null;
}

/**
 * Frame shown by an animation at `t` (`AnimationClockComposite.PlaybackPosition` +
 * `Animation.updateFrameIndex`): frame 0 is anchored at the sprite's earliest transform time,
 * `LoopForever` wraps, `LoopOnce` holds the last frame, and time before the start clamps to
 * frame 0. Returns -1 for an animation with no frames.
 */
export function animationFrameIndex(a: CompiledAnimation, t: number): number {
  const n = a.frameCount, d = a.frameDelay, dur = n * d;
  if (n <= 0) return -1;
  if (!(dur > 0)) return 0;
  let pos = t - a.earliestTransformTime;
  if (a.loopType === 'LoopForever') pos = pos % dur;
  pos = Math.min(Math.max(pos, 0), dur);
  return Math.min(n - 1, Math.floor(pos / d));
}

/** Length of the linear fade a video gets at each end of its playback (`DrawableStoryboardVideo`). */
export const VIDEO_FADE_MS = 500;

/**
 * Alpha of a video at map time `t`: 0 outside `[offset, offset + duration]`, a linear 500 ms
 * fade-in after the offset and fade-out before the end, times the video's own `F` commands
 * (which run on map time, like a sprite's). `durationMs` null (not known yet) draws nothing.
 */
export function videoAlphaAt(v: CompiledVideo, t: number, durationMs: number | null): number {
  if (durationMs === null) return 0;
  const videoMs = t - v.offsetMs;
  if (videoMs < 0 || videoMs > durationMs) return 0;
  let a = 1;
  if (videoMs < VIDEO_FADE_MS) a = videoMs / VIDEO_FADE_MS;
  if (videoMs > durationMs - VIDEO_FADE_MS) a = Math.min(a, (durationMs - videoMs) / VIDEO_FADE_MS);
  return a * valueAt(v.alpha, t, 1, lerpNumber);
}
