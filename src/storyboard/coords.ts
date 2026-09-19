/**
 * Storyboard coordinate space on the logical 1280×720 canvas.
 *
 * lazer's `DrawableStoryboard` is a 480-unit-tall box scaled to the window height and centred,
 * with sprites positioned inside a 640×480 element box centred in it. At a 720 px window height
 * that is 1.5 canvas px per storyboard unit and a 160 px left margin, for widescreen and 4:3
 * storyboards alike — the aspect only changes the mask (`DrawableStoryboardLayer.Masking`):
 * a 4:3 storyboard never draws outside `0…640`, a widescreen one extends to `−106.67…746.67`,
 * which is exactly the full canvas width. osu!'s playfield sits at storyboard `(64, 56)…(576, 440)`,
 * the same place the std renderer puts it, so note-anchored sprites line up.
 */

import type { StoryboardOrigin } from './types.js';

export const SB_WIDTH = 640;
export const SB_HEIGHT = 480;
export const CANVAS_W = 1280;
export const CANVAS_H = 720;

/** Canvas px per storyboard unit. */
export const SB_SCALE = CANVAS_H / SB_HEIGHT;
/** The 640-wide element box is centred on the canvas. */
export const SB_OFFSET_X = (CANVAS_W - SB_WIDTH * SB_SCALE) / 2;
export const SB_OFFSET_Y = 0;

/** Storyboard units → canvas px. */
export function toCanvasX(x: number): number { return SB_OFFSET_X + x * SB_SCALE; }
export function toCanvasY(y: number): number { return SB_OFFSET_Y + y * SB_SCALE; }

/** Canvas-px clip rectangle for a non-video layer; null when nothing needs clipping (widescreen). */
export function layerMaskRect(widescreen: boolean): { x: number; y: number; w: number; h: number } | null {
  if (widescreen) return null;
  return { x: SB_OFFSET_X, y: SB_OFFSET_Y, w: SB_WIDTH * SB_SCALE, h: SB_HEIGHT * SB_SCALE };
}

/**
 * Origin as anchor fractions of the texture box (`osu.Framework` `Anchor` x0/x1/x2 × y0/y1/y2):
 * the point of the sprite's own rectangle placed at `(x, y)`, about which scale, vector scale,
 * rotation and flips act.
 */
const ORIGIN_ANCHOR: Record<StoryboardOrigin, readonly [number, number]> = {
  TopLeft:      [0,   0],
  Centre:       [0.5, 0.5],
  CentreLeft:   [0,   0.5],
  TopRight:     [1,   0],
  BottomCentre: [0.5, 1],
  TopCentre:    [0.5, 0],
  CentreRight:  [1,   0.5],
  BottomLeft:   [0,   1],
  BottomRight:  [1,   1],
};

/**
 * Anchor fractions after `StoryboardExtensions.AdjustOrigin`: a horizontal flip (or a negative
 * vector-scale x — the two cancel, hence the XOR in the caller) swaps x0 ↔ x2, and likewise for
 * y, so a flipped sprite mirrors in place instead of jumping to the other side of its origin.
 */
export function originAnchor(origin: StoryboardOrigin, flipX: boolean, flipY: boolean): [number, number] {
  const [ax, ay] = ORIGIN_ANCHOR[origin];
  return [flipX ? 1 - ax : ax, flipY ? 1 - ay : ay];
}
