/**
 * Storyboard easing curves — `osu.Framework/Graphics/Transforms/DefaultEasingFunction.cs`.
 * The storyboard integer is cast straight to the `Easing` enum, so the case index below IS the
 * value written in the file; anything outside 0..35 falls through to linear.
 */

const PI = Math.PI;
const elastic_const = 2 * PI / 0.3;
const elastic_const2 = 0.3 / 4;
const back_const = 1.70158;
const back_const2 = back_const * 1.525;
const bounce_const = 1 / 2.75;
const expo_offset = 2 ** -10;
const elastic_offset_full = 2 ** -11;
const elastic_offset_half = 2 ** -10 * Math.sin((0.5 - elastic_const2) * elastic_const);
const elastic_offset_quarter = 2 ** -10 * Math.sin((0.25 - elastic_const2) * elastic_const);
const in_out_elastic_offset = 2 ** -10 * Math.sin((1 - elastic_const2 * 1.5) * elastic_const / 1.5);

function outBounce(t: number): number {
  if (t < bounce_const) return 7.5625 * t * t;
  if (t < 2 * bounce_const) { t -= 1.5 * bounce_const; return 7.5625 * t * t + 0.75; }
  if (t < 2.5 * bounce_const) { t -= 2.25 * bounce_const; return 7.5625 * t * t + 0.9375; }
  t -= 2.625 * bounce_const;
  return 7.5625 * t * t + 0.984375;
}

/** Map normalised progress `t` (0..1) through storyboard easing `easing`. */
export function applyEasing(easing: number, t: number): number {
  switch (easing) {
    default: return t;                                                        // None / unknown
    case 1: case 4: return t * (2 - t);                                       // Out, OutQuad
    case 2: case 3: return t * t;                                             // In, InQuad
    case 5: return t < 0.5 ? t * t * 2 : (t - 1) * (t - 1) * -2 + 1;          // InOutQuad
    case 6: return t * t * t;                                                 // InCubic
    case 7: t -= 1; return t * t * t + 1;                                     // OutCubic
    case 8: if (t < 0.5) return t * t * t * 4; t -= 1; return t * t * t * 4 + 1;               // InOutCubic
    case 9: return t * t * t * t;                                             // InQuart
    case 10: t -= 1; return 1 - t * t * t * t;                                // OutQuart
    case 11: if (t < 0.5) return t * t * t * t * 8; t -= 1; return t * t * t * t * -8 + 1;     // InOutQuart
    case 12: return t * t * t * t * t;                                        // InQuint
    case 13: t -= 1; return t * t * t * t * t + 1;                            // OutQuint
    case 14: if (t < 0.5) return t * t * t * t * t * 16; t -= 1; return t * t * t * t * t * 16 + 1; // InOutQuint
    case 15: return 1 - Math.cos(t * PI * 0.5);                               // InSine
    case 16: return Math.sin(t * PI * 0.5);                                   // OutSine
    case 17: return 0.5 - 0.5 * Math.cos(PI * t);                             // InOutSine
    case 18: return 2 ** (10 * (t - 1)) + expo_offset * (t - 1);              // InExpo
    case 19: return -(2 ** (-10 * t)) + 1 + expo_offset * t;                  // OutExpo
    case 20: return t < 0.5                                                   // InOutExpo
      ? 0.5 * (2 ** (20 * t - 10) + expo_offset * (2 * t - 1))
      : 1 - 0.5 * (2 ** (-20 * t + 10) + expo_offset * (-2 * t + 1));
    case 21: return 1 - Math.sqrt(1 - t * t);                                 // InCirc
    case 22: t -= 1; return Math.sqrt(1 - t * t);                             // OutCirc
    case 23: t *= 2; if (t < 1) return 0.5 - 0.5 * Math.sqrt(1 - t * t); t -= 2; return 0.5 * Math.sqrt(1 - t * t) + 0.5; // InOutCirc
    case 24: return -(2 ** (-10 + 10 * t)) * Math.sin((1 - elastic_const2 - t) * elastic_const) + elastic_offset_full * (1 - t);  // InElastic
    case 25: return 2 ** (-10 * t) * Math.sin((t - elastic_const2) * elastic_const) + 1 - elastic_offset_full * t;                // OutElastic
    case 26: return 2 ** (-10 * t) * Math.sin((0.5 * t - elastic_const2) * elastic_const) + 1 - elastic_offset_half * t;          // OutElasticHalf
    case 27: return 2 ** (-10 * t) * Math.sin((0.25 * t - elastic_const2) * elastic_const) + 1 - elastic_offset_quarter * t;      // OutElasticQuarter
    case 28:                                                                  // InOutElastic
      t *= 2;
      if (t < 1) return -0.5 * (2 ** (-10 + 10 * t) * Math.sin((1 - elastic_const2 * 1.5 - t) * elastic_const / 1.5) - in_out_elastic_offset * (1 - t));
      t -= 1;
      return 0.5 * (2 ** (-10 * t) * Math.sin((t - elastic_const2 * 1.5) * elastic_const / 1.5) - in_out_elastic_offset * t) + 1;
    case 29: return t * t * ((back_const + 1) * t - back_const);              // InBack
    case 30: t -= 1; return t * t * ((back_const + 1) * t + back_const) + 1;  // OutBack
    case 31:                                                                  // InOutBack
      t *= 2;
      if (t < 1) return 0.5 * t * t * ((back_const2 + 1) * t - back_const2);
      t -= 2;
      return 0.5 * (t * t * ((back_const2 + 1) * t + back_const2) + 2);
    case 32: return 1 - outBounce(1 - t);                                     // InBounce
    case 33: return outBounce(t);                                             // OutBounce
    case 34: return t < 0.5 ? 0.5 - 0.5 * outBounce(1 - t * 2) : outBounce((t - 0.5) * 2) * 0.5 + 0.5; // InOutBounce
    case 35: t -= 1; return t * Math.pow(t, 10) + 1;                          // OutPow10
  }
}
