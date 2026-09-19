/**
 * Storyboard object model — a direct mirror of `osu.Game/Storyboards/*.cs` as produced by
 * lazer's `LegacyStoryboardDecoder`. Everything here is plain data (structured-clonable) so a
 * parsed storyboard can cross a `postMessage` boundary unchanged.
 */

/** `LegacyOrigins` (`osu.Game/Beatmaps/Legacy/LegacyOrigins.cs`); `Custom` collapses to TopLeft. */
export type StoryboardOrigin =
  | 'TopLeft' | 'Centre' | 'CentreLeft' | 'TopRight' | 'BottomCentre'
  | 'TopCentre' | 'CentreRight' | 'BottomLeft' | 'BottomRight';

/** One command on one property. `startTime`/`endTime` are absolute ms except inside a
 *  {@link TriggerGroup}, where they are relative to the firing time. */
export interface Cmd<T> {
  /** Raw storyboard easing integer; values outside 0..35 behave as linear. */
  easing: number;
  startTime: number;
  endTime: number;
  startValue: T;
  endValue: T;
  /** File order across the whole storyboard — the tie-break for equal start times. */
  seq: number;
}

/** `StoryboardCommandGroup`: per-property command lists, each sorted by (startTime, endTime, seq). */
export interface CommandGroup {
  x: Cmd<number>[];
  y: Cmd<number>[];
  scale: Cmd<number>[];
  vectorScale: Cmd<[number, number]>[];
  /** Radians, as written in the file (lazer converts to degrees on decode; Canvas wants radians). */
  rotation: Cmd<number>[];
  /** Normalised 0..1 per channel. */
  colour: Cmd<[number, number, number]>[];
  alpha: Cmd<number>[];
  blending: Cmd<'additive' | 'inherit'>[];
  flipH: Cmd<boolean>[];
  flipV: Cmd<boolean>[];
  /** Min start over every command; `Infinity` when empty. */
  startTime: number;
  /** Max end over every command; `-Infinity` when empty. */
  endTime: number;
  hasCommands: boolean;
}

/** `StoryboardLoopingGroup`: command times already include `loopStartTime`. */
export interface LoopGroup extends CommandGroup {
  loopStartTime: number;
  /** `max(1, repeatCount)` — `L,t,0` and `L,t,1` both play once. */
  totalIterations: number;
}

/** `StoryboardTriggerGroup`: command times are relative to each firing. */
export interface TriggerGroup extends CommandGroup {
  triggerName: string;
  triggerStartTime: number;
  triggerEndTime: number;
  /** Stored negated, as stable and lazer do; unused by lazer. */
  groupNumber: number;
}

export interface StoryboardSprite {
  kind: 'sprite';
  /** Which stream declared it: the difficulty's `[Events]` or the shared `.osb`. */
  source: 'beatmap' | 'shared';
  path: string;
  origin: StoryboardOrigin;
  initialX: number;
  initialY: number;
  commands: CommandGroup;
  loops: LoopGroup[];
  triggers: TriggerGroup[];
  /** `StoryboardSprite.StartTime` — first visible time (alpha-aware). */
  startTime: number;
  /** `StoryboardSprite.EarliestTransformTime` — earliest command of any kind. */
  earliestTransformTime: number;
  /** `StoryboardSprite.EndTime` — loops counted once. */
  endTime: number;
  /** `StoryboardSprite.EndTimeForDisplay` — loops counted `totalIterations` times. */
  endTimeForDisplay: number;
  /** `HasCommands` over top-level + loops (trigger-only sprites are `false`, as in lazer). */
  isDrawable: boolean;
}

export interface StoryboardAnimation extends Omit<StoryboardSprite, 'kind'> {
  kind: 'animation';
  frameCount: number;
  /** ms per frame (already corrected for format versions < 6). */
  frameDelay: number;
  loopType: 'LoopForever' | 'LoopOnce';
}

export interface StoryboardVideo {
  kind: 'video';
  path: string;
  /** `Video,offset,…` — integer ms; the video's own 0 sits at this map time. */
  offsetMs: number;
  commands: CommandGroup;
  loops: LoopGroup[];
  triggers: TriggerGroup[];
}

export interface StoryboardSample {
  kind: 'sample';
  path: string;
  timeMs: number;
  /** Truncated to an int, 0..100 as written. */
  volume: number;
  layer: string;
}

export type StoryboardElement = StoryboardSprite | StoryboardAnimation | StoryboardVideo | StoryboardSample;

export interface StoryboardLayer {
  name: string;
  /** Draw order: higher depth draws first (behind). */
  depth: number;
  masking: boolean;
  visibleWhenPassing: boolean;
  visibleWhenFailing: boolean;
  elements: StoryboardElement[];
}

export interface StoryboardData {
  /** Last `WidescreenStoryboard` seen across `.osu` then `.osb`; legacy default `false`. */
  widescreen: boolean;
  /** Parsed for completeness; skin sprites are not looked up. */
  useSkinSprites: boolean;
  epilepsyWarning: boolean;
  /** The beatmap's background filename (cleaned), used by `replacesBackground`. */
  backgroundFile: string;
  /** Fixed order: Video, Background, Fail, Pass, Foreground, Overlay (back to front). */
  layers: StoryboardLayer[];
  /** `Storyboard.EarliestEventTime` — min `startTime` over every non-video element, or null. */
  earliestEventTime: number | null;
  /** `Storyboard.LatestEventTime` — max end over every non-video element (samples: their time), or null. */
  latestEventTime: number | null;
  /** `Storyboard.ReplacesBackground` — a Background-layer sprite uses the beatmap's background image. */
  replacesBackground: boolean;
  /** Any element with `isDrawable` (videos and samples count). */
  hasDrawable: boolean;
}
