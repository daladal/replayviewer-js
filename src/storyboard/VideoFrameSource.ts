/**
 * The seam between the storyboard renderer and whatever decodes the beatmap video. The
 * renderer only needs "the frame for video time t" plus a per-frame clock hint; how frames are
 * produced (a `<video>` element on the main thread, a WebCodecs pump in a worker) is the
 * implementation's business. Video time is milliseconds since the video's own start, i.e.
 * map time minus the `Video` event's offset.
 */
export interface VideoFrameSource {
  /** Container duration in ms, or null until the source knows it. Drives the fade-out. */
  readonly durationMs: number | null;
  /** Native frame size in px (0 until known). Cover-fit uses the aspect. */
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** True once the source has given up (undecodable file); `frameAt` is then always null. */
  readonly failed: boolean;
  /**
   * The frame to draw for video time `videoMs`, or null when nothing is available (not decoded
   * yet, out of range, failed). Synchronous: called from the renderer's draw.
   */
  frameAt(videoMs: number): CanvasImageSource | null;
  /**
   * Clock hint, called once per drawn frame: where the map clock is in video time, whether it
   * is advancing, and how fast relative to real time (mod speed × user rate). Sources that own
   * a clock of their own (a `<video>` element) use it to stay in step.
   */
  sync(state: { videoMs: number; playing: boolean; rate: number }): void;
  /**
   * Optional, for sources that decode on demand (frame-exact export): make the frame for
   * `videoMs` available so the next `frameAt(videoMs)` returns it synchronously. Times only
   * move forward between calls.
   */
  prepare?(videoMs: number): Promise<void>;
  /** Release the decoder / object URL. Not reusable afterwards. */
  dispose(): void;
}
