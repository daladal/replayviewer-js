import type { BeatmapData, ReplayData, SkinAssets, HitResult } from '../types/index';
import type { ModDifficulty } from '../utils/modDifficulty';
import type { AccFrame, ComboFrame } from '../renderer/HUDRenderer';
import type { ScoreFrame } from '../utils/scoreProcessor';
import type { URTimeline } from '../renderer/URBarRenderer';
import type { RenderOptions } from '../renderer/Renderer';

/**
 * Per-gamemode dispatch interface. Each ruleset (osu!std, taiko, mania, catch)
 * implements this against its own opaque `Session` type: `build` precomputes
 * everything derived from a beatmap + replay pair, and the remaining members are
 * pure reads over that session. The Renderer owns the session and calls `draw`
 * once per frame; sessions are immutable after `build`, so all timeline accessors
 * may be cached by callers.
 */
export interface Ruleset<Session> {
  /**
   * Precompute the full playback state for one beatmap + replay pair: hit
   * judgements, score/accuracy/combo timelines, and any per-mode render state
   * (e.g. flashlight geometry). Called once per load (and again on skin swap or
   * export clone). `modDiff` carries the mod-adjusted difficulty values; times
   * throughout are milliseconds on the beatmap clock. `qualityTotal` is the
   * supersample factor (backing-store pixels per logical pixel) so any
   * pre-rasterized offscreen buffers match the main canvas resolution.
   */
  build(
    beatmap: BeatmapData,
    replay: ReplayData,
    modDiff: ModDifficulty,
    skin: SkinAssets,
    qualityTotal: number,
  ): Session;

  /**
   * Render the mode-specific gameplay layer for playback time `timeMs`.
   * The Renderer calls this between the playfield background and the shared HUD;
   * `ctx` is already transformed to the 1280×720 logical coordinate space.
   * Must not mutate the session — scrubbing calls this at arbitrary times in
   * any order.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    session: Session,
    timeMs: number,
    options: RenderOptions,
  ): void;

  /**
   * Optional second pass for elements osu! draws above the storyboard's Overlay layer but
   * below the shared HUD — the cursor and the key overlay (lazer proxies the cursor above the
   * HUD and the key overlay is HUD). The Renderer calls it right after that layer, so a
   * storyboard that covers the playfield never hides the player's input. Same contract as `draw`.
   */
  drawAboveStoryboard?(
    ctx: CanvasRenderingContext2D,
    session: Session,
    timeMs: number,
    options: RenderOptions,
  ): void;

  /**
   * All hit judgements, sorted by time. One entry per judged event (including
   * auto-misses); rulesets may include auxiliary entries flagged `comboIgnore`
   * (e.g. taiko drum-roll ticks) that carry sound/animation but no accuracy.
   */
  hitResults(session: Session): readonly HitResult[];

  /** Cumulative score timeline (one frame per scoring event), sorted by time. */
  scoreFrames(session: Session): readonly ScoreFrame[];
  /** Running-accuracy timeline, sorted by time. */
  accFrames(session: Session): readonly AccFrame[];
  /** Combo timeline (current + max combo per combo-affecting event), sorted by time. */
  comboFrames(session: Session): readonly ComboFrame[];

  /**
   * Data for the unstable-rate bar. Rulesets without a UR widget (e.g. taiko,
   * where stable shows none) return an empty timeline.
   */
  urTimeline(session: Session): URTimeline;
}
