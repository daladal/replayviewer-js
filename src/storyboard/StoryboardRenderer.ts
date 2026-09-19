/**
 * Draws a compiled storyboard's sprite layers for the renderer. Sprites are evaluated on the
 * CPU each frame and then drawn either through the WebGL2 batcher ({@link StoryboardGL} —
 * the normal path: a layer pass is a few draw calls whatever the sprite count) or, when WebGL2
 * is unavailable or the context was lost, one `drawImage` per sprite on the host's 2D context.
 * Both paths share the evaluation, culling and geometry; everything is `OffscreenCanvas` /
 * `ImageBitmap` + pure math, so it runs unchanged inside a worker.
 *
 * Per sprite the geometry reproduces osu!framework's `DrawInfo.ApplyTransform` order —
 * translate to the position, rotate, scale (flips and vector scale fold into the scale's sign),
 * then translate by the (flip-adjusted) origin — with the storyboard-space → canvas mapping
 * from `coords.ts`.
 */

import type { StoryboardData } from './types.js';
import type { StoryboardImage } from './StoryboardAssets.js';
import { resolveStoryboardPath, animationFramePath, normaliseStoryboardPath } from './StoryboardAssets.js';
import { compileStoryboard, type CompiledStoryboard, type CompiledSprite, type CompiledAnimation, type CompiledLayer, type CompiledVideo } from './StoryboardCompiler.js';
import { NO_TRIGGER_EVENTS, type TriggerEvents } from './triggers.js';
import { spriteStateInto, newSpriteState, animationFrameIndex, videoAlphaAt, type SpriteState } from './evaluate.js';
import { SB_SCALE, CANVAS_W, CANVAS_H, toCanvasX, toCanvasY, originAnchor, layerMaskRect } from './coords.js';
import { StoryboardGL, type AtlasEntry } from './StoryboardGL.js';
import type { VideoFrameSource } from './VideoFrameSource.js';

/** What a renderer needs to draw a storyboard: the parsed model plus its decoded images. */
export interface StoryboardRenderInputs {
  data: StoryboardData;
  /** Keyed by resolved archive path (see `decodeStoryboardImages`). */
  images: Map<string, StoryboardImage>;
  /**
   * The beatmap video, decoded by `source`, for the `Video` event(s) naming `path` (the
   * resolved archive path). Null or absent draws no video. Not structured-clonable: export
   * bundles carry the storyboard without it.
   */
  video?: { path: string; source: VideoFrameSource } | null;
}

/** The host canvas's backing store, so the GL buffer matches it pixel for pixel. */
export interface StoryboardSurface {
  width: number;
  height: number;
  /** Backing px per logical px (the host context's base scale). */
  quality: number;
}

/** Bytes of tinted offscreens kept per renderer before the least recently used are dropped (2D path). */
const TINT_CACHE_BYTES = 64 * 1024 * 1024;
/**
 * Images up to this many pixels get 16 tint levels per channel instead of 256 on the 2D path.
 * Particle-style storyboards tween thousands of small sprites through individual colours every
 * frame; at 8 bits nearly every one is a new cache key (and a new offscreen) per frame, while 16
 * levels on a sprite a few dozen pixels wide are indistinguishable and turn the churn into cache
 * hits. Large sprites keep 8 bits so slow full-screen tint fades do not band.
 */
const SMALL_TINT_PX = 128 * 128;

/** Pre-tinted copies of images, keyed by (image, quantised colour); LRU by bytes. */
class TintCache {
  private readonly entries = new Map<string, { canvas: OffscreenCanvas; bytes: number }>();
  private readonly ids = new Map<ImageBitmap, number>();
  private bytes = 0;

  get(img: ImageBitmap, r: number, g: number, b: number): CanvasImageSource {
    let R: number, G: number, B: number;
    if (img.width * img.height <= SMALL_TINT_PX) {
      // 4 bits per channel; 15 → 255 keeps white exact.
      R = Math.round(r * 15) * 17; G = Math.round(g * 15) * 17; B = Math.round(b * 15) * 17;
    } else {
      R = Math.round(r * 255); G = Math.round(g * 255); B = Math.round(b * 255);
    }
    if (R >= 255 && G >= 255 && B >= 255) return img;
    let id = this.ids.get(img);
    if (id === undefined) { id = this.ids.size; this.ids.set(img, id); }
    const key = `${id}:${R}:${G}:${B}`;
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.canvas;
    }
    const w = img.width, h = img.height;
    const canvas = new OffscreenCanvas(w, h);
    const c = canvas.getContext('2d');
    if (c === null) return img;
    c.drawImage(img, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = `rgb(${R},${G},${B})`;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(img, 0, 0);
    const bytes = w * h * 4;
    this.entries.set(key, { canvas, bytes });
    this.bytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.bytes <= TINT_CACHE_BYTES) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
    return canvas;
  }
}

interface SpriteFrames {
  /** Decoded image per frame (one for sprites); null = missing file. */
  images: (StoryboardImage | null)[];
  /** Atlas entry per frame when the GL path is available. */
  atlas: (AtlasEntry | null)[];
}

export class StoryboardRenderer {
  readonly compiled: CompiledStoryboard;
  private readonly frames = new Map<CompiledSprite, SpriteFrames>();
  private tints: TintCache | null = null;
  private gl: StoryboardGL | null;
  private readonly quality: number;
  private readonly state: SpriteState = newSpriteState();
  private readonly corners = new Float32Array(8);
  private readonly mask: { x: number; y: number; w: number; h: number } | null;
  /** Layers drawn under the gameplay (everything but Overlay), back to front. */
  private readonly underlay: CompiledLayer[];
  private readonly overlay: CompiledLayer | null;
  /** The `Video` events the attached source plays (usually one), with the source. */
  private readonly videos: CompiledVideo[];
  private readonly videoSource: VideoFrameSource | null;

  /** `triggerEvents`: the replay's gameplay events trigger groups fire on (none = triggers never fire). */
  constructor(inputs: StoryboardRenderInputs, surface: StoryboardSurface, triggerEvents: TriggerEvents = NO_TRIGGER_EVENTS) {
    this.compiled = compileStoryboard(inputs.data, triggerEvents);
    this.mask = layerMaskRect(this.compiled.widescreen);
    this.quality = surface.quality;
    // A video-only storyboard has nothing for the batcher; skip the GL context.
    this.gl = this.compiled.hasSprites ? StoryboardGL.create(inputs.images, surface.width, surface.height) : null;
    for (const layer of this.compiled.layers) {
      for (const s of layer.sprites) {
        const paths = s.kind === 'animation'
          ? Array.from({ length: (s as CompiledAnimation).frameCount }, (_, i) => animationFramePath(s.path, i))
          : [s.path];
        const keys = paths.map(p => resolveStoryboardPath(inputs.images, p, 'image'));
        this.frames.set(s, {
          images: keys.map(k => k === null ? null : inputs.images.get(k) ?? null),
          atlas: keys.map(k => k === null ? null : this.gl?.entry(k) ?? null),
        });
      }
    }
    this.underlay = this.compiled.layers.filter(l => l.name !== 'Overlay');
    // Null when empty: the Overlay pass then costs nothing, which is the case on nearly every map.
    this.overlay = this.compiled.layers.find(l => l.name === 'Overlay' && l.sprites.length > 0) ?? null;
    const video = inputs.video ?? null;
    this.videos = video === null
      ? []
      : this.compiled.videos.filter(v => normaliseStoryboardPath(v.path) === normaliseStoryboardPath(video.path));
    this.videoSource = this.videos.length > 0 ? video!.source : null;
  }

  /** Whether any layer has a sprite to draw (a storyboard may carry only a video). */
  get hasSprites(): boolean { return this.compiled.hasSprites; }

  /** Whether a video source is attached to a `Video` event of this storyboard. */
  get hasVideo(): boolean { return this.videoSource !== null; }

  /** The beatmap background is blacked out under a storyboard that draws it itself. */
  get replacesBackground(): boolean { return this.compiled.replacesBackground; }

  /** Overlay-layer sprites or samples keep the storyboard present even at full dim. */
  get mustAlwaysBePresent(): boolean { return this.compiled.mustAlwaysBePresent; }

  /** True while sprites go through the WebGL batcher (false = 2D per-sprite fallback). */
  get usesWebGL(): boolean { return this.gl !== null; }

  /**
   * Keep the video source in step with the map clock; call once per drawn frame whether or not
   * the video is drawn, so a hidden video is paused and a shown one is already near its frame.
   * `rate` is playback speed relative to real time (mod speed × user rate).
   */
  syncVideo(t: number, playing: boolean, rate: number): void {
    const src = this.videoSource;
    if (src === null) return;
    const v = this.videos[0]!;
    src.sync({ videoMs: t - v.offsetMs, playing, rate });
  }

  /** Decode the video frame for map time `t` ahead of `drawVideo` (sources that support `prepare`). */
  async prepareVideo(t: number): Promise<void> {
    const src = this.videoSource;
    if (src === null || src.prepare === undefined) return;
    await src.prepare(t - this.videos[0]!.offsetMs);
  }

  /**
   * Draw the video frame(s) for map time `t`: cover-fit into the storyboard box (the full
   * canvas for a widescreen storyboard, the centred 4:3 box otherwise), unmasked, with the
   * fade-in/out and the video's own alpha commands.
   */
  drawVideo(ctx: CanvasRenderingContext2D, t: number): void {
    const src = this.videoSource;
    if (src === null || src.frameWidth === 0 || src.frameHeight === 0) return;
    const box = this.compiled.widescreen || !this.compiled.hasSprites ? null : this.mask;
    const bx = box === null ? 0 : box.x, by = box === null ? 0 : box.y;
    const bw = box === null ? CANVAS_W : box.w, bh = box === null ? CANVAS_H : box.h;
    for (const v of this.videos) {
      const a = videoAlphaAt(v, t, src.durationMs);
      if (a <= 0.0001) continue;
      const frame = src.frameAt(t - v.offsetMs);
      if (frame === null) continue;
      const s = Math.max(bw / src.frameWidth, bh / src.frameHeight);
      const dw = src.frameWidth * s, dh = src.frameHeight * s;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.drawImage(frame, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
      ctx.restore();
    }
  }

  /** Draw every non-Overlay layer visible at `t` (Pass or Fail by the passing state), back to front. */
  drawUnderlay(ctx: CanvasRenderingContext2D, t: number): void {
    const passing = this.compiled.passingAt(t);
    this.drawLayers(ctx, t, this.underlay.filter(l => passing ? l.visibleWhenPassing : l.visibleWhenFailing), 1);
  }

  /**
   * Draw the Overlay layer, which sits above the gameplay but inside lazer's dimmable container:
   * `dimMul` (= 1 − dim) is folded into each sprite's tint.
   */
  drawOverlay(ctx: CanvasRenderingContext2D, t: number, dimMul: number): void {
    if (this.overlay === null) return;
    this.drawLayers(ctx, t, [this.overlay], dimMul);
  }

  /** Release GPU resources. The renderer is unusable afterwards. */
  dispose(): void {
    this.gl?.dispose();
    this.gl = null;
    this.tints = null;
  }

  private drawLayers(ctx: CanvasRenderingContext2D, t: number, layers: readonly CompiledLayer[], dimMul: number): void {
    if (this.gl !== null && this.gl.unusable) this.gl = null;
    if (this.gl !== null) this.drawLayersGL(ctx, this.gl, t, layers, dimMul);
    else this.drawLayers2D(ctx, t, layers, dimMul);
  }

  /** Frame image index for `s` at `t`, or -1 when it has none to draw. */
  private frameIndex(s: CompiledSprite, t: number): number {
    return s.kind === 'animation' ? animationFrameIndex(s as CompiledAnimation, t) : 0;
  }

  private drawLayersGL(ctx: CanvasRenderingContext2D, gl: StoryboardGL, t: number, layers: readonly CompiledLayer[], dimMul: number): void {
    const st = this.state, c = this.corners;
    let drawn = 0;
    gl.begin(this.mask, this.quality);
    for (const layer of layers) {
      for (const s of layer.activeAt(t)) {
        if (!spriteStateInto(s, t, st)) continue;
        const f = this.frames.get(s);
        if (f === undefined) continue;
        const i = this.frameIndex(s, t);
        const img = f.images[i], e = f.atlas[i];
        if (img === null || img === undefined || e === null || e === undefined) continue;
        if (!this.spriteCorners(st, s, img, c)) continue;
        const a = st.alpha;
        gl.quad(e, c, st.r * dimMul * a, st.g * dimMul * a, st.b * dimMul * a, st.additive ? 0 : a);
        drawn++;
      }
    }
    gl.end();
    if (drawn === 0) return;
    // 1:1 composite of the premultiplied buffer under the host's base transform.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(gl.canvas, 0, 0);
    ctx.restore();
  }

  private drawLayers2D(ctx: CanvasRenderingContext2D, t: number, layers: readonly CompiledLayer[], dimMul: number): void {
    // One save/restore around the whole pass (the clip lives in the saved state). Per sprite the
    // transform is set absolutely against the context's base matrix and alpha/blend are written
    // only when they change — thousands of save/restore pairs per frame are what this avoids.
    if (this.tints === null) this.tints = new TintCache();
    ctx.save();
    if (this.mask !== null) {
      ctx.beginPath();
      ctx.rect(this.mask.x, this.mask.y, this.mask.w, this.mask.h);
      ctx.clip();
    }
    const base = ctx.getTransform();
    const st = this.state, c = this.corners;
    let alpha = 1, additive = false;
    for (const layer of layers) {
      for (const s of layer.activeAt(t)) {
        if (!spriteStateInto(s, t, st)) continue;
        const f = this.frames.get(s);
        if (f === undefined) continue;
        const img = f.images[this.frameIndex(s, t)];
        if (img === null || img === undefined) continue;
        if (!this.spriteCorners(st, s, img, c)) continue;
        if (st.alpha !== alpha) { alpha = st.alpha; ctx.globalAlpha = alpha; }
        if (st.additive !== additive) { additive = st.additive; ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over'; }
        // Map the unit texture box onto the corners: base × [TL, (TR−TL)/w, (BL−TL)/h].
        const w = img.width, h = img.height;
        const la = (c[2]! - c[0]!) / w, lb = (c[3]! - c[1]!) / w, lc = (c[4]! - c[0]!) / h, ld = (c[5]! - c[1]!) / h;
        ctx.setTransform(
          base.a * la + base.c * lb, base.b * la + base.d * lb,
          base.a * lc + base.c * ld, base.b * lc + base.d * ld,
          base.a * c[0]! + base.c * c[1]! + base.e, base.b * c[0]! + base.d * c[1]! + base.f,
        );
        ctx.drawImage(this.tints.get(img.bitmap, st.r * dimMul, st.g * dimMul, st.b * dimMul), 0, 0, w, h);
      }
    }
    ctx.restore();
  }

  /**
   * Canvas-px corners of the sprite's texture box (top-left, top-right, bottom-left,
   * bottom-right) into `out`; false when the box misses the canvas / mask or the sprite has a
   * zero scale (lazer draws nothing either, and a singular matrix would be useless anyway).
   */
  private spriteCorners(st: SpriteState, s: CompiledSprite, img: StoryboardImage, out: Float32Array): boolean {
    // Texture size in storyboard units is the file's native size (1 texel = 1 unit; the
    // storyboard texture store uses no @2x scaling), even when the bitmap was downsized on decode.
    const w = img.width, h = img.height;
    // `DrawScale`: flips negate the scale; `AdjustOrigin` swaps the origin when a flip and a
    // negative vector scale don't cancel, so the sprite mirrors in place.
    const sx = st.scale * (st.flipH ? -1 : 1) * st.vsx;
    const sy = st.scale * (st.flipV ? -1 : 1) * st.vsy;
    if (sx === 0 || sy === 0) return false;
    const [ax, ay] = originAnchor(s.origin, st.flipH !== (st.vsx < 0), st.flipV !== (st.vsy < 0));
    const ox = ax * w, oy = ay * h;
    const cx = toCanvasX(st.x), cy = toCanvasY(st.y);
    const kx = SB_SCALE * sx, ky = SB_SCALE * sy;
    const cos = Math.cos(st.rotation), sin = Math.sin(st.rotation);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
      const lx = (((i & 1) ? w : 0) - ox) * kx;
      const ly = (((i & 2) ? h : 0) - oy) * ky;
      const px = cx + lx * cos - ly * sin;
      const py = cy + lx * sin + ly * cos;
      out[i * 2] = px; out[i * 2 + 1] = py;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const m = this.mask;
    const left = m === null ? 0 : m.x, top = m === null ? 0 : m.y;
    const right = m === null ? CANVAS_W : m.x + m.w, bottom = m === null ? CANVAS_H : m.y + m.h;
    return maxX > left && minX < right && maxY > top && minY < bottom;
  }
}
