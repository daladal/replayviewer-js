/**
 * Turns a parsed storyboard into per-sprite, per-property command tracks that a pure evaluator
 * can binary-search each frame. Loops are expanded into concrete iterations here
 * (`StoryboardLoopingGroup` semantics), trigger groups are resolved against the replay's
 * gameplay events and expanded per firing, and each layer gets an index for the sprites alive
 * at a given time. The result depends on the storyboard text and the trigger events only, so
 * it can be shared by every renderer drawing the same replay.
 */

import type {
  StoryboardData, StoryboardSprite, StoryboardAnimation, StoryboardVideo, StoryboardSample, StoryboardOrigin, Cmd, CommandGroup, LoopGroup, TriggerGroup,
} from './types.js';
import { triggerFirings, NO_TRIGGER_EVENTS, type TriggerEvents } from './triggers.js';

/** Every command of one property of one sprite, sorted by (startTime, application order). */
export interface PropertyTrack<T> {
  /** `cmds[i].startTime`, for the binary search. */
  starts: Float64Array;
  cmds: Cmd<T>[];
  /** Index resolved by the previous evaluation (-1 = none); an optimisation only, never semantic. */
  last: number;
}

export interface CompiledSprite {
  kind: 'sprite' | 'animation';
  /** Storyboard path as written (cleaned); the renderer resolves it against the archive. */
  path: string;
  origin: StoryboardOrigin;
  initialX: number;
  initialY: number;
  /** Lifetime: drawn for `startTime <= t < endTimeForDisplay` (`DrawableStoryboardSprite` LifetimeStart/End). */
  startTime: number;
  endTimeForDisplay: number;
  /** Earliest command of any kind — the animation frame-0 anchor. */
  earliestTransformTime: number;
  /** Position in the layer's element list: the z-order (`.osu` elements first, then `.osb`). */
  order: number;
  x: PropertyTrack<number>;
  y: PropertyTrack<number>;
  scale: PropertyTrack<number>;
  vectorScale: PropertyTrack<[number, number]>;
  /** Radians. */
  rotation: PropertyTrack<number>;
  colour: PropertyTrack<[number, number, number]>;
  alpha: PropertyTrack<number>;
  blending: PropertyTrack<'additive' | 'inherit'>;
  flipH: PropertyTrack<boolean>;
  flipV: PropertyTrack<boolean>;
}

export interface CompiledAnimation extends CompiledSprite {
  kind: 'animation';
  frameCount: number;
  /** ms per frame. */
  frameDelay: number;
  loopType: 'LoopForever' | 'LoopOnce';
}

/** A `Video` event: the file plays from map time `offsetMs`, faded by its own `F` commands. */
export interface CompiledVideo {
  /** Storyboard path as written (cleaned); the host matches it against the loaded video file. */
  path: string;
  offsetMs: number;
  alpha: PropertyTrack<number>;
  /** Scale/move/colour/parameter commands on a video are not applied (only alpha is). */
  hasUnsupportedCommands: boolean;
}

export interface CompiledLayer {
  name: string;
  /** Higher draws first (further back). */
  depth: number;
  visibleWhenPassing: boolean;
  visibleWhenFailing: boolean;
  /** File order = z-order. */
  sprites: (CompiledSprite | CompiledAnimation)[];
  /** Sprites alive at `t` (lifetime only — visibility is the evaluator's call), in z-order.
   *  Returns a scratch array owned by the layer, valid until the next call. */
  activeAt(t: number): (CompiledSprite | CompiledAnimation)[];
}

export interface CompiledStoryboard {
  widescreen: boolean;
  replacesBackground: boolean;
  /** Back to front, videos and samples excluded; unknown-name layers sit between Foreground and Overlay. */
  layers: CompiledLayer[];
  /** Every `Video` event, in file order; drawn below every layer. */
  videos: CompiledVideo[];
  /** Whether any layer has a sprite to draw (a storyboard may carry only a video). */
  hasSprites: boolean;
  /** `DimmableStoryboard.storyboardMustAlwaysBePresent`: the Overlay layer or any sample keeps the storyboard present at dim 1. */
  mustAlwaysBePresent: boolean;
  /** Pass/Fail state at `t` (`DrawableStoryboard.passing`). Always passing: no health timeline exists. */
  passingAt(t: number): boolean;
}

/**
 * Expand a loop's commands into `totalIterations` copies (`StoryboardLoopingCommand` +
 * `TransformSequence.Loop`): iteration `k` is shifted by `k × period`, where the period is the
 * loop's own command extent (earliest inner start to latest inner end), not the `L` line's start
 * and not the largest relative end. A zero-length period would re-add the same transform every
 * frame in lazer; it plays once here.
 */
export function expandLoop<T>(cmds: readonly Cmd<T>[], loop: LoopGroup): Cmd<T>[] {
  const period = loop.endTime - loop.startTime;
  const iterations = period > 0 ? loop.totalIterations : 1;
  const out: Cmd<T>[] = [];
  for (let k = 0; k < iterations; k++) {
    const shift = k * period;
    for (const c of cmds) out.push({ ...c, startTime: c.startTime + shift, endTime: c.endTime + shift });
  }
  return out;
}

/** A trigger group's commands for one property plus the times the group fires. */
interface FiredList<T> { cmds: readonly Cmd<T>[]; firings: readonly number[] }

/**
 * Build one property's track from the sprite's top-level group, its loops and its resolved
 * triggers. Application order follows `StoryboardSprite.ApplyTransforms` — every command sorted
 * by its (first) start time, ties in enumeration order (top-level list, then loops in file
 * order) — because that is the transform-id order the framework breaks same-start ties with:
 * the later id wins. Trigger commands are added at runtime in lazer, after everything else, so
 * each firing's commands take ids after the pre-applied ones, in firing order; a firing's end
 * value then holds until a later-starting command (scripted or fired) takes over.
 */
function buildTrack<T>(lists: readonly (readonly Cmd<T>[])[], loops: readonly LoopGroup[], fired: readonly FiredList<T>[]): PropertyTrack<T> {
  interface Entry { cmd: Cmd<T>; loop: LoopGroup | null; group: number; index: number }
  const entries: Entry[] = [];
  lists.forEach((list, group) => list.forEach((cmd, index) => entries.push({ cmd, loop: group === 0 ? null : loops[group - 1]!, group, index })));
  entries.sort((a, b) => a.cmd.startTime - b.cmd.startTime || a.group - b.group || a.index - b.index);

  const expanded: { cmd: Cmd<T>; id: number }[] = [];
  entries.forEach((e, id) => {
    const cmds = e.loop === null ? [e.cmd] : expandLoop([e.cmd], e.loop);
    for (const cmd of cmds) expanded.push({ cmd, id });
  });

  const firingsById: { at: number; group: number; index: number; cmd: Cmd<T> }[] = [];
  fired.forEach((f, group) => {
    for (const at of f.firings) f.cmds.forEach((c, index) => firingsById.push({ at, group, index, cmd: { ...c, startTime: c.startTime + at, endTime: c.endTime + at } }));
  });
  firingsById.sort((a, b) => a.at - b.at || a.group - b.group || a.index - b.index);
  firingsById.forEach((f, i) => expanded.push({ cmd: f.cmd, id: entries.length + i }));

  expanded.sort((a, b) => a.cmd.startTime - b.cmd.startTime || a.id - b.id);

  const cmds = expanded.map(e => e.cmd);
  const starts = new Float64Array(cmds.length);
  for (let i = 0; i < cmds.length; i++) starts[i] = cmds[i]!.startTime;
  return { starts, cmds, last: -1 };
}

/** Trigger groups with commands, with their firing times (never-firing groups dropped). */
function resolveTriggers(triggers: readonly TriggerGroup[], events: TriggerEvents): { group: TriggerGroup; firings: number[] }[] {
  const out: { group: TriggerGroup; firings: number[] }[] = [];
  for (const group of triggers) {
    if (!group.hasCommands) continue;
    const firings = triggerFirings(group, events);
    if (firings.length > 0) out.push({ group, firings });
  }
  return out;
}

/**
 * Compile one sprite; null when it never draws (no commands outside triggers and no trigger
 * firing). Lazer never creates a drawable for a trigger-only sprite (`IsDrawable => HasCommands`)
 * although stable draws it, so here a sprite lives from its first firing to the end of its last
 * one, and a firing outside a scripted sprite's own lifetime extends it likewise.
 */
function compileSprite(s: StoryboardSprite | StoryboardAnimation, order: number, events: TriggerEvents): CompiledSprite | CompiledAnimation | null {
  const fired = resolveTriggers(s.triggers, events);
  if (!s.isDrawable && fired.length === 0) return null;
  let startTime = s.startTime, endTimeForDisplay = s.endTimeForDisplay, earliestTransformTime = s.earliestTransformTime;
  for (const { group, firings } of fired) {
    const first = firings[0]!, last = firings[firings.length - 1]!;
    startTime = Math.min(startTime, first + group.startTime);
    earliestTransformTime = Math.min(earliestTransformTime, first + group.startTime);
    endTimeForDisplay = Math.max(endTimeForDisplay, last + group.endTime);
  }
  const groups: CommandGroup[] = [s.commands, ...s.loops];
  const track = <T>(pick: (g: CommandGroup) => Cmd<T>[]): PropertyTrack<T> =>
    buildTrack(groups.map(pick), s.loops, fired.map(f => ({ cmds: pick(f.group), firings: f.firings })));
  const base: CompiledSprite = {
    kind: s.kind,
    path: s.path,
    origin: s.origin,
    initialX: s.initialX,
    initialY: s.initialY,
    startTime,
    endTimeForDisplay,
    earliestTransformTime,
    order,
    x: track(g => g.x), y: track(g => g.y), scale: track(g => g.scale), vectorScale: track(g => g.vectorScale),
    rotation: track(g => g.rotation), colour: track(g => g.colour), alpha: track(g => g.alpha),
    blending: track(g => g.blending), flipH: track(g => g.flipH), flipV: track(g => g.flipV),
  };
  if (s.kind === 'animation') {
    return { ...base, kind: 'animation', frameCount: s.frameCount, frameDelay: s.frameDelay, loopType: s.loopType };
  }
  return base;
}

/** Videos take commands like sprites (`StoryboardVideo` is a `StoryboardSprite`); only alpha is drawn. */
function compileVideo(v: StoryboardVideo): CompiledVideo {
  const groups: CommandGroup[] = [v.commands, ...v.loops];
  const has = (g: CommandGroup): boolean =>
    g.x.length + g.y.length + g.scale.length + g.vectorScale.length + g.rotation.length + g.colour.length
    + g.blending.length + g.flipH.length + g.flipV.length > 0;
  return {
    path: v.path,
    offsetMs: v.offsetMs,
    alpha: buildTrack(groups.map(g => g.alpha), v.loops, []),
    hasUnsupportedCommands: groups.some(has) || v.triggers.some(t => t.hasCommands),
  };
}

/**
 * Active-sprite index: sprites sorted by start time plus a running maximum of end times, so
 * `activeAt(t)` walks back from the last sprite that has started only as far as anything can
 * still be alive. Stateless, so seeks and export frames cost the same as forward playback.
 */
function compileLayer(name: string, depth: number, visibleWhenPassing: boolean, visibleWhenFailing: boolean, sprites: (CompiledSprite | CompiledAnimation)[]): CompiledLayer {
  const byStart = sprites.map((_, i) => i).sort((a, b) => sprites[a]!.startTime - sprites[b]!.startTime || a - b);
  const starts = new Float64Array(byStart.length);
  const maxEndPrefix = new Float64Array(byStart.length);
  let maxEnd = -Infinity;
  byStart.forEach((si, i) => {
    starts[i] = sprites[si]!.startTime;
    maxEnd = Math.max(maxEnd, sprites[si]!.endTimeForDisplay);
    maxEndPrefix[i] = maxEnd;
  });
  const out: (CompiledSprite | CompiledAnimation)[] = [];
  return {
    name, depth, visibleWhenPassing, visibleWhenFailing, sprites,
    activeAt(t: number) {
      let lo = 0, hi = starts.length - 1, last = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid]! <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
      }
      out.length = 0;
      for (let i = last; i >= 0 && maxEndPrefix[i]! > t; i--) {
        const s = sprites[byStart[i]!]!;
        if (s.endTimeForDisplay > t) out.push(s);
      }
      out.sort((a, b) => a.order - b.order);
      return out;
    },
  };
}

/** Whether any sprite/animation carries commands inside a trigger group (the only sprites `triggerEvents` can affect). */
export function hasTriggerCommands(data: StoryboardData): boolean {
  for (const layer of data.layers) {
    for (const el of layer.elements) {
      if ((el.kind === 'sprite' || el.kind === 'animation') && el.triggers.some(t => t.hasCommands)) return true;
    }
  }
  return false;
}

/**
 * The `Sample` events that play, ascending by time: those on a layer shown while passing. The
 * storyboard is always passing here, so a Fail-layer sample never plays (lazer never updates a
 * `DrawableStoryboardSample` on a hidden layer).
 */
export function playableStoryboardSamples(data: StoryboardData): StoryboardSample[] {
  const out: StoryboardSample[] = [];
  for (const layer of data.layers) {
    if (!layer.visibleWhenPassing) continue;
    for (const el of layer.elements) if (el.kind === 'sample') out.push(el);
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Compile every sprite/animation of a storyboard that can draw: those with scripted commands,
 * plus trigger-only sprites whose triggers fire for `triggerEvents` (videos and samples are
 * skipped). Without events, triggers never fire.
 */
export function compileStoryboard(data: StoryboardData, triggerEvents: TriggerEvents = NO_TRIGGER_EVENTS): CompiledStoryboard {
  const layers: CompiledLayer[] = [];
  const videos: CompiledVideo[] = [];
  let mustAlwaysBePresent = false;
  for (const layer of data.layers) {
    if (layer.name === 'Video') {
      for (const el of layer.elements) if (el.kind === 'video') videos.push(compileVideo(el));
      continue;
    }
    const sprites: (CompiledSprite | CompiledAnimation)[] = [];
    layer.elements.forEach((el, order) => {
      if (el.kind === 'sample') { mustAlwaysBePresent = true; return; }
      if (el.kind !== 'sprite' && el.kind !== 'animation') return;
      const compiled = compileSprite(el, order, triggerEvents);
      if (compiled !== null) sprites.push(compiled);
    });
    if (layer.name === 'Overlay' && layer.elements.length > 0) mustAlwaysBePresent = true;
    layers.push(compileLayer(layer.name, layer.depth, layer.visibleWhenPassing, layer.visibleWhenFailing, sprites));
  }
  layers.sort((a, b) => b.depth - a.depth);
  return {
    widescreen: data.widescreen,
    replacesBackground: data.replacesBackground,
    layers,
    videos,
    hasSprites: layers.some(l => l.sprites.length > 0),
    mustAlwaysBePresent,
    passingAt: () => true,
  };
}
