import { unzip, type Unzipped } from 'fflate';
import { md5 } from '../utils/md5.js';
import { parseStoryboard } from '../storyboard/StoryboardParser.js';
import {
  storyboardFilename, collectStoryboardPaths, resolveStoryboardPath, decodeStoryboardImages,
  type StoryboardImage, type StoryboardImageEntry,
} from '../storyboard/StoryboardAssets.js';
import type { StoryboardData } from '../storyboard/types.js';

/**
 * Asynchronous unzip via fflate's worker-backed API — keeps large (10–30 MB)
 * archive extraction off the main thread. Rejects on a corrupt archive.
 */
export function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => { if (err) reject(err); else resolve(files); });
  });
}

/**
 * Decoded contents of a beatmap set (`.osz`): the matched `.osu` file's raw bytes,
 * its decoded song audio and background (null when missing or undecodable), every
 * other decodable audio file (custom hitsounds) keyed by both lowercased basename and
 * lowercased full archive path, and — only when requested via {@link LoadBeatmapSetOptions} —
 * the storyboard, its decoded images, and the beatmap video's bytes.
 */
export interface BeatmapSetContents {
  osuBytes: Uint8Array;
  audioBuffer: AudioBuffer | null;
  background: ImageBitmap | null;
  beatmapSounds: Map<string, AudioBuffer>;
  /** The difficulty's `[Events]` merged with the set's shared `.osb`; null unless `storyboard` was requested. */
  storyboard: StoryboardData | null;
  /** Decoded storyboard images keyed by resolved lowercased archive path (see `resolveStoryboardPath`). Empty unless requested. */
  storyboardImages: Map<string, StoryboardImage>;
  /** Raw bytes of the first `Video` event's file (not decoded); null unless `video` was requested and the file exists. */
  video: { path: string; bytes: Uint8Array } | null;
}

/** Opt-in extras for {@link loadBeatmapSet}; everything defaults to off. */
export interface LoadBeatmapSetOptions {
  /** Parse the storyboard (`.osu` events + shared `.osb`) and decode every image it references. */
  storyboard?: boolean;
  /** Extract the beatmap video's bytes (the `Video` event's file) for a video source to play. */
  video?: boolean;
  /** Cap on the summed RGBA bytes of decoded storyboard images; default 256 MiB. */
  storyboardBitmapBudgetBytes?: number;
  /**
   * Backing-store quality (device px per logical canvas px) storyboard images are decoded to
   * fit; default 1. Images a sprite can never show larger than this are downsized on decode.
   */
  storyboardDecodeQuality?: number;
}

/** First `Key: value` line matching `key` (case-insensitive) anywhere in the file, trimmed. */
function extractKey(osuText: string, key: string): string {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'i');
  for (const rawLine of osuText.split(/\r?\n/)) {
    const m = re.exec(rawLine.trim());
    if (m) return m[1]!.trim();
  }
  return '';
}

function extractAudioFilename(osuText: string): string {
  return extractKey(osuText, 'AudioFilename');
}

/** Bytes of the set's shared `.osb`, located only by stable's exact filename rule. */
function findStoryboardOsb(osuText: string, byName: ReadonlyMap<string, Uint8Array>): Uint8Array | null {
  const name = storyboardFilename({
    artist: extractKey(osuText, 'Artist'),
    title: extractKey(osuText, 'Title'),
    creator: extractKey(osuText, 'Creator'),
    audioFilename: extractAudioFilename(osuText),
  });
  return byName.get(name.toLowerCase()) ?? null;
}

/**
 * Filename of the `[Events]` background line (`0,0,"bg.png",…`), or `''`. The quotes are
 * optional — osu!'s beatmap decoder only trims them when present, and older maps omit them.
 */
export function extractBackgroundFilename(osuText: string): string {
  let inEvents = false;
  for (const rawLine of osuText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '[Events]') { inEvents = true; continue; }
    if (line.startsWith('[')) { inEvents = false; continue; }
    if (!inEvents) continue;
    const m = /^0\s*,\s*0\s*,\s*"?([^",]+)"?/.exec(line);
    if (m) return m[1]!;
  }
  return '';
}

/**
 * Unzips a `.osz` and returns the `.osu` whose MD5 matches `targetHash`, plus its decoded
 * song audio, background image, and custom hitsound samples. `targetHash === ''` accepts
 * the first `.osu` found (hash check skipped). `fetchOsuOverride` is an escape hatch for
 * stale archives (e.g. from a beatmap mirror) whose `.osu` no longer matches the replay
 * hash: it supplies a canonical `.osu` fetched elsewhere — only the `.osu` bytes are
 * replaced; audio/background/hitsounds still come from the archive. Throws when no
 * matching `.osu` can be found. `opts` opts into storyboard parsing + image decoding and
 * video-byte extraction, both off by default.
 */
export async function loadBeatmapSet(
  buffer: ArrayBuffer,
  targetHash: string,
  audioCtx: AudioContext,
  fetchOsuOverride?: () => Promise<Uint8Array>,
  opts: LoadBeatmapSetOptions = {},
): Promise<BeatmapSetContents> {
  const files = await unzipAsync(new Uint8Array(buffer));

  const byName = new Map<string, Uint8Array>();
  // Full-path index for storyboard lookups: `sb/fg/x.png` and `sb/bg/x.png` share a basename.
  const byPath = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const basename = (path.split('/').pop() ?? path).toLowerCase();
    byName.set(basename, bytes);
    byPath.set(path.replace(/\\/g, '/').toLowerCase(), bytes);
  }

  const osuEntries = Object.entries(files).filter(([p]) => p.toLowerCase().endsWith('.osu'));
  if (osuEntries.length === 0) {
    throw new Error('No .osu file found inside the .osz archive.');
  }

  let matchedBytes: Uint8Array | null = null;

  if (targetHash === '') {
    matchedBytes = osuEntries[0]![1];
    console.warn('BeatmapSetLoader: replay has no beatmap hash; using first .osu found.');
  } else {
    for (const [, bytes] of osuEntries) {
      if (md5(bytes) === targetHash) {
        matchedBytes = bytes;
        break;
      }
    }
    if (matchedBytes === null && fetchOsuOverride !== undefined) {
      try {
        const override = await fetchOsuOverride();
        if (md5(override) === targetHash) {
          matchedBytes = override;
          console.warn(
            `BeatmapSetLoader: no .osu in archive matched ${targetHash}; ` +
            `using canonical .osu fetched from osu! (mirror .osz is stale).`,
          );
        } else {
          console.warn('BeatmapSetLoader: override .osu did not match target hash either.');
        }
      } catch (err) {
        console.warn('BeatmapSetLoader: failed to fetch override .osu:', err);
      }
    }
    if (matchedBytes === null) {
      throw new Error(
        `No .osu in this archive matches the replay's beatmap hash (${targetHash}).\n` +
        `Make sure you are loading the correct beatmap set.`
      );
    }
  }

  const osuBytes = matchedBytes;
  const osuText  = new TextDecoder('utf-8').decode(osuBytes);

  const audioFilename = extractAudioFilename(osuText).toLowerCase();
  const bgFilename    = extractBackgroundFilename(osuText).toLowerCase();

  let audioBuffer: AudioBuffer | null = null;
  if (audioFilename !== '') {
    const audioBytes = byName.get(audioFilename);
    if (audioBytes !== undefined) {
      try {
        const copy = audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength,
        ) as ArrayBuffer;
        audioBuffer = await audioCtx.decodeAudioData(copy);
      } catch (err) {
        console.warn('BeatmapSetLoader: could not decode audio file:', err);
      }
    } else {
      console.warn(`BeatmapSetLoader: audio file "${audioFilename}" not found in archive.`);
    }
  }

  let background: ImageBitmap | null = null;
  if (bgFilename !== '') {
    const bgBytes = byName.get(bgFilename);
    if (bgBytes !== undefined) {
      try {
        const isJpg = bgFilename.endsWith('.jpg') || bgFilename.endsWith('.jpeg');
        // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
        const blob  = new Blob([bgBytes as Uint8Array<ArrayBuffer>], { type: isJpg ? 'image/jpeg' : 'image/png' });
        background  = await createImageBitmap(blob);
      } catch (err) {
        console.warn('BeatmapSetLoader: could not decode background image:', err);
      }
    }
  }

  const beatmapSounds = new Map<string, AudioBuffer>();
  // The song itself (audioFilename) is already decoded into audioBuffer above — keep it
  // out of beatmapSounds or it gets decoded a second time and retained as dead PCM.
  const soundEntries = Object.entries(files).filter(([p]) => {
    const lower = p.toLowerCase();
    const basename = (lower.split('/').pop() ?? lower);
    if (basename === audioFilename) return false;
    return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg');
  });

  await Promise.all(soundEntries.map(async ([path, bytes]) => {
    try {
      const copy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const audioBuf = await audioCtx.decodeAudioData(copy);
      const lower = path.replace(/\\/g, '/').toLowerCase();
      const basename = (lower.split('/').pop() ?? lower);
      beatmapSounds.set(basename, audioBuf);
      // Storyboard samples address files by full path; hitsounds by basename.
      beatmapSounds.set(lower, audioBuf);
    } catch { /* undecodable */ }
  }));

  let storyboard: StoryboardData | null = null;
  let storyboardImages = new Map<string, StoryboardImage>();
  let video: BeatmapSetContents['video'] = null;
  if (opts.storyboard === true || opts.video === true) {
    const osbBytes = findStoryboardOsb(osuText, byName);
    const parsed = parseStoryboard(osuText, osbBytes === null ? null : new TextDecoder('utf-8').decode(osbBytes));
    const paths = collectStoryboardPaths(parsed);

    if (opts.storyboard === true) {
      storyboard = parsed;
      // Several storyboard paths may resolve to one archive file; decode it once at the largest scale.
      const entries = new Map<string, StoryboardImageEntry>();
      let missing = 0;
      for (const ref of paths.images) {
        const key = resolveStoryboardPath(byPath, ref.path, 'image');
        if (key === null) { missing++; continue; }
        const prev = entries.get(key);
        if (prev === undefined) entries.set(key, { path: key, bytes: byPath.get(key)!, maxScale: ref.maxScale });
        else prev.maxScale = Math.max(prev.maxScale, ref.maxScale);
      }
      if (missing > 0) console.warn(`BeatmapSetLoader: ${missing} storyboard image path(s) not found in archive.`);
      storyboardImages = await decodeStoryboardImages([...entries.values()], {
        budgetBytes: opts.storyboardBitmapBudgetBytes,
        quality: opts.storyboardDecodeQuality,
      });
    }

    if (opts.video === true) {
      for (const path of paths.videos) {
        const key = resolveStoryboardPath(byPath, path, 'video');
        if (key !== null) { video = { path: key, bytes: byPath.get(key)! }; break; }
      }
    }
  }

  return { osuBytes, audioBuffer, background, beatmapSounds, storyboard, storyboardImages, video };
}

/**
 * Background-image-only counterpart to `loadBeatmapSet`: matches `targetHash` when
 * possible, otherwise uses the first `.osu`. Returns null on any failure.
 */
export async function extractBeatmapBackground(
  buffer: ArrayBuffer,
  targetHash: string,
): Promise<ImageBitmap | null> {
  const files = await unzipAsync(new Uint8Array(buffer));

  const byName = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const basename = (path.split('/').pop() ?? path).toLowerCase();
    byName.set(basename, bytes);
  }

  const osuEntries = Object.entries(files).filter(([p]) => p.toLowerCase().endsWith('.osu'));
  if (osuEntries.length === 0) return null;

  let matchedBytes: Uint8Array | null = null;
  if (targetHash !== '') {
    for (const [, bytes] of osuEntries) {
      if (md5(bytes) === targetHash) { matchedBytes = bytes; break; }
    }
  }
  if (matchedBytes === null) matchedBytes = osuEntries[0]![1];

  const osuText    = new TextDecoder('utf-8').decode(matchedBytes);
  const bgFilename = extractBackgroundFilename(osuText).toLowerCase();
  if (bgFilename === '') return null;

  const bgBytes = byName.get(bgFilename);
  if (bgBytes === undefined) return null;

  try {
    const isJpg = bgFilename.endsWith('.jpg') || bgFilename.endsWith('.jpeg');
    // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
    const blob  = new Blob([bgBytes as Uint8Array<ArrayBuffer>], { type: isJpg ? 'image/jpeg' : 'image/png' });
    return await createImageBitmap(blob);
  } catch (err) {
    console.warn('extractBeatmapBackground: could not decode background image:', err);
    return null;
  }
}
