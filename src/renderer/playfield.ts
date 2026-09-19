/**
 * osu!standard playfield placement on a logical 1280×720 16:9 canvas
 */

export const PLAYFIELD_W = 512;
export const PLAYFIELD_H = 384;
export const CANVAS_W = 1280;
export const CANVAS_H = 720;

/** Canvas px per osu px: `CANVAS_H × 0.8 / PLAYFIELD_H`. */
export const SCALE = (CANVAS_H * 0.8) / PLAYFIELD_H;
/** Horizontal centring. */
export const OFFSET_X = (CANVAS_W - PLAYFIELD_W * SCALE) / 2;
/** Vertical centring plus osu!'s 8-unit storyboard-alignment shift. */
export const OFFSET_Y = (CANVAS_H - PLAYFIELD_H * SCALE) / 2 + 8 * SCALE;
