import type { BeatmapData, ReplayData, HitResult, HitSample } from '../types/index';
import type { SkinAssets } from '../types/index';
import type { ManiaSession } from '../rulesets/mania/index';
import type { TaikoSession } from '../rulesets/taiko/types';
import type { TaikoInputEvent } from '../rulesets/taiko/input';
import type { ModDifficulty } from '../utils/modDifficulty';
import { activeModAcronyms, type LazerModIconTextures } from '../utils/modIcons';
import { Player } from '../player/Player';
import { TimeMapper } from '../player/TimeMapper';
import { drawHUD, type AccFrame,
         drawCombo, type ComboFrame,
         drawModIcons, drawScore, buildModIconRow, type ModIconSlot } from './HUDRenderer';
import type { ScoreFrame } from '../utils/scoreProcessor';
import { drawURBar, type URTimeline } from './URBarRenderer';
import type { Ruleset } from '../rulesets/Ruleset';
import { stdRuleset } from '../rulesets/std/index';
import { taikoRuleset } from '../rulesets/taiko/index';
import { maniaRuleset } from '../rulesets/mania/index';
import { catchRuleset } from '../rulesets/catch/index';
import { StoryboardRenderer, type StoryboardRenderInputs } from '../storyboard/StoryboardRenderer';
import { hasTriggerCommands, playableStoryboardSamples } from '../storyboard/StoryboardCompiler';
import { hitSampleEventsFromSchedule, type TriggerEvents } from '../storyboard/triggers';
import { computeHitsoundSchedule } from '../player/hitsoundSchedule';

/**
 * Live-mutable draw settings owned by a {@link Renderer} (exposed as `renderer.options`).
 * Mutating fields takes effect on the next drawn frame; no rebuild is needed.
 */
export interface RenderOptions {
  showJudgement:    boolean;
  showKeyOverlay:   boolean;
  showFollowpoints: boolean;
  showURBar:        boolean;
  showModIcons:     boolean;
  /** Draw the beatmap's storyboard sprites (no effect when the renderer was built without any). */
  showStoryboard:   boolean;
  /** Draw the beatmap video (no effect when the renderer was built without a video source). */
  showVideo:        boolean;
  /**
   * The host's user playback-rate multiplier (the one given to `AudioSync.setUserRate`), which
   * only the beatmap video needs: its decoder runs its own clock and must be told the speed.
   */
  userRate:         number;
  /**
   * Arbitrary host-supplied HUD overlay, drawn after the built-in HUD each frame
   * (ctx is in logical 1280×720 coords; timeMs is beatmap time). Not structured-clonable —
   * senders shipping RenderOptions across a worker boundary must strip it (see
   * {@link ExportRenderBundle}).
   */
  hudOverlay?: (ctx: CanvasRenderingContext2D, timeMs: number) => void;
  /** Background darken amount, 0 (none) .. 1 (black). */
  backgroundDim:  number;
  // Renderer-only offset (ms); does not affect the audio clock or hitsound schedule.
  audioOffsetMs: number;
  // Backing-store multiplier; 'auto' resolves to clamp(dpr × zoom, 1, MAX_QUALITY) at construction.
  qualityScale: 'auto' | 1 | 1.5 | 2 | 3;
  // mania scroll-speed (1..40); timeRange = 11485 / maniaScrollSpeed (ms). 
  maniaScrollSpeed: number;
  // mania-only: flip the playfield.
  maniaUpscroll: boolean;
  // taiko-only: flying-hit animation (hit notes and drum-roll ticks arcing off the playfield).
  taikoFlyingHits: boolean;
  // Visual-mod toggles
  modHidden:     boolean;
  modFlashlight: boolean;
  modFadeIn:     boolean;
  modCover:      boolean;
}

const LOGICAL_W = 1280;
const LOGICAL_H = 720;

/**
 * Everything needed to rebuild this renderer in another JS context (e.g. an offline export
 * worker): plain data + structured-clonable assets only. The sender must strip `skin.sounds`
 * (AudioBuffers can't cross a worker boundary; the draw/build path never reads them) and
 * `options.hudOverlay` (functions aren't clonable; the receiver re-wires its own).
 * Produced by `exportBundle()`, consumed by `Renderer.buildForExport`.
 */
export interface ExportRenderBundle {
  replay: ReplayData;
  beatmap: BeatmapData;
  skin: SkinAssets;
  background: ImageBitmap | null;
  modDiff: ModDifficulty;
  options: RenderOptions;
  presentationDurationMs: number;
  introOffsetMs: number;
  outroOffsetMs: number;
  speed: number;
  lazerModIcons: LazerModIconTextures | null;
  /** The storyboard the live renderer was built with (its `ImageBitmap`s clone), or null. `video` is null: the live source is bound to the live clock — the receiver attaches its own before `buildForExport`. */
  storyboard: StoryboardRenderInputs | null;
}

// Cap on the backing-store supersample factor. dpr × zoom on a HiDPI display
// docked to a wide monitor can reach 3; beyond that the cost (≈total²) isn't
// worth it and skin @2x assets stop carrying more detail.
const MAX_QUALITY = 3;

/**
 * Top-level frame renderer. Owns the canvas (logical 1280×720, supersampled backing store),
 * builds the ruleset session (picked by `replay.mode`) in its constructor, and draws the
 * backdrop, gameplay, HUD, mod icons, and UR bar each frame. Drive it either live via
 * `start()`/`stop()` (rAF + player clock) or explicitly via `renderFrameAt(mapTimeMs)`.
 */
export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  // Type-erased; (ruleset, session) pair is built together in the constructor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _ruleset: Ruleset<any>;
  private readonly _session: unknown;
  private readonly _hitResults: readonly HitResult[];
  private readonly _accFrames: readonly AccFrame[];
  private readonly _comboFrames: readonly ComboFrame[];
  private readonly _scoreFrames: readonly ScoreFrame[];
  private readonly _urTimeline: URTimeline;
  private _rafId: number | null = null;
  private _running = false;

  readonly options: RenderOptions = {
    showJudgement:    true,
    showKeyOverlay:   true,
    showFollowpoints: true,
    showURBar:        true,
    showModIcons:     true,
    showStoryboard:   true,
    showVideo:        true,
    userRate:         1,
    backgroundDim:    0.80,
    audioOffsetMs:    0,
    qualityScale:     'auto',
    maniaScrollSpeed: 20,
    maniaUpscroll:    false,
    taikoFlyingHits:  true,
    modHidden:        false,
    modFlashlight:    false,
    modFadeIn:        false,
    modCover:         false,
  };

  private readonly _qualityTotal: number;
  // HUD mod-icon row, resolved once (lazer acronym list, else the stable bitmask).
  private readonly _modIconRow: readonly ModIconSlot[];

  private readonly _bgDrawX: number = 0;
  private readonly _bgDrawY: number = 0;
  private readonly _bgDrawW: number = 0;
  private readonly _bgDrawH: number = 0;

  // Pre-v5 .osu maps run visuals 24ms behind audio (stable/danser quirk); AudioSync mirrors this.
  private readonly _oldOffsetMs: number;

  // Background + dim pre-composited at backing resolution, so each frame pays one 1:1 blit
  // instead of a full-canvas clear + filtered scale-blit + dim fill. Rebuilt only when the
  // dim changes (the live dim slider); null until first use / when there is no background.
  private _backdrop: OffscreenCanvas | null = null;
  private _backdropDim = -1;

  // Storyboard sprite layers, or null when the session has no storyboard.
  private readonly _storyboard: StoryboardRenderer | null;
  // The storyboard inputs as given, kept so export clones/bundles rebuild the same layers.
  private readonly _storyboardInputs: StoryboardRenderInputs | null;

  constructor(
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
    private readonly player: Player,
    private readonly replay: ReplayData,
    private readonly beatmap: BeatmapData,
    private readonly skin: SkinAssets,
    private readonly timeMapper: TimeMapper,
    private readonly _background: ImageBitmap | null = null,
    private readonly modDiff: ModDifficulty,
    // Explicit export supersample factor. When set, bypasses 'auto'/qualityScale AND the
    // MAX_QUALITY clamp (export wants q3=4K), and rounds the backing store to even pixel
    // dimensions so H.264 accepts it. Live playback never passes this.
    qualityOverride?: number,
    // On-screen zoom the host page applies to the canvas's CSS box; multiplies DPR in the
    // 'auto' quality decision so the backing store matches what the browser actually paints.
    // Export/clone paths (qualityOverride set) ignore it.
    pageZoom = 1,
    // osu!'s default mod-icon textures (`loadLazerDefaultModIcons`); the HUD composes them for
    // mods the skin has no `selection-mod-*` sprite for and for mods with a custom rate etc.
    private readonly lazerModIcons: LazerModIconTextures | null = null,
    // The beatmap's storyboard (parsed model + decoded images); null draws the plain backdrop.
    storyboard: StoryboardRenderInputs | null = null,
  ) {
    // OffscreenCanvas's 2D context is structurally compatible with the draw path; one cast.
    // alpha:false — every frame is fully painted (backdrop or solid fill covers the canvas),
    // so an opaque backing store is safe; it's cheaper to composite and cheaper for the
    // export's per-frame VideoFrame capture (the encoder discards alpha regardless).
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
    if (ctx === null) throw new Error('Failed to get 2D canvas context');
    this.ctx = ctx;
    this.options.modHidden     = modDiff.isHD;
    this.options.modFlashlight = modDiff.isFL;
    this.options.modFadeIn     = modDiff.isFadeIn;
    this.options.modCover      = modDiff.isCover;
    this._modIconRow = buildModIconRow(
      activeModAcronyms(modDiff.mods, replay.scoreInfo?.mods), replay.scoreInfo?.mods, skin, lazerModIcons,
    );
    // CSS box stays 1280×720; ctx.scale keeps draw code in logical coords.
    // 'auto' sizes the backing store to the canvas's actual on-screen device
    // pixels (dpr × page zoom), capped at MAX_QUALITY, so we render at display
    // resolution rather than upscaling a fixed 1280×720 buffer via CSS/zoom.
    const q = this.options.qualityScale;
    const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
    const total = qualityOverride !== undefined
      ? qualityOverride
      : q === 'auto'
        ? Math.max(1, Math.min(dpr * pageZoom, MAX_QUALITY))
        : q;
    if (qualityOverride !== undefined) {
      // H.264 requires even dimensions; round the backing store to the nearest even px.
      canvas.width  = 2 * Math.round((LOGICAL_W * total) / 2);
      canvas.height = 2 * Math.round((LOGICAL_H * total) / 2);
    } else {
      canvas.width  = LOGICAL_W * total;
      canvas.height = LOGICAL_H * total;
    }
    ctx.scale(total, total);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    this._qualityTotal = total;
    if (_background !== null) {
      const scale = Math.max(LOGICAL_W / _background.width, LOGICAL_H / _background.height);
      this._bgDrawW = _background.width * scale;
      this._bgDrawH = _background.height * scale;
      this._bgDrawX = (LOGICAL_W - this._bgDrawW) / 2;
      this._bgDrawY = (LOGICAL_H - this._bgDrawH) / 2;
    }
    // Keyed on replay.mode (not beatmap.mode): converts route through the replay's ruleset.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ruleset: Ruleset<any> =
        replay.mode === 3 ? maniaRuleset
      : replay.mode === 1 ? taikoRuleset
      : replay.mode === 2 ? catchRuleset
      : stdRuleset;
    this._ruleset    = ruleset;
    this._session    = ruleset.build(beatmap, replay, modDiff, skin, this._qualityTotal);
    this._hitResults  = ruleset.hitResults(this._session);
    this._accFrames   = ruleset.accFrames(this._session);
    this._comboFrames = ruleset.comboFrames(this._session);
    this._scoreFrames = ruleset.scoreFrames(this._session);
    this._urTimeline  = ruleset.urTimeline(this._session);
    // Seed upscroll from the skin's `UpsideDown` (user-flippable like the mod toggles).
    if (replay.mode === 3) {
      this.options.maniaUpscroll = (this._session as ManiaSession).defaultUpscroll;
    }
    this._oldOffsetMs = beatmap.formatVersion < 5 ? 24 : 0;
    this._storyboardInputs = storyboard;
    // Trigger-only sprites draw nothing in lazer but do in stable; they count as drawable here.
    const triggered = storyboard !== null && hasTriggerCommands(storyboard.data);
    this._storyboard = storyboard !== null && (storyboard.data.hasDrawable || triggered || storyboard.video != null)
      ? new StoryboardRenderer(storyboard, { width: canvas.width, height: canvas.height, quality: total },
          triggered ? this._storyboardTriggerEvents() : undefined)
      : null;
  }

  /**
   * Gameplay events storyboard triggers fire on: the replay's hit samples, from the same
   * schedule the audio plays (in draw time — the pre-v5 hitsound shift is not applied, since
   * `_draw` receives visual time). Pass/fail transitions are empty: the storyboard is always passing.
   */
  private _storyboardTriggerEvents(): TriggerEvents {
    const mode = (this.replay.mode === 1 ? 1 : this.replay.mode === 3 ? 3 : this.replay.mode === 2 ? 2 : 0) as 0 | 1 | 2 | 3;
    const sounds = computeHitsoundSchedule({
      mode, beatmap: this.beatmap, hitResults: this._hitResults,
      maniaSamples: this.maniaSamples, taikoGhostTaps: this.taikoGhostTaps, comboFrames: this._comboFrames,
      oldOffsetMs: 0, fromBeatmapMs: -Infinity,
    });
    return { hitSamples: hitSampleEventsFromSchedule(sounds), passing: [] };
  }

  /**
   * Whether the storyboard toggle has anything to act on: sprites attached here, or `Sample`
   * events the session's audio plays (`AudioSync.setStoryboardSamples`). False for a video-only map.
   */
  get hasStoryboard(): boolean {
    if (this._storyboard?.hasSprites) return true;
    return this._storyboardInputs !== null && playableStoryboardSamples(this._storyboardInputs.data).length > 0;
  }

  /** Whether a beatmap video is attached (`showVideo` has no effect otherwise). */
  get hasVideo(): boolean { return this._storyboard?.hasVideo ?? false; }

  /** Per-object judgement results computed by the ruleset at construction (map-time ms). */
  get hitResults(): readonly HitResult[] { return this._hitResults; }

  /** Displayed combo timeline (lazer/stable-correct per ruleset). AudioSync uses it to gate
   * the combo-break sound on osu!'s "combo was > 20 before the break" rule. */
  get comboFrames(): readonly ComboFrame[] { return this._comboFrames; }

  /** Mania-only: sourceIndex → HitSample lookup, so AudioSync can resolve per-press samples
   * for both Notes and HoldNote heads (holds aren't in beatmap.hitObjects). Null for std/taiko. */
  get maniaSamples(): ReadonlyMap<number, HitSample> | null {
    if (this.replay.mode !== 3) return null;
    return (this._session as ManiaSession).samplesBySource;
  }

  /** Taiko-only: presses that hit no object, so AudioSync can play a bare don/kat
   * for them on top of the note-tied hitsounds (empty-section / warm-up taps are
   * audible in stable). Null for std/mania. */
  get taikoGhostTaps(): readonly TaikoInputEvent[] | null {
    if (this.replay.mode !== 1) return null;
    return (this._session as TaikoSession).ghostTaps;
  }

  /** Score at the live player clock, using the same time math as the drawn HUD so
   * external displays stay in lockstep with the canvas. */
  currentScore(): number {
    const timeMs =
      this.timeMapper.toMapTime(this.player.currentTimeMs) +
      this.options.audioOffsetMs * this.timeMapper.speed -
      this._oldOffsetMs;
    return this.scoreAt(timeMs);
  }

  /**
   * Score at an explicit, already-offset beatmap time (ms). `currentScore` reads the live
   * player clock; callers that drive time explicitly (export clones have a dummy Player)
   * read scores through this with the same map time they draw each frame at.
   */
  scoreAt(mapTimeMs: number): number {
    const frames = this._scoreFrames;
    if (frames.length === 0 || mapTimeMs < frames[0]!.time) return 0;
    if (mapTimeMs >= frames[frames.length - 1]!.time) return frames[frames.length - 1]!.score;
    let lo = 0, hi = frames.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid]!.time <= mapTimeMs) lo = mid; else hi = mid - 1;
    }
    return frames[lo]!.score;
  }

  /** Pre-v5 visual lag (24ms / 0). Exposed so the export loop reproduces `_tick`'s time math. */
  get oldOffsetMs(): number { return this._oldOffsetMs; }

  /**
   * Render a single frame for an absolute beatmap time (ms). Public entry for offline
   * callers (e.g. an export loop) that drive time explicitly instead of via the player
   * clock + rAF. The caller is responsible for applying the same audioOffset/oldOffset
   * math `_tick` does.
   */
  renderFrameAt(mapTimeMs: number): void {
    this._draw(mapTimeMs);
  }

  /**
   * Build a second renderer over the same replay/beatmap/skin, drawing into an offscreen
   * canvas at an explicit export quality (bypasses the MAX_QUALITY clamp). Re-runs
   * ruleset.build sized to `quality` — same cost as a skin-swap rebuild — and copies the
   * current draw options so "what you see is what you export". The live renderer is untouched.
   * `video` attaches a frame source for the beatmap video (the live one is bound to this
   * renderer's clock and is not passed on); see `prepareFrameAt`.
   */
  cloneForExport(canvas: OffscreenCanvas, quality: number, video: StoryboardRenderInputs['video'] = null): Renderer {
    const clone = new Renderer(
      canvas,
      new Player(this.timeMapper.presentationDurationMs),
      this.replay, this.beatmap, this.skin, this.timeMapper, this._background, this.modDiff,
      quality, 1, this.lazerModIcons, this._storyboardForExport(video),
    );
    Object.assign(clone.options, this.options);
    return clone;
  }

  // The video source is a live decoder bound to this renderer's clock (and not clonable);
  // export renderers get the storyboard with the frame-exact source the caller supplies, or none.
  private _storyboardForExport(video: StoryboardRenderInputs['video'] = null): StoryboardRenderInputs | null {
    const sb = this._storyboardInputs;
    return sb === null ? null : { data: sb.data, images: sb.images, video };
  }

  /**
   * Snapshot everything `buildForExport` needs to rebuild this renderer in the export worker.
   * References, not copies — the caller structured-clones them across the worker boundary
   * (stripping skin sounds first) while the live session keeps its own.
   */
  exportBundle(): ExportRenderBundle {
    return {
      replay: this.replay,
      beatmap: this.beatmap,
      skin: this.skin,
      background: this._background,
      modDiff: this.modDiff,
      options: this.options,
      presentationDurationMs: this.timeMapper.presentationDurationMs,
      introOffsetMs: this.timeMapper.introOffsetMs,
      outroOffsetMs: this.timeMapper.outroOffsetMs,
      speed: this.timeMapper.speed,
      lazerModIcons: this.lazerModIcons,
      storyboard: this._storyboardForExport(),
    };
  }

  /**
   * The worker-side twin of `cloneForExport`: rebuild an export renderer from a transferred
   * bundle where no live renderer exists. Reconstructs the TimeMapper from the replay frames +
   * offsets (cheap, and faithful — same constructor inputs as the live one) and adopts the
   * bundle's options exactly as cloneForExport does.
   */
  static buildForExport(canvas: OffscreenCanvas, quality: number, b: ExportRenderBundle): Renderer {
    const timeMapper = new TimeMapper(b.replay.frames, b.introOffsetMs, b.outroOffsetMs, b.speed);
    const r = new Renderer(
      canvas,
      new Player(b.presentationDurationMs),
      b.replay, b.beatmap, b.skin, timeMapper, b.background, b.modDiff,
      quality, 1, b.lazerModIcons, b.storyboard,
    );
    Object.assign(r.options, b.options);
    return r;
  }

  /**
   * Export helper: decode the beatmap video's frame for `mapTimeMs` so the following
   * `renderFrameAt(mapTimeMs)` draws it (no-op without a video source that supports `prepare`).
   */
  prepareFrameAt(mapTimeMs: number): Promise<void> {
    return this._storyboard?.prepareVideo(mapTimeMs) ?? Promise.resolve();
  }

  /** Begin the live requestAnimationFrame loop (idempotent). */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._tick();
  }

  /** Halt the live loop and cancel any pending animation frame. */
  stop(): void {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** `stop()` plus release of GPU resources (the storyboard's WebGL context). Not reusable afterwards. */
  destroy(): void {
    this.stop();
    this._storyboard?.dispose();
  }

  private _tick = (): void => {
    if (!this._running) return;

    // audioOffsetMs is multiplied by speed because toMapTime returns beatmap-ms.
    const timeMs =
      this.timeMapper.toMapTime(this.player.currentTimeMs) +
      this.options.audioOffsetMs * this.timeMapper.speed -
      this._oldOffsetMs;
    this._draw(timeMs);

    this._rafId = requestAnimationFrame(this._tick);
  };

  // Lazily (re)build the pre-composited backdrop; only called when a background exists.
  private _ensureBackdrop(bg: ImageBitmap, dim: number): OffscreenCanvas {
    if (this._backdrop === null) {
      this._backdrop = new OffscreenCanvas(this.canvas.width, this.canvas.height);
    }
    if (dim !== this._backdropDim) {
      const octx = this._backdrop.getContext('2d');
      if (octx === null) throw new Error('Failed to get 2D backdrop context');
      octx.setTransform(this._qualityTotal, 0, 0, this._qualityTotal, 0, 0);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      // Opaque base first — a background PNG with alpha must not leave see-through pixels.
      octx.fillStyle = '#1a1a2e';
      octx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      octx.drawImage(bg, this._bgDrawX, this._bgDrawY, this._bgDrawW, this._bgDrawH);
      octx.fillStyle = `rgba(0, 0, 0, ${dim})`;
      octx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      this._backdropDim = dim;
    }
    return this._backdrop;
  }

  // 1:1 blit at backing resolution (identity transform): no per-frame filtering.
  private _blitBackdrop(backdrop: OffscreenCanvas): void {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(backdrop, 0, 0);
    ctx.restore();
  }

  private _draw(timeMs: number): void {
    const { ctx } = this;
    const { options } = this;
    const dim = Math.max(0, Math.min(1, options.backgroundDim));
    const sprites = options.showStoryboard && this._storyboard !== null && this._storyboard.hasSprites;
    const video = options.showVideo && this._storyboard !== null && this._storyboard.hasVideo;
    const sb = sprites || video ? this._storyboard : null;
    // The video decoder keeps its own clock: told every frame where ours is, even while hidden
    // (it then pauses at the right spot, so showing it again is instant).
    this._storyboard?.syncVideo(timeMs, video && this.player.isPlaying, this.timeMapper.speed * options.userRate);

    // The backdrop (or solid fill) covers the whole canvas opaquely — no clearRect needed.
    if (sb !== null) {
      // Storyboard layers sit between the background and the gameplay, and lazer dims both the
      // background and the storyboard by the same factor. Compositing is linear, so drawing
      // everything undimmed and darkening once before the gameplay is pixel-equivalent — and
      // the undimmed backdrop stays cached across dim-slider changes.
      if ((sprites && sb.replacesBackground) || this._background === null) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      } else {
        this._blitBackdrop(this._ensureBackdrop(this._background, 0));
      }
      // The video sits below every sprite layer, cover-fitted over the background.
      if (video && dim < 1) sb.drawVideo(ctx, timeMs);
      if (sprites && (dim < 1 || sb.mustAlwaysBePresent)) sb.drawUnderlay(ctx, timeMs);
      if (dim > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${dim})`;
        ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      }
    } else if (this._background !== null) {
      this._blitBackdrop(this._ensureBackdrop(this._background, dim));
    } else {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.fillStyle = `rgba(0, 0, 0, ${dim})`;
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    }

    this._ruleset.draw(ctx, this._session, timeMs, options);

    // The Overlay layer draws above the playfield, below the HUD; it lives inside lazer's
    // dimmable container, so the dim is folded into its sprites' tint instead. The cursor and
    // key overlay come after it, as in osu!, so a storyboard covering the playfield never hides them.
    if (sprites) sb!.drawOverlay(ctx, timeMs, 1 - dim);
    this._ruleset.drawAboveStoryboard?.(ctx, this._session, timeMs, options);

    if (options.showJudgement) {
      drawScore(ctx, this._scoreFrames, timeMs, this.skin);
      drawHUD(ctx, this._accFrames, timeMs, this.skin);
      // Mania draws its own combo (centered on the stage, no 'X' suffix) inside its
      // ruleset.draw above; catch draws a centred combo the same way. Skip the
      // std/taiko bottom-left renderer for both.
      if (this.replay.mode !== 3 && this.replay.mode !== 2) drawCombo(ctx, this._comboFrames, timeMs, this.skin);
    }

    if (options.showModIcons) drawModIcons(ctx, this._modIconRow);

    if (options.hudOverlay !== undefined) options.hudOverlay(ctx, timeMs);

    if (options.showURBar) drawURBar(ctx, this._urTimeline, timeMs);
  }
}
