/**
 * Beatmap video through an `HTMLVideoElement`: the browser demuxes and decodes (hardware where
 * it can), we draw the element's current frame and keep its clock within a small tolerance of
 * the map clock. Needs a DOM, so this is a factory a host calls explicitly; the module itself
 * loads anywhere.
 */

import type { StoryboardData } from './types.js';
import type { VideoFrameSource } from './VideoFrameSource.js';

/** Containers no browser can demux; the file is skipped without a probe. */
const UNPLAYABLE_EXTENSIONS = new Set(['.avi', '.flv', '.wmv', '.mpg']);

/** Why a beatmap video will or will not play, decided before any decoding. */
export type VideoStatus =
  /** A file the browser may be able to play was attached (decode failure surfaces as `VideoFrameSource.failed`). */
  | { kind: 'playable' }
  /** The storyboard has no `Video` event. */
  | { kind: 'none' }
  /** A `Video` event exists but its file's bytes were not loaded (not requested, stripped from the archive, or missing). */
  | { kind: 'not-loaded' }
  /** The file's container (`.avi`, `.flv`, `.wmv`, `.mpg`) cannot be played by any browser. */
  | { kind: 'unsupported'; ext: string };

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

/** Classify a storyboard's video against the bytes that were loaded for it. */
export function probeVideoSupport(data: StoryboardData | null, video: { path: string; bytes: Uint8Array } | null): VideoStatus {
  const event = data?.layers.flatMap(l => l.elements).find(e => e.kind === 'video');
  if (event === undefined) return { kind: 'none' };
  const ext = extensionOf(video?.path ?? event.path);
  if (UNPLAYABLE_EXTENSIONS.has(ext)) return { kind: 'unsupported', ext };
  if (video === null) return { kind: 'not-loaded' };
  return { kind: 'playable' };
}

/** When the element's clock has drifted this far from the map clock during playback, seek it back. */
const RESYNC_MS = 100;
/** While paused, seeks smaller than a frame are skipped (scrubbing sends one every pointer move). */
const PAUSED_SEEK_MS = 16;

class VideoElementSource implements VideoFrameSource {
  durationMs: number | null = null;
  frameWidth = 0;
  frameHeight = 0;
  failed = false;
  private readonly el: HTMLVideoElement;
  private readonly url: string;
  private seeking = false;
  private pendingSeekMs: number | null = null;
  private rate = 1;
  private disposed = false;

  constructor(bytes: Uint8Array, mime: string) {
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    // A copy: the archive's view may sit in a larger buffer, and the blob must outlive it anyway.
    this.url = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
    el.addEventListener('loadedmetadata', () => {
      this.durationMs = el.duration * 1000;
      this.frameWidth = el.videoWidth;
      this.frameHeight = el.videoHeight;
    });
    el.addEventListener('error', () => { this.failed = true; });
    el.addEventListener('seeked', () => {
      this.seeking = false;
      if (this.pendingSeekMs !== null) {
        const t = this.pendingSeekMs;
        this.pendingSeekMs = null;
        this.seekTo(t);
      }
    });
    el.src = this.url;
    this.el = el;
  }

  frameAt(videoMs: number): CanvasImageSource | null {
    const dur = this.durationMs;
    if (this.failed || dur === null || videoMs < 0 || videoMs > dur) return null;
    // HAVE_CURRENT_DATA: a frame is available to paint.
    return this.el.readyState >= 2 ? this.el : null;
  }

  sync({ videoMs, playing, rate }: { videoMs: number; playing: boolean; rate: number }): void {
    const el = this.el, dur = this.durationMs;
    if (this.disposed || this.failed || dur === null) return;
    const inRange = videoMs >= 0 && videoMs <= dur;
    const target = Math.max(0, Math.min(dur, videoMs));
    const drift = el.currentTime * 1000 - target;
    if (playing && inRange) {
      if (rate !== this.rate) {
        this.rate = rate;
        try { el.playbackRate = rate; } catch { /* outside the browser's supported range: play at the previous rate */ }
      }
      if (Math.abs(drift) > RESYNC_MS) this.seekTo(target);
      if (el.paused) el.play().catch(() => { /* interrupted by a pause() before it started: harmless */ });
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(drift) > PAUSED_SEEK_MS) this.seekTo(target);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    URL.revokeObjectURL(this.url);
  }

  /** One seek in flight at a time; a newer target replaces the queued one. */
  private seekTo(ms: number): void {
    if (this.seeking) { this.pendingSeekMs = ms; return; }
    this.seeking = true;
    this.el.currentTime = ms / 1000;
  }
}

function mimeFor(path: string): string {
  switch (extensionOf(path)) {
    case '.mov': return 'video/quicktime';
    default: return 'video/mp4';
  }
}

/**
 * Play a beatmap video file through a `<video>` element (main thread only). Returns null
 * where there is no DOM, e.g. inside a worker; the caller then draws no video.
 */
export function createVideoElementSource(video: { path: string; bytes: Uint8Array }): VideoFrameSource | null {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return new VideoElementSource(video.bytes, mimeFor(video.path));
}
