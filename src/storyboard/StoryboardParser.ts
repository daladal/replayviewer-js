/**
 * Storyboard text parser — a line-for-line port of lazer's `LegacyStoryboardDecoder` (plus the
 * few `[General]`/`[Events]` facts the beatmap decoder owns: epilepsy flag and background file).
 *
 * Both streams feed one model: the difficulty's `.osu` is parsed first, then the shared `.osb`,
 * so within a layer `.osu` elements draw behind `.osb` elements. Every line is parsed inside its
 * own try/catch: a malformed line is dropped and parsing continues, exactly as lazer logs and
 * skips. Leading whitespace is significant (command depth), so callers must pass raw text.
 */

import type {
  Cmd, CommandGroup, LoopGroup, TriggerGroup, StoryboardData, StoryboardElement, StoryboardLayer,
  StoryboardOrigin, StoryboardSprite, StoryboardAnimation, StoryboardVideo, StoryboardSample,
} from './types';

const LATEST_FORMAT_VERSION = 14;
const MAX_PARSE_VALUE = 2147483647;
const MAX_COORDINATE_VALUE = 131072;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.avi', '.flv', '.mpg', '.wmv', '.m4v']);

/** `LegacyDecoder.Section` — case-sensitive; an unknown header falls back to General. */
const SECTIONS = new Set([
  'General', 'Editor', 'Metadata', 'Difficulty', 'Events', 'TimingPoints', 'Colours', 'HitObjects',
  'Variables', 'Fonts', 'CatchTheBeat', 'Mania',
]);

/** `LegacyEventType` — name (case-sensitive) or any integer. */
const EVENT_TYPES: Record<string, number> = { Background: 0, Video: 1, Break: 2, Colour: 3, Sprite: 4, Sample: 5, Animation: 6 };
/** `LegacyStoryLayer`. */
const LAYER_NAMES = ['Background', 'Fail', 'Pass', 'Foreground', 'Overlay', 'Video'];
/** `LegacyOrigins` — index is the integer form; `Custom` (6) and out-of-range collapse to TopLeft. */
const ORIGIN_NAMES: (StoryboardOrigin | 'Custom')[] = [
  'TopLeft', 'Centre', 'CentreLeft', 'TopRight', 'BottomCentre', 'TopCentre', 'Custom', 'CentreRight', 'BottomLeft', 'BottomRight',
];

const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_RE = /^[+-]?\d+$/;

/** `Parsing.ParseFloat` — invariant-culture float, range-checked, NaN rejected. Result is float32. */
function parseFloat32(input: string, limit = MAX_PARSE_VALUE): number {
  const s = input.trim();
  if (!FLOAT_RE.test(s)) throw new Error(`bad float "${input}"`);
  const v = Math.fround(Number(s));
  if (v < -limit || v > limit || Number.isNaN(v)) throw new Error(`float out of range "${input}"`);
  return v;
}

/** `Parsing.ParseDouble`. */
function parseDouble(input: string, limit = MAX_PARSE_VALUE): number {
  const s = input.trim();
  if (!FLOAT_RE.test(s)) throw new Error(`bad double "${input}"`);
  const v = Number(s);
  if (v < -limit || v > limit || Number.isNaN(v)) throw new Error(`double out of range "${input}"`);
  return v;
}

/** `Parsing.ParseInt` — integer digits only (`"1.0"` is rejected). */
function parseInt32(input: string, limit = MAX_PARSE_VALUE): number {
  const s = input.trim();
  if (!INT_RE.test(s)) throw new Error(`bad int "${input}"`);
  const v = Number(s);
  if (v < -2147483648 || v > 2147483647 || v < -limit || v > limit) throw new Error(`int out of range "${input}"`);
  return v;
}

/** `Enum.TryParse` on an int-backed enum: a case-sensitive name, or any integer (defined or not). */
function parseEnum(names: readonly string[], value: string): number | null {
  const s = value.trim();
  const i = names.indexOf(s);
  if (i >= 0) return i;
  if (INT_RE.test(s)) {
    const v = Number(s);
    return v >= -2147483648 && v <= 2147483647 ? v : null;
  }
  return null;
}

/** `LegacyDecoder.CleanFilename`: collapse doubled backslashes, trim quotes, standardise separators. */
function cleanFilename(path: string): string {
  return path.replace(/\\\\/g, '\\').replace(/^"+|"+$/g, '').replace(/\\/g, '/');
}

/** `Path.GetExtension(path).ToLowerInvariant()` on an already-standardised path. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1 || path.indexOf('/', dot) >= 0) return '';
  return path.slice(dot).toLowerCase();
}

function newGroup(): CommandGroup {
  return {
    x: [], y: [], scale: [], vectorScale: [], rotation: [], colour: [], alpha: [], blending: [], flipH: [], flipV: [],
    startTime: Infinity, endTime: -Infinity, hasCommands: false,
  };
}

function newLayer(name: string, depth: number, masking = true): StoryboardLayer {
  return { name, depth, masking, visibleWhenPassing: true, visibleWhenFailing: true, elements: [] };
}

type Sprite = StoryboardSprite | StoryboardAnimation;
type CommandOwner = Sprite | StoryboardVideo;

interface ParseState {
  formatVersion: number;
  variables: Map<string, string>;
  layers: Map<string, StoryboardLayer>;
  minimumLayerDepth: number;
  /** The element the current command lines attach to (null after a Sample, Background or dropped line). */
  sprite: CommandOwner | null;
  /** The last opened group: the sprite's top-level group, or the latest `L`/`T` group. */
  group: CommandGroup | null;
  /** Times shift for the current group: loops store absolute times, so inner commands are offset. */
  groupOffset: number;
  seq: number;
  widescreen: boolean;
  useSkinSprites: boolean;
  epilepsyWarning: boolean;
  backgroundFile: string;
}

/**
 * Parse a difficulty's `[Events]` and (optionally) the set's shared `.osb` into one storyboard.
 *
 * @param osuText  Raw `.osu` text (untrimmed lines). Its `osu file format vN` header selects the
 *                 decoder version for both streams (v<6 animation frame-delay correction).
 * @param osbText  Raw `.osb` text, or null when the set has none.
 */
export function parseStoryboard(osuText: string, osbText: string | null = null): StoryboardData {
  const st: ParseState = {
    formatVersion: readFormatVersion(osuText),
    variables: new Map(),
    layers: new Map(),
    minimumLayerDepth: 0,
    sprite: null,
    group: null,
    groupOffset: 0,
    seq: 0,
    widescreen: false,
    useSkinSprites: false,
    epilepsyWarning: false,
    backgroundFile: '',
  };
  // `Storyboard()` ctor: the six layers exist up-front with fixed depths.
  st.layers.set('Video', newLayer('Video', 4, false));
  st.layers.set('Background', newLayer('Background', 3));
  st.layers.set('Fail', { ...newLayer('Fail', 2), visibleWhenPassing: false });
  st.layers.set('Pass', { ...newLayer('Pass', 1), visibleWhenFailing: false });
  st.layers.set('Foreground', newLayer('Foreground', 0));
  st.layers.set('Overlay', newLayer('Overlay', -2147483648));

  parseStream(st, osuText, true);
  if (osbText != null) parseStream(st, osbText, false);

  const layers = [...st.layers.values()].sort((a, b) => b.depth - a.depth);
  let earliest: number | null = null;
  let latest: number | null = null;
  let hasDrawable = false;
  for (const layer of layers) {
    for (const el of layer.elements) {
      if (el.kind === 'sprite' || el.kind === 'animation') finalizeSprite(el);
      else if (el.kind === 'video') { sortGroup(el.commands); for (const l of el.loops) sortGroup(l); for (const t of el.triggers) sortGroup(t); }
      if (isDrawable(el)) hasDrawable = true;
      if (el.kind === 'video') continue; // excluded from the bounds, to match stable
      const start = el.kind === 'sample' ? el.timeMs : el.startTime;
      const end = el.kind === 'sample' ? el.timeMs : el.endTime;
      earliest = earliest == null ? start : Math.min(earliest, start);
      latest = latest == null ? end : Math.max(latest, end);
    }
  }

  const bg = st.backgroundFile.toLowerCase();
  const replacesBackground = bg !== ''
    && st.layers.get('Background')!.elements.some(e => e.path.toLowerCase() === bg);

  return {
    widescreen: st.widescreen,
    useSkinSprites: st.useSkinSprites,
    epilepsyWarning: st.epilepsyWarning,
    backgroundFile: st.backgroundFile,
    layers,
    earliestEventTime: earliest,
    latestEventTime: latest,
    replacesBackground,
    hasDrawable,
  };
}

function isDrawable(el: StoryboardElement): boolean {
  return el.kind === 'video' || el.kind === 'sample' || el.isDrawable;
}

/** `Decoder.GetDecoder`: the first non-blank line names the format; absent → latest. */
function readFormatVersion(text: string): number {
  const m = /^\uFEFF?\s*osu file format v(\d+)/.exec(text);
  return m ? Number(m[1]) : LATEST_FORMAT_VERSION;
}

/** `LegacyDecoder.ParseStreamInto`. */
function parseStream(st: ParseState, text: string, isPrimary: boolean): void {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let section = 'General';
  st.sprite = null;
  st.group = null;
  for (let line of text.split(/\r?\n/)) {
    // ShouldSkipLine: blank, or a whole-line comment after leading whitespace.
    if (line.trim() === '' || line.trimStart().startsWith('//')) continue;
    if (section !== 'Metadata') {
      const i = line.indexOf('//');
      if (i > 0) line = line.slice(0, i);
    }
    line = line.trimEnd();
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1);
      section = SECTIONS.has(name) ? name : 'General';
      continue;
    }
    try {
      switch (section) {
        case 'General': handleGeneral(st, line, isPrimary); break;
        case 'Events': handleEvents(st, line, isPrimary); break;
        case 'Variables': handleVariables(st, line); break;
      }
    } catch {
      // A bad line is dropped; parsing continues (lazer logs and moves on).
    }
  }
}

/** `SplitKeyVal(line, ':')` with trimmed entries. */
function splitKeyVal(line: string, sep: string, trim: boolean): [string, string] {
  const i = line.indexOf(sep);
  let key = i < 0 ? line : line.slice(0, i);
  let value = i < 0 ? '' : line.slice(i + 1);
  if (trim) { key = key.trim(); value = value.trim(); }
  return [key, value];
}

function handleGeneral(st: ParseState, line: string, isPrimary: boolean): void {
  const [key, value] = splitKeyVal(line, ':', true);
  switch (key) {
    case 'UseSkinSprites': st.useSkinSprites = value === '1'; break;
    case 'WidescreenStoryboard': st.widescreen = parseInt32(value) === 1; break;
    case 'EpilepsyWarning': if (isPrimary) st.epilepsyWarning = parseInt32(value) === 1; break;
  }
}

function handleVariables(st: ParseState, line: string): void {
  const [key, value] = splitKeyVal(line, '=', false);
  st.variables.set(key, value);
}

/** `decodeVariables`: single pass in declaration order, every occurrence, no recursion. */
function decodeVariables(st: ParseState, line: string): string {
  if (!line.includes('$')) return line;
  for (const [key, value] of st.variables) {
    if (key === '') throw new Error('empty variable name'); // string.Replace("") throws in .NET
    line = line.split(key).join(value);
  }
  return line;
}

function handleEvents(st: ParseState, rawLine: string, isPrimary: boolean): void {
  const line = decodeVariables(st, rawLine);
  let depth = 0;
  while (depth < line.length && (line[depth] === ' ' || line[depth] === '_')) depth++;
  const split = line.slice(depth).split(',');

  if (depth === 0) {
    st.sprite = null;
    st.group = null;
    const type = parseEnum(Object.keys(EVENT_TYPES), split[0]!);
    if (type == null) throw new Error(`Unknown event type: ${split[0]}`);
    const source: 'beatmap' | 'shared' = isPrimary ? 'beatmap' : 'shared';
    switch (type) {
      case 0: { // Background: the beatmap decoder owns the filename
        if (isPrimary) st.backgroundFile = cleanFilename(field(split, 2));
        break;
      }
      case 1: { // Video
        const offset = parseInt32(field(split, 1));
        const path = cleanFilename(field(split, 2));
        if (!VIDEO_EXTENSIONS.has(extensionOf(path))) {
          // Very old beatmaps typed their background as a video; the beatmap decoder takes it as such.
          if (isPrimary) st.backgroundFile = path;
          break;
        }
        const video: StoryboardVideo = {
          kind: 'video', path, offsetMs: offset, commands: newGroup(), loops: [], triggers: [],
        };
        st.layers.get('Video')!.elements.push(video);
        st.sprite = video;
        st.group = video.commands;
        st.groupOffset = 0;
        break;
      }
      case 4: case 6: { // Sprite / Animation
        const layer = parseLayer(st, field(split, 1));
        const origin = parseOrigin(field(split, 2));
        const path = cleanFilename(field(split, 3));
        const x = parseFloat32(field(split, 4), MAX_COORDINATE_VALUE);
        const y = parseFloat32(field(split, 5), MAX_COORDINATE_VALUE);
        const base = {
          source, path, origin, initialX: x, initialY: y,
          commands: newGroup(), loops: [] as LoopGroup[], triggers: [] as TriggerGroup[],
          startTime: Infinity, earliestTransformTime: Infinity, endTime: -Infinity, endTimeForDisplay: -Infinity, isDrawable: false,
        };
        let sprite: Sprite;
        if (type === 4) {
          sprite = { kind: 'sprite', ...base };
        } else {
          const frameCount = parseInt32(field(split, 6));
          let frameDelay = parseDouble(field(split, 7));
          // "random as hell but taken straight from osu-stable"
          if (st.formatVersion < 6) frameDelay = Math.round(0.015 * frameDelay) * 1.186 * Math.fround(1000 / 60);
          const loopType = split.length > 8 ? parseAnimationLoopType(split[8]!) : 'LoopForever';
          sprite = { kind: 'animation', ...base, frameCount, frameDelay, loopType };
        }
        // Background inference: the first sprite acts as the background when the `.osu` names none.
        if (isPrimary && st.backgroundFile === '') st.backgroundFile = path;
        layer.elements.push(sprite);
        st.sprite = sprite;
        st.group = sprite.commands;
        st.groupOffset = 0;
        break;
      }
      case 5: { // Sample — never becomes the command target
        const time = parseDouble(field(split, 1));
        const layer = parseLayer(st, field(split, 2));
        const path = cleanFilename(field(split, 3));
        const volume = split.length > 4 ? parseFloat32(split[4]!) : 100;
        const sample: StoryboardSample = { kind: 'sample', path, timeMs: time, volume: Math.trunc(volume), layer: layer.name };
        layer.elements.push(sample);
        break;
      }
      // Break, Colour, undefined integers: ignored.
    }
    return;
  }

  // Command line. Depth 1 always returns to the sprite's top-level group; deeper lines target the
  // last opened group, whatever their literal depth.
  if (depth < 2) {
    st.group = st.sprite?.commands ?? null;
    st.groupOffset = 0;
  }
  const commandType = split[0]!;
  switch (commandType) {
    case 'T': {
      const triggerName = field(split, 1);
      const startTime = split.length > 2 ? parseDouble(split[2]!) : -Infinity;
      const endTime = split.length > 3 ? parseDouble(split[3]!) : Infinity;
      const groupNumber = split.length > 4 ? -parseInt32(split[4]!) : 0;
      if (st.sprite) {
        const g: TriggerGroup = { ...newGroup(), triggerName, triggerStartTime: startTime, triggerEndTime: endTime, groupNumber };
        st.sprite.triggers.push(g);
        st.group = g;
        st.groupOffset = 0;
      } else {
        st.group = null;
      }
      break;
    }
    case 'L': {
      const startTime = parseDouble(field(split, 1));
      const repeatCount = parseInt32(field(split, 2));
      if (st.sprite) {
        const g: LoopGroup = { ...newGroup(), loopStartTime: startTime, totalIterations: Math.max(0, repeatCount - 1) + 1 };
        st.sprite.loops.push(g);
        st.group = g;
        st.groupOffset = startTime;
      } else {
        st.group = null;
      }
      break;
    }
    default: {
      if (split.length < 4) throw new Error('too few fields');
      if (split[3] === '') split[3] = split[2]!;
      const easing = parseInt32(split[1]!);
      const startTime = parseDouble(split[2]!);
      const endTime = parseDouble(split[3]!);
      const g = st.group;
      switch (commandType) {
        case 'F': {
          const s = parseFloat32(field(split, 4));
          const e = split.length > 5 ? parseFloat32(split[5]!) : s;
          if (g) add(st, g, g.alpha, easing, startTime, endTime, s, e);
          break;
        }
        case 'S': {
          const s = parseFloat32(field(split, 4));
          const e = split.length > 5 ? parseFloat32(split[5]!) : s;
          if (g) add(st, g, g.scale, easing, startTime, endTime, s, e);
          break;
        }
        case 'V': {
          const sx = parseFloat32(field(split, 4));
          const sy = parseFloat32(field(split, 5));
          const ex = split.length > 6 ? parseFloat32(split[6]!) : sx;
          const ey = split.length > 7 ? parseFloat32(split[7]!) : sy;
          if (g) add(st, g, g.vectorScale, easing, startTime, endTime, [sx, sy], [ex, ey]);
          break;
        }
        case 'R': {
          const s = parseFloat32(field(split, 4));
          const e = split.length > 5 ? parseFloat32(split[5]!) : s;
          if (g) add(st, g, g.rotation, easing, startTime, endTime, s, e);
          break;
        }
        case 'M': {
          const sx = parseFloat32(field(split, 4));
          const sy = parseFloat32(field(split, 5));
          const ex = split.length > 6 ? parseFloat32(split[6]!) : sx;
          const ey = split.length > 7 ? parseFloat32(split[7]!) : sy;
          if (g) {
            add(st, g, g.x, easing, startTime, endTime, sx, ex);
            add(st, g, g.y, easing, startTime, endTime, sy, ey);
          }
          break;
        }
        case 'MX': {
          const s = parseFloat32(field(split, 4));
          const e = split.length > 5 ? parseFloat32(split[5]!) : s;
          if (g) add(st, g, g.x, easing, startTime, endTime, s, e);
          break;
        }
        case 'MY': {
          const s = parseFloat32(field(split, 4));
          const e = split.length > 5 ? parseFloat32(split[5]!) : s;
          if (g) add(st, g, g.y, easing, startTime, endTime, s, e);
          break;
        }
        case 'C': {
          const sr = parseFloat32(field(split, 4));
          const sg = parseFloat32(field(split, 5));
          const sb = parseFloat32(field(split, 6));
          const er = split.length > 7 ? parseFloat32(split[7]!) : sr;
          const eg = split.length > 8 ? parseFloat32(split[8]!) : sg;
          const eb = split.length > 9 ? parseFloat32(split[9]!) : sb;
          if (g) add(st, g, g.colour, easing, startTime, endTime, [sr / 255, sg / 255, sb / 255], [er / 255, eg / 255, eb / 255]);
          break;
        }
        case 'P': {
          const type = field(split, 4);
          if (!g) break;
          // A zero-length parameter command holds its value; a ranged one reverts at its end.
          const instant = startTime === endTime;
          switch (type) {
            case 'A': add(st, g, g.blending, easing, startTime, endTime, 'additive', instant ? 'additive' : 'inherit'); break;
            case 'H': add(st, g, g.flipH, easing, startTime, endTime, true, instant); break;
            case 'V': add(st, g, g.flipV, easing, startTime, endTime, true, instant); break;
            // Any other letter: nothing is added, no error.
          }
          break;
        }
        default:
          throw new Error(`Unknown command type: ${commandType}`);
      }
    }
  }
}

/** `split[i]` with .NET's IndexOutOfRange semantics (throws → the line is dropped). */
function field(split: string[], i: number): string {
  const v = split[i];
  if (v === undefined) throw new Error(`missing field ${i}`);
  return v;
}

/** `StoryboardCommandGroup.AddCommand` + `StoryboardCommand` ctor (end clamped to start). */
function add<T>(st: ParseState, g: CommandGroup, list: Cmd<T>[], easing: number, startTime: number, endTime: number, startValue: T, endValue: T): void {
  startTime += st.groupOffset;
  endTime += st.groupOffset;
  if (endTime < startTime) endTime = startTime;
  list.push({ easing, startTime, endTime, startValue, endValue, seq: st.seq++ });
  g.hasCommands = true;
  if (startTime < g.startTime) g.startTime = startTime;
  if (endTime > g.endTime) g.endTime = endTime;
}

/** `parseLayer`: `Enum.Parse<LegacyStoryLayer>(value).ToString()` — an undefined integer names a new layer. */
function parseLayer(st: ParseState, value: string): StoryboardLayer {
  const v = parseEnum(LAYER_NAMES, value);
  if (v == null) throw new Error(`Unknown layer: ${value}`);
  const name = LAYER_NAMES[v] ?? String(v);
  let layer = st.layers.get(name);
  if (!layer) {
    // `Storyboard.GetLayer`: unknown names go in front of Foreground, behind Overlay.
    layer = newLayer(name, --st.minimumLayerDepth);
    st.layers.set(name, layer);
  }
  return layer;
}

function parseOrigin(value: string): StoryboardOrigin {
  const v = parseEnum(ORIGIN_NAMES, value);
  if (v == null) throw new Error(`Unknown origin: ${value}`);
  const name = ORIGIN_NAMES[v];
  return name === undefined || name === 'Custom' ? 'TopLeft' : name;
}

function parseAnimationLoopType(value: string): 'LoopForever' | 'LoopOnce' {
  const v = parseEnum(['LoopForever', 'LoopOnce'], value);
  if (v == null) throw new Error(`Unknown loop type: ${value}`);
  return v === 1 ? 'LoopOnce' : 'LoopForever';
}

function sortGroup(g: CommandGroup): void {
  const byTime = <T>(a: Cmd<T>, b: Cmd<T>) => a.startTime - b.startTime || a.endTime - b.endTime || a.seq - b.seq;
  g.x.sort(byTime); g.y.sort(byTime); g.scale.sort(byTime); g.vectorScale.sort(byTime); g.rotation.sort(byTime);
  g.colour.sort(byTime); g.alpha.sort(byTime); g.blending.sort(byTime); g.flipH.sort(byTime); g.flipV.sort(byTime);
}

/** `StoryboardSprite` derived timing (`StartTime`, `EarliestTransformTime`, `EndTime`, `EndTimeForDisplay`, `HasCommands`). */
function finalizeSprite(s: Sprite): void {
  sortGroup(s.commands);
  for (const l of s.loops) sortGroup(l);
  for (const t of s.triggers) sortGroup(t);

  let earliest = s.commands.startTime;
  let end = s.commands.endTime;
  let endForDisplay = s.commands.endTime;
  for (const l of s.loops) {
    earliest = Math.min(earliest, l.startTime);
    end = Math.max(end, l.endTime);
    if (l.hasCommands) endForDisplay = Math.max(endForDisplay, l.startTime + (l.endTime - l.startTime) * l.totalIterations);
  }
  s.earliestTransformTime = earliest;
  s.endTime = end;
  s.endTimeForDisplay = endForDisplay;
  s.isDrawable = s.commands.hasCommands || s.loops.some(l => l.hasCommands);

  // First visible time: scan alpha commands (top-level, then each loop), each scan stopping at
  // the first visible one; if the earliest alpha starts invisible, start at the earliest visible.
  const visible = (c: Cmd<number>) => c.startValue > 0 || c.endValue > 0;
  const alphas: Cmd<number>[] = [];
  const scan = (list: Cmd<number>[]) => {
    for (const c of list) { alphas.push(c); if (visible(c)) break; }
  };
  scan(s.commands.alpha);
  for (const l of s.loops) scan(l.alpha);
  s.startTime = earliest;
  if (alphas.length > 0) {
    let first = alphas[0]!;
    let firstReal: Cmd<number> | null = null;
    for (const c of alphas) {
      if (c.startTime < first.startTime) first = c;
      if (visible(c) && (firstReal == null || c.startTime < firstReal.startTime)) firstReal = c;
    }
    if (first.startValue === 0 && firstReal != null) s.startTime = firstReal.startTime;
  }
}
