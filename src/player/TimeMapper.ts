import type { ReplayFrame } from '../types/index';

/**
 * Maps presentation (real/wall-clock) time to beatmap time for a replay, accounting for
 * intro/outro trim and mod speed. All values are ms. `mapDurationMs` is the summed frame
 * deltas (beatmap time); `presentationDurationMs` is the trimmed duration divided by
 * `speed`, floored at 1000ms. Trim offsets derive from beatmap note times (not frame
 * deltas) so `presentationDurationMs` is always positive. A negative intro offset starts
 * presentation before map time 0 (a storyboard intro), lengthening the timeline instead.
 */
export class TimeMapper {
  readonly introOffsetMs: number;
  readonly outroOffsetMs: number;
  readonly mapDurationMs: number;
  readonly speed: number;
  readonly presentationDurationMs: number;

  constructor(frames: ReplayFrame[], introOffsetMs = 0, outroOffsetMs = 0, speed = 1) {
    let cumTime = 0;
    for (const frame of frames) {
      if (frame.timeDelta >= 0) cumTime += frame.timeDelta;
    }

    this.mapDurationMs = cumTime;
    this.speed = speed;

    const maxTrim = Math.max(0, cumTime - 1000);
    this.introOffsetMs  = Math.min(introOffsetMs, maxTrim);
    this.outroOffsetMs  = Math.max(0, Math.min(outroOffsetMs, maxTrim - this.introOffsetMs));
    this.presentationDurationMs = Math.max(1000,
      (cumTime - this.introOffsetMs - this.outroOffsetMs) / speed);
  }

  /**
   * Convert presentation (real) time → beatmap time.
   * With speed mods, beatmap time advances faster than real time.
   */
  toMapTime(presentationMs: number): number {
    return presentationMs * this.speed + this.introOffsetMs;
  }
}
