import type { HitResult, SkinAssets, LazerMod } from '../types/index';
import type { ScoreFrame } from '../utils/scoreProcessor';
import { MOD_ICON_SPECS, composeModIcon, extendedModIconInfo, type LazerModIconTextures } from '../utils/modIcons';

const CANVAS_W  = 1280;

const SCORE_RIGHT_X = CANVAS_W - 4;
const SCORE_Y       = 4;
const SCORE_DIGIT_H = 30;
const SCORE_DIGITS  = 8;

const ACC_DIGIT_H = 22;
const ACC_RIGHT_X = CANVAS_W - 4;
const ACC_Y       = SCORE_Y + SCORE_DIGIT_H + 2;

const COMBO_LEFT_X  = 14;
const CANVAS_H      = 720;
const COMBO_DIGIT_H = 32;
const COMBO_Y       = CANVAS_H - COMBO_DIGIT_H - 4;
const COMBO_ANIM_MS = 250;

/** One point of the running-accuracy timeline: accuracy as of `time` (beatmap ms). */
export interface AccFrame {
  time: number;
  acc:  number;   // 0..1
}

/**
 * Running accuracy after each judged object, in time order.
 * osu! acc = sum(judgements) / (300 × objectCount); slider sub-results and
 * combo-ignored ticks are excluded.
 */
export function computeAccTimeline(results: readonly HitResult[]): AccFrame[] {
  const sorted = [...results].sort((a, b) => a.time - b.time);

  const frames: AccFrame[] = [];
  let judgeSum = 0;
  let objCount = 0;

  for (const r of sorted) {
    // Std slider ticks/edges/tail are off-accuracy; taiko comboIgnore ticks too.
    if (r.isSliderSub) continue;
    if (r.comboIgnore) continue;
    judgeSum += r.judgement;
    objCount++;
    frames.push({ time: r.time, acc: judgeSum / (300 * objCount) });
  }

  return frames;
}

/** Taiko running accuracy: (great + 0.5×ok) / (great + ok + miss).
 * Scaling Ok to 150 in the 300-based sum reduces to exactly this. */
export function computeTaikoAccTimeline(results: readonly HitResult[]): AccFrame[] {
  const sorted = [...results].sort((a, b) => a.time - b.time);

  const frames: AccFrame[] = [];
  let weightedSum = 0;
  let objCount = 0;

  for (const r of sorted) {
    if (r.comboIgnore) continue;
    if      (r.judgement === 300) weightedSum += 300;
    else if (r.judgement === 100) weightedSum += 150;
    objCount++;
    frames.push({ time: r.time, acc: weightedSum / (300 * objCount) });
  }

  return frames;
}

/** One point of the displayed-combo timeline: combo value as of `time` (beatmap ms). */
export interface ComboFrame {
  time:  number;
  combo: number;
}

/**
 * Displayed combo after each judged result, in time order. `comboBreak` resets the combo
 * and blocks the increment; a tail miss (judgement=0, comboBreak=false) leaves combo alone.
 */
export function computeComboTimeline(results: readonly HitResult[]): ComboFrame[] {
  const sorted = [...results].sort((a, b) => a.time - b.time);

  const frames: ComboFrame[] = [];
  let combo = 0;

  for (const r of sorted) {
    if (r.comboIgnore) continue;
    if (r.comboBreak) combo = 0;
    if (r.judgement > 0 && !r.comboBreak) combo++;
    frames.push({ time: r.time, combo });
  }

  return frames;
}

function findBefore(frames: readonly { time: number }[], timeMs: number): number {
  if (frames.length === 0 || timeMs < frames[0]!.time) return -1;
  if (timeMs >= frames[frames.length - 1]!.time) return frames.length - 1;
  let lo = 0, hi = frames.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.time <= timeMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const SCORE_GLYPH_SUFFIX: Record<string, string> = {
  '0': '0', '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  '.': 'dot', '%': 'percent', 'x': 'x',
};

/**
 * Resolve a score/combo glyph bitmap. `prefix` is the skin.ini path-prefix
 * (e.g. `score`, or `fonts/score/score` for subfolder skins); the image map
 * is already full-path-keyed by SkinLoader.
 *
 * When both `@2x` and 1× variants exist, the choice is size-aware: `targetPx`
 * is the glyph's on-screen height in device pixels (logical digitH × canvas
 * scale). The @2x source is twice the 1× source, so blindly using it forces a
 * large single-step downscale on small text — the accuracy readout (the
 * smallest HUD number) ends up visibly fuzzier than everything else. We only
 * reach for @2x once the target is taller than the 1× glyph; below that the 1×
 * source needs far less downscaling (and never upscales), staying crisp.
 * `targetPx` undefined keeps the variant-agnostic @2x preference for callers
 * that only need the aspect ratio (identical across variants).
 */
function glyphImage(
  images: Map<string, ImageBitmap>,
  prefix: string,
  ch: string,
  targetPx?: number,
): ImageBitmap | undefined {
  const suffix = SCORE_GLYPH_SUFFIX[ch];
  if (suffix === undefined) return undefined;
  const hi = images.get(`${prefix}-${suffix}@2x.png`);
  const lo = images.get(`${prefix}-${suffix}.png`);
  if (hi === undefined) return lo;
  if (lo === undefined || targetPx === undefined) return hi;
  return targetPx > lo.height ? hi : lo;
}

// Per-frame digit widths would otherwise walk the skin image map every call.
const _glyphAspectCache = new WeakMap<SkinAssets, Map<string, Map<string, number>>>();

function glyphAspect(skin: SkinAssets | undefined, prefix: string, ch: string): number {
  if (skin === undefined) return 0.65;
  let byPrefix = _glyphAspectCache.get(skin);
  if (byPrefix === undefined) {
    byPrefix = new Map();
    _glyphAspectCache.set(skin, byPrefix);
  }
  let byChar = byPrefix.get(prefix);
  if (byChar === undefined) {
    byChar = new Map();
    byPrefix.set(prefix, byChar);
  }
  let aspect = byChar.get(ch);
  if (aspect === undefined) {
    const bmp = glyphImage(skin.images, prefix, ch);
    aspect = bmp !== undefined ? bmp.width / bmp.height : 0.65;
    byChar.set(ch, aspect);
  }
  return aspect;
}

// Width follows the skin image's aspect ratio; falls back to 0.65× for the monospace text path.
function drawScoreText(
  ctx: CanvasRenderingContext2D,
  text: string,
  rightX: number,
  y: number,
  digitH: number,
  prefix: string,
  skin?: SkinAssets
): void {
  let totalW = 0;
  for (let i = 0; i < text.length; i++) {
    totalW += glyphAspect(skin, prefix, text.charAt(i)) * digitH;
  }

  // Glyph height in device pixels = logical digitH × the canvas's current scale
  // (Renderer applies ctx.scale(total); combo pop adds a transient factor on top).
  // Drives the size-aware @2x/1× variant pick in glyphImage.
  const scale    = (typeof ctx.getTransform === 'function' ? ctx.getTransform().a : 1) || 1;
  const targetPx = digitH * scale;

  let x = rightX - totalW;

  for (let i = 0; i < text.length; i++) {
    const ch  = text.charAt(i);
    const w   = glyphAspect(skin, prefix, ch) * digitH;
    const bmp = skin ? glyphImage(skin.images, prefix, ch, targetPx) : undefined;

    if (bmp) {
      ctx.drawImage(bmp, x, y, w, digitH);
    } else {
      ctx.save();
      ctx.font         = `bold ${Math.round(digitH * 0.85)}px monospace`;
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      ctx.strokeStyle  = 'rgba(0,0,0,0.75)';
      ctx.lineWidth    = 2;
      ctx.strokeText(ch, x, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(ch, x, y);
      ctx.restore();
    }

    x += w;
  }
}

const MOD_ICON_SPEC_BY_ACRONYM = new Map(MOD_ICON_SPECS.map(spec => [spec.acronym, spec]));

const MOD_ICON_H   = 30;
const MOD_ICON_GAP = 2;
const MOD_Y        = ACC_Y + ACC_DIGIT_H + 6;

/** One slot of the HUD mod-icon row; `bitmap` undefined ⇒ labelled-pill fallback. */
export interface ModIconSlot {
  readonly acronym: string;
  readonly bitmap: ImageBitmap | undefined;
}

/**
 * Resolve the mod-icon row for a score once (per renderer). `acronyms` comes from
 * `activeModAcronyms`; `lazerMods` is the replay's lazer mod list (undefined for stable).
 * Per mod: a mod with extended info (custom rate, single-setting DA) always gets osu!'s
 * composed icon with the text extension, as lazer shows it; otherwise the skin's
 * `selection-mod-*` sprite wins, then osu!'s plain composed icon, then the text pill.
 */
export function buildModIconRow(
  acronyms: readonly string[],
  lazerMods: readonly LazerMod[] | undefined,
  skin: SkinAssets | undefined,
  textures: LazerModIconTextures | null,
): ModIconSlot[] {
  return acronyms.map(acronym => {
    const spec = MOD_ICON_SPEC_BY_ACRONYM.get(acronym);
    const lazerMod = lazerMods?.find(m => m.acronym === acronym);
    const extended = lazerMod !== undefined ? extendedModIconInfo(lazerMod) : '';
    let bitmap: ImageBitmap | undefined;
    if (spec !== undefined && textures !== null && extended !== '') {
      bitmap = composeModIcon(textures, spec, extended);
    }
    if (bitmap === undefined && spec?.stem !== undefined) {
      bitmap = skin?.images.get(`selection-mod-${spec.stem}@2x.png`) ?? skin?.images.get(`selection-mod-${spec.stem}.png`);
    }
    if (bitmap === undefined && spec !== undefined && textures !== null) {
      bitmap = composeModIcon(textures, spec);
    }
    return { acronym, bitmap };
  });
}

/**
 * Draw the active-mod icon row under the accuracy readout (top-right), from a row resolved
 * by `buildModIconRow`.
 */
export function drawModIcons(ctx: CanvasRenderingContext2D, row: readonly ModIconSlot[]): void {
  if (row.length === 0) return;

  const widths = row.map(({ bitmap }) =>
    bitmap ? (bitmap.width / bitmap.height) * MOD_ICON_H : MOD_ICON_H * 1.6);
  const totalW = widths.reduce((s, w) => s + w, 0) + MOD_ICON_GAP * (row.length - 1);

  let x = ACC_RIGHT_X - totalW;
  for (let i = 0; i < row.length; i++) {
    const { acronym, bitmap } = row[i]!;
    const w = widths[i]!;

    if (bitmap) {
      ctx.drawImage(bitmap, x, MOD_Y, w, MOD_ICON_H);
    } else {
      ctx.save();
      ctx.beginPath();
      const r = 4;
      ctx.moveTo(x + r, MOD_Y);
      ctx.arcTo(x + w, MOD_Y, x + w, MOD_Y + MOD_ICON_H, r);
      ctx.arcTo(x + w, MOD_Y + MOD_ICON_H, x, MOD_Y + MOD_ICON_H, r);
      ctx.arcTo(x, MOD_Y + MOD_ICON_H, x, MOD_Y, r);
      ctx.arcTo(x, MOD_Y, x + w, MOD_Y, r);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill();
      ctx.font = `bold ${Math.round(MOD_ICON_H * 0.55)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(acronym, x + w / 2, MOD_Y + MOD_ICON_H / 2);
      ctx.restore();
    }

    x += w + MOD_ICON_GAP;
  }
}

/** Draw the 8-digit zero-padded score (top-right) for the latest frame at or before `timeMs`. */
export function drawScore(
  ctx: CanvasRenderingContext2D,
  scoreFrames: readonly ScoreFrame[],
  timeMs: number,
  skin?: SkinAssets,
): void {
  const i     = findBefore(scoreFrames, timeMs);
  const score = i >= 0 ? scoreFrames[i]!.score : 0;

  const text = String(Math.max(0, Math.trunc(score))).padStart(SCORE_DIGITS, '0');
  drawScoreText(ctx, text, SCORE_RIGHT_X, SCORE_Y, SCORE_DIGIT_H, skin?.config.scorePrefix ?? 'score', skin);
}

/** Draw the accuracy percentage readout (top-right, below the score); 100.00% before any hit. */
export function drawHUD(
  ctx: CanvasRenderingContext2D,
  accFrames: readonly AccFrame[],
  timeMs: number,
  skin?: SkinAssets
): void {
  const i   = findBefore(accFrames, timeMs);
  const acc = i >= 0 ? accFrames[i]!.acc : 1;

  const text = (acc * 100).toFixed(2) + '%';
  drawScoreText(ctx, text, ACC_RIGHT_X, ACC_Y, ACC_DIGIT_H, skin?.config.scorePrefix ?? 'score', skin);
}

const MANIA_COMBO_DIGIT_H = 28;

// Shared pop-animated combo renderer. `anchor(totalW)` returns, from the measured text
// width: `rightX`/`topY` for drawScoreText and `cx`/`cy` for the pop-scale pivot.
function drawPopCombo(
  ctx: CanvasRenderingContext2D,
  comboFrames: readonly ComboFrame[],
  timeMs: number,
  suffix: string,
  digitH: number,
  skin: SkinAssets | undefined,
  anchor: (totalW: number) => { rightX: number; topY: number; cx: number; cy: number },
): void {
  const i     = findBefore(comboFrames, timeMs);
  const combo = i >= 0 ? comboFrames[i]!.combo : 0;
  if (combo === 0) return;

  const text        = String(combo) + suffix;
  const elapsed     = i >= 0 ? timeMs - comboFrames[i]!.time : COMBO_ANIM_MS;
  const comboPrefix = skin?.config.comboPrefix ?? 'score';

  let totalW = 0;
  for (let k = 0; k < text.length; k++) {
    totalW += glyphAspect(skin, comboPrefix, text.charAt(k)) * digitH;
  }
  const popScale = elapsed < COMBO_ANIM_MS ? 1 + 0.4 * (1 - elapsed / COMBO_ANIM_MS) : 1.0;
  const { rightX, topY, cx, cy } = anchor(totalW);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(popScale, popScale);
  ctx.translate(-cx, -cy);
  drawScoreText(ctx, text, rightX, topY, digitH, comboPrefix, skin);
  ctx.restore();
}

/** Draw the std/taiko combo counter ("Nx") bottom-left, with a pop animation on change.
 * Hidden while combo is 0. */
export function drawCombo(
  ctx: CanvasRenderingContext2D,
  comboFrames: readonly ComboFrame[],
  timeMs: number,
  skin?: SkinAssets
): void {
  drawPopCombo(ctx, comboFrames, timeMs, 'x', COMBO_DIGIT_H, skin, (totalW) => ({
    rightX: COMBO_LEFT_X + 4 + totalW,
    topY:   COMBO_Y,
    cx:     COMBO_LEFT_X + 4 + totalW / 2,
    cy:     COMBO_Y + COMBO_DIGIT_H / 2,
  }));
}

/**
 * Mania combo: centered on (centerX, centerY) with no `x` suffix, scaled bitmap glyphs,
 * pop animation on each change. Caller (mania ruleset) picks position from the stage
 * layout + skin's `ComboPosition`.
 */
export function drawManiaCombo(
  ctx: CanvasRenderingContext2D,
  comboFrames: readonly ComboFrame[],
  timeMs: number,
  centerX: number,
  centerY: number,
  skin?: SkinAssets,
): void {
  drawPopCombo(ctx, comboFrames, timeMs, '', MANIA_COMBO_DIGIT_H, skin, (totalW) => ({
    rightX: centerX + totalW / 2,
    topY:   centerY - MANIA_COMBO_DIGIT_H / 2,
    cx:     centerX,
    cy:     centerY,
  }));
}
