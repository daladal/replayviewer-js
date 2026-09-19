/**
 * Storyboard asset resolution and decoding: locating the shared `.osb`, mapping storyboard paths
 * onto archive entries, and turning the referenced images into `ImageBitmap`s under a memory
 * budget. Everything here is worker-safe (`createImageBitmap` exists in workers; nothing touches
 * the DOM) and independent of how the archive was read — callers pass a lowercased,
 * `/`-separated full-path index of the `.osz`.
 */

import { runPooled } from '../parsers/SkinLoader.js';
import type { StoryboardData, StoryboardSprite, StoryboardAnimation, CommandGroup } from './types.js';

/** `Storyboard.GetStoragePathFromStoryboardPath`: extensions tried, in order, when a sprite path has none. */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'] as const;
/** `StoryboardSampleInfo.LookupNames` fallbacks when a sample path has no extension. */
export const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav'] as const;

/** Default cap on the summed RGBA bytes of every decoded storyboard image (256 MiB). */
export const STORYBOARD_BITMAP_BUDGET_BYTES = 256 * 1024 * 1024;

/** Canvas px per storyboard unit (a 480-unit-tall storyboard on a 720 px canvas). */
const SB_SCALE = 720 / 480;
/**
 * Default backing-store quality the resize cap assumes: no image is decoded larger than it can
 * appear on the 1280×720 logical canvas at 1 device px per canvas px, given its sprites' largest
 * scale command. Higher render qualities upsample such images rather than paying native-resolution
 * memory for every sprite; pass the actual quality to keep them sharp.
 */
export const DEFAULT_DECODE_QUALITY = 1;
/** Global budget scaling never shrinks an image below half of its capped size. */
const MIN_BUDGET_FACTOR = 0.5;

/** Limits for {@link decodeStoryboardImages}. */
export interface StoryboardDecodeOptions {
  /** Cap on the summed RGBA bytes of every decoded image; default {@link STORYBOARD_BITMAP_BUDGET_BYTES}. */
  budgetBytes?: number;
  /** Backing-store quality (device px per logical canvas px) the resize cap targets; default {@link DEFAULT_DECODE_QUALITY}. */
  quality?: number;
}

/** Metadata the `.osb` filename is derived from (romanised `[Metadata]` keys + `AudioFilename`). */
export interface StoryboardFilenameMetadata {
  artist: string;
  title: string;
  creator: string;
  audioFilename: string;
}

/**
 * Stable's shared-storyboard filename, as lazer reproduces it (`WorkingBeatmapCache.getMainStoryboardFilename`):
 * `Artist - Title (Creator).osb`, falling back to the audio file's stem when the artist is empty,
 * with Windows-invalid filename characters removed (stable strips them: an artist written
 * `(CV: Name)` yields an `.osb` named `(CV Name)`). Match it case-insensitively against the
 * archive's basenames; an `.osb` under any other name is ignored, exactly as lazer does.
 */
export function storyboardFilename(meta: StoryboardFilenameMetadata): string {
  const audioStem = meta.audioFilename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  const base = (meta.artist.length > 0 ? `${meta.artist} - ${meta.title}` : audioStem)
    + (meta.creator.length > 0 ? ` (${meta.creator})` : '')
    + '.osb';
  // Path.GetInvalidFileNameChars() on Windows — the platform the archive was written on.
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\x00-\x1f"<>|:*?\\/]/g, '');
}

/** Lowercased, `/`-separated, no leading `./` — the key form of every archive index used here. */
export function normaliseStoryboardPath(path: string): string {
  let p = path.replace(/\\/g, '/').toLowerCase();
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

function hasExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && dot < path.length - 1 && path.indexOf('/', dot) < 0;
}

/**
 * Resolve a storyboard path to an archive key (`Storyboard.GetStoragePathFromStoryboardPath` +
 * `BeatmapSetInfo.GetPathForFile`, an ordinal-ignore-case match): the exact path, else — when
 * the path carries no extension, as some old storyboards omit it — the path plus each candidate
 * extension in order. `index` holds lowercased full paths (`Map.has`/`Set.has`). Returns null
 * when nothing matches; lazer's texture store then yields null and the sprite draws nothing.
 */
export function resolveStoryboardPath(
  index: { has(key: string): boolean },
  path: string,
  kind: 'image' | 'sample' | 'video',
): string | null {
  const key = normaliseStoryboardPath(path);
  if (key === '') return null;
  if (index.has(key)) return key;
  if (hasExtension(key) || kind === 'video') return null;
  const exts = kind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
  for (const ext of exts) {
    if (index.has(key + ext)) return key + ext;
  }
  return null;
}

/**
 * Frame `i` of an animation: the index goes before the extension (`sb/a.png` → `sb/a0.png`),
 * or at the end when there is none. lazer replaces every dot in the path, which misbehaves on
 * dotted directories; stable's rule is the one storyboarders wrote against.
 */
export function animationFramePath(path: string, index: number): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || path.indexOf('/', dot) >= 0) return `${path}${index}`;
  return `${path.slice(0, dot)}${index}${path.slice(dot)}`;
}

/** Largest absolute scale factor any `S`/`V` command (top-level, loop or trigger) applies; 1 when there are none. */
function maxScaleOf(groups: CommandGroup[]): number {
  let max = 0;
  for (const g of groups) {
    for (const c of g.scale) max = Math.max(max, Math.abs(c.startValue), Math.abs(c.endValue));
    for (const c of g.vectorScale) {
      max = Math.max(max, Math.abs(c.startValue[0]), Math.abs(c.startValue[1]), Math.abs(c.endValue[0]), Math.abs(c.endValue[1]));
    }
  }
  return max > 0 ? max : 1;
}

/** One image the storyboard references, with the largest scale it is ever drawn at. */
export interface StoryboardImageRef {
  /** Normalised storyboard path (not yet resolved against the archive). */
  path: string;
  maxScale: number;
}

export interface StoryboardPaths {
  images: StoryboardImageRef[];
  samples: string[];
  videos: string[];
}

/**
 * Every file path a storyboard references, normalised and de-duplicated: sprite images,
 * animation frames `0..frameCount-1`, sample paths and video paths. `maxScale` is the largest
 * factor across all sprites sharing an image, so the decoder can cap its resolution.
 */
export function collectStoryboardPaths(data: StoryboardData): StoryboardPaths {
  const images = new Map<string, number>();
  const samples = new Set<string>();
  const videos = new Set<string>();
  const addImage = (path: string, scale: number): void => {
    const key = normaliseStoryboardPath(path);
    if (key === '') return;
    images.set(key, Math.max(images.get(key) ?? 0, scale));
  };
  for (const layer of data.layers) {
    for (const e of layer.elements) {
      if (e.kind === 'sample') { samples.add(normaliseStoryboardPath(e.path)); continue; }
      if (e.kind === 'video') { videos.add(normaliseStoryboardPath(e.path)); continue; }
      const sprite: StoryboardSprite | StoryboardAnimation = e;
      const scale = maxScaleOf([sprite.commands, ...sprite.loops, ...sprite.triggers]);
      if (sprite.kind === 'animation') {
        for (let i = 0; i < sprite.frameCount; i++) addImage(animationFramePath(sprite.path, i), scale);
      } else {
        addImage(sprite.path, scale);
      }
    }
  }
  return {
    images: [...images].map(([path, maxScale]) => ({ path, maxScale })),
    samples: [...samples].filter(s => s !== ''),
    videos: [...videos].filter(v => v !== ''),
  };
}

/** A decoded storyboard image. `width`/`height` are the file's native pixel size — the sprite's
 *  size in storyboard units for origin math — while `bitmap` may be smaller (resize cap). */
export interface StoryboardImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** Input to the decoder: resolved archive key, file bytes, and the largest scale drawn at. */
export interface StoryboardImageEntry {
  path: string;
  bytes: Uint8Array;
  maxScale: number;
}

export interface StoryboardDecodePlan {
  path: string;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
}

/**
 * Native pixel size from a PNG `IHDR` or the first JPEG `SOF` marker, without decoding.
 * Null for anything else (the image is then decoded at whatever size it has).
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = dv.getUint16(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      if (marker === 0xda) break;
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Decide the decode size of every image. Per image: never wider than it can appear on the
 * canvas (`width × SB_SCALE × quality × maxScale`). Then, if the summed RGBA bytes still
 * exceed `budgetBytes`, shrink every image by `sqrt(budget / total)` (floored at 0.5×) and warn.
 * Pure, so the arithmetic can be checked without a browser.
 */
export function planStoryboardDecode(
  sizes: ReadonlyArray<{ path: string; width: number; height: number; maxScale: number }>,
  opts: StoryboardDecodeOptions = {},
): StoryboardDecodePlan[] {
  const budgetBytes = opts.budgetBytes ?? STORYBOARD_BITMAP_BUDGET_BYTES;
  const quality = opts.quality ?? DEFAULT_DECODE_QUALITY;
  const plans: StoryboardDecodePlan[] = sizes.map(s => {
    const maxOnScreen = s.width * SB_SCALE * quality * s.maxScale;
    const f = s.width > 0 && s.width > maxOnScreen ? maxOnScreen / s.width : 1;
    return {
      path: s.path, width: s.width, height: s.height,
      targetWidth: Math.max(1, Math.round(s.width * f)),
      targetHeight: Math.max(1, Math.round(s.height * f)),
    };
  });
  const total = plans.reduce((sum, p) => sum + p.targetWidth * p.targetHeight * 4, 0);
  if (total > budgetBytes && budgetBytes > 0) {
    const f = Math.max(MIN_BUDGET_FACTOR, Math.sqrt(budgetBytes / total));
    for (const p of plans) {
      p.targetWidth = Math.max(1, Math.floor(p.targetWidth * f));
      p.targetHeight = Math.max(1, Math.floor(p.targetHeight * f));
    }
    console.warn(
      `StoryboardAssets: decoded images would take ${(total / 1048576).toFixed(0)} MiB ` +
      `(budget ${(budgetBytes / 1048576).toFixed(0)} MiB); scaling all by ${f.toFixed(2)}.`,
    );
  }
  return plans;
}

function mimeFor(path: string): string {
  return path.endsWith('.jpg') || path.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
}

/**
 * Decode storyboard images into bitmaps under the resize cap and budget of
 * {@link planStoryboardDecode}, through a bounded pool. Every decode is guarded: a corrupt or
 * unsupported file is warned about and left out, so its sprites simply draw nothing.
 * Keys are the entries' `path`s (resolved archive keys).
 */
export async function decodeStoryboardImages(
  entries: ReadonlyArray<StoryboardImageEntry>,
  opts: StoryboardDecodeOptions = {},
): Promise<Map<string, StoryboardImage>> {
  const images = new Map<string, StoryboardImage>();
  const byPath = new Map(entries.map(e => [e.path, e]));

  // Images whose header cannot be read are decoded at native size and excluded from the plan.
  const sized: { path: string; width: number; height: number; maxScale: number }[] = [];
  const unsized: StoryboardImageEntry[] = [];
  for (const e of entries) {
    const size = readImageSize(e.bytes);
    if (size !== null && size.width > 0 && size.height > 0) sized.push({ path: e.path, ...size, maxScale: e.maxScale });
    else unsized.push(e);
  }
  const plans = planStoryboardDecode(sized, opts);

  const decode = async (entry: StoryboardImageEntry, plan: StoryboardDecodePlan | null): Promise<void> => {
    try {
      // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
      const blob = new Blob([entry.bytes as Uint8Array<ArrayBuffer>], { type: mimeFor(entry.path) });
      const resize = plan !== null && (plan.targetWidth !== plan.width || plan.targetHeight !== plan.height);
      const bitmap = resize
        ? await createImageBitmap(blob, { resizeWidth: plan.targetWidth, resizeHeight: plan.targetHeight, resizeQuality: 'high' })
        : await createImageBitmap(blob);
      images.set(entry.path, {
        bitmap,
        width: plan?.width ?? bitmap.width,
        height: plan?.height ?? bitmap.height,
      });
    } catch (err) {
      console.warn(`StoryboardAssets: could not decode "${entry.path}":`, err);
    }
  };

  const tasks: (() => Promise<void>)[] = [
    ...plans.map(p => () => decode(byPath.get(p.path)!, p)),
    ...unsized.map(e => () => decode(e, null)),
  ];
  await runPooled(tasks);
  return images;
}
