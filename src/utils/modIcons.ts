import type { LazerMod } from '../types/index';

/**
 * Lazer mod category. Selects the badge colour of the default (non-skin) mod icon,
 * matching osu!'s `OsuColour.ForModType`.
 */
export type ModType =
  | 'DifficultyReduction' | 'DifficultyIncrease' | 'Automation'
  | 'Conversion' | 'Fun' | 'System';

/** Badge colour per category (osu! `OsuColour.ForModType`). */
export const MOD_TYPE_COLOUR: Readonly<Record<ModType, string>> = {
  DifficultyReduction: '#b2ff66',
  DifficultyIncrease:  '#ff6666',
  Automation:          '#66ccff',
  Conversion:          '#8c66ff',
  Fun:                 '#ff66ab',
  System:              '#ffcc22',
};

/** How one mod is identified and drawn in the HUD mod-icon row. */
export interface ModIconSpec {
  /** Lazer acronym; also the label of the last-resort text fallback. */
  readonly acronym: string;
  /** Stable mod bitmask bit. */
  readonly bit?: number;
  /** Legacy skin sprite stem (`selection-mod-<stem>.png`).*/
  readonly stem?: string;
  /**
   * osu! default glyph basename (`Icons/Mods/<glyph>.png` in ppy/osu-resources). Listed only
   * for mods whose glyph ships in the lazer-defaults directory; see `loadLazerDefaultModIcons`.
   */
  readonly glyph?: string;
  readonly type: ModType;
}

/** Every mod the HUD can show, in display order. */
export const MOD_ICON_SPECS: readonly ModIconSpec[] = [
  { acronym: 'NF', bit: 1 << 0,  stem: 'nofail',      type: 'DifficultyReduction' },
  { acronym: 'EZ', bit: 1 << 1,  stem: 'easy',        type: 'DifficultyReduction' },
  { acronym: 'HD', bit: 1 << 3,  stem: 'hidden',      type: 'DifficultyIncrease' },
  { acronym: 'HR', bit: 1 << 4,  stem: 'hardrock',    type: 'DifficultyIncrease' },
  { acronym: 'SD', bit: 1 << 5,  stem: 'suddendeath', type: 'DifficultyIncrease' },
  { acronym: 'PF', bit: 1 << 14, stem: 'perfect',     glyph: 'mod-perfect', type: 'DifficultyIncrease' },
  { acronym: 'DT', bit: 1 << 6,  stem: 'doubletime',  glyph: 'mod-double-time', type: 'DifficultyIncrease' },
  { acronym: 'NC', bit: 1 << 9,  stem: 'nightcore',   glyph: 'mod-nightcore',   type: 'DifficultyIncrease' },
  { acronym: 'HT', bit: 1 << 8,  stem: 'halftime',    glyph: 'mod-half-time',   type: 'DifficultyReduction' },
  { acronym: 'DC',               glyph: 'mod-daycore', type: 'DifficultyReduction' },
  { acronym: 'RX', bit: 1 << 7,  stem: 'relax',       type: 'Automation' },
  { acronym: 'FL', bit: 1 << 10, stem: 'flashlight',  type: 'DifficultyIncrease' },
  { acronym: 'SO', bit: 1 << 12, stem: 'spunout',     type: 'Automation' },
  { acronym: 'CL',               glyph: 'mod-classic',            type: 'Conversion' },
  { acronym: 'DA',               glyph: 'mod-difficulty-adjust',  type: 'Conversion' },
  { acronym: 'AC',               glyph: 'mod-accuracy-challenge', type: 'DifficultyIncrease' },
  // Mania: FadeIn = 1<<20, Mirror = 1<<30 in the stable Mods enum; Cover is lazer-only.
  { acronym: 'FI', bit: 1 << 20, stem: 'fadein',      glyph: 'mod-fade-in', type: 'DifficultyIncrease' },
  { acronym: 'MR', bit: 1 << 30, stem: 'mirror',      glyph: 'mod-mirror',  type: 'Conversion' },
  { acronym: 'CO',               glyph: 'mod-cover',  type: 'DifficultyIncrease' },
];

// Default `speed_change` per rate mod; lazer omits the suffix at the default rate.
const DEFAULT_RATE: Readonly<Record<string, number>> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

// DA difficulty settings in lazer's precedence order (osu!std's DA checks all four; taiko /
// mania DA only have OD + HP, so the others never appear in their settings).
const DA_SETTINGS: readonly [key: string, label: string][] = [
  ['circle_size', 'CS'], ['approach_rate', 'AR'], ['overall_difficulty', 'OD'], ['drain_rate', 'HP'],
];

/**
 * The text lazer appends to a mod's icon (`Mod.ExtendedIconInformation`), or `''`: rate mods
 * at a non-default `speed_change` show `1.25x`; DA shows the one changed setting (`AR10`,
 * `CS4.5`) and nothing when zero or several changed. Settings absent from the replay are at
 * their defaults.
 */
export function extendedModIconInfo(mod: LazerMod): string {
  const s = mod.settings;
  if (s === undefined) return '';
  const defaultRate = DEFAULT_RATE[mod.acronym];
  if (defaultRate !== undefined) {
    const rate = s['speed_change'];
    return typeof rate === 'number' && rate !== defaultRate ? `${rate.toFixed(2)}x` : '';
  }
  if (mod.acronym === 'DA') {
    const changed = DA_SETTINGS.filter(([key]) => typeof s[key] === 'number');
    if (changed.length !== 1) return '';
    const [key, label] = changed[0]!;
    // osu-framework's ToStandardFormattedString(1): at most one decimal, no trailing zero.
    const value = s[key] as number;
    return `${label}${(Math.round(value * 10) / 10).toString()}`;
  }
  return '';
}

/**
 * osu!'s default mod-icon textures (ppy/osu-resources `Textures/Icons/`), decoded but not yet
 * composed: the white badge (`BeatmapDetails/mod-icon`), the extension strip drawn behind the
 * badge when a mod has extended info (`BeatmapDetails/mod-icon-extender`), and the monochrome
 * glyphs (`Mods/mod-<name>`) keyed by acronym. See `loadLazerDefaultModIcons`.
 */
export interface LazerModIconTextures {
  readonly badge: ImageBitmap;
  readonly extender: ImageBitmap | null;
  readonly glyphs: ReadonlyMap<string, ImageBitmap>;
}

// Multiply a hex colour's channels by `k` (osu-framework's Darken(a) is k = 1 / (1 + a)).
function scaleColour(hex: string, k: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

// Keeps the source's alpha, replaces its colour (the textures are white-on-transparent).
function tinted(src: ImageBitmap, colour: string): OffscreenCanvas {
  const osc = new OffscreenCanvas(src.width, src.height);
  const oc = osc.getContext('2d')!;
  oc.drawImage(src, 0, 0);
  oc.globalCompositeOperation = 'source-in';
  oc.fillStyle = colour;
  oc.fillRect(0, 0, src.width, src.height);
  return osc;
}

// osu!'s ModIcon lays out an 80-unit-tall icon; the badge (135×100) aspect-fits to 80 wide.
// Everything below is in badge-native pixels, i.e. lazer units × (135 / 80).
const UNIT = 135 / 80;
// Extended content: a 116×80-unit box at x = 80 − 22 (the badge overlaps its left 22 units)
// holding the extender aspect-fit to its width and the text centred 6 units right of centre.
const EXT_X = (80 - 22) * UNIT;
const EXT_W = 116 * UNIT;
const EXT_TEXT_DX = 6 * UNIT;
// lazer draws the text at OsuFont size 34 (≈ 24-unit cap height); a 46px sans-serif em on the
// 100px badge gives about the same cap height.
const EXT_FONT_PX = 46;

/**
 * Compose one of osu!'s default mod icons the way lazer's `ModIcon` does: badge tinted with
 * the category colour, glyph (aspect-fit to the same square, so it spans the badge width)
 * drawn 10% of the way from black toward that colour. With `extended` text (and an extender
 * texture) the icon grows to the right: a strip in the colour darkened ×1/3.8 behind the
 * badge, carrying the text in the category colour.
 */
export function composeModIcon(
  textures: LazerModIconTextures,
  spec: ModIconSpec,
  extended: string = '',
): ImageBitmap | undefined {
  const glyph = textures.glyphs.get(spec.acronym);
  if (glyph === undefined) return undefined;
  const colour = MOD_TYPE_COLOUR[spec.type];
  const { badge, extender } = textures;
  const withExt = extended !== '' && extender !== null;

  const width = withExt ? Math.round(EXT_X + EXT_W) : badge.width;
  const osc = new OffscreenCanvas(width, badge.height);
  const oc = osc.getContext('2d')!;

  if (withExt) {
    const extH = extender.height * (EXT_W / extender.width);
    oc.drawImage(tinted(extender, scaleColour(colour, 1 / 3.8)), EXT_X, (badge.height - extH) / 2, EXT_W, extH);
    oc.font = `bold ${EXT_FONT_PX}px sans-serif`;
    oc.textAlign = 'center';
    oc.textBaseline = 'middle';
    oc.fillStyle = colour;
    oc.fillText(extended, EXT_X + EXT_W / 2 + EXT_TEXT_DX, badge.height / 2, EXT_W - 22 * UNIT - 8);
  }
  oc.drawImage(tinted(badge, colour), 0, 0);
  const gh = glyph.height * (badge.width / glyph.width);
  oc.drawImage(tinted(glyph, scaleColour(colour, 0.1)), 0, (badge.height - gh) / 2, badge.width, gh);
  return osc.transferToImageBitmap();
}

/**
 * Acronyms of the mods to show for a score, in `MOD_ICON_SPECS` order. Lazer replays are
 * read from their acronym list (mods with no stable bit — CL, DA, AC, CO, DC — only exist
 * there); stable replays from the bitmask. NC implies DT and PF implies SD in the stable
 * bitmask, so DT is hidden under NC and SD under PF.
 */
export function activeModAcronyms(mods: number, lazerMods?: readonly LazerMod[]): string[] {
  const active = new Set<string>();
  if (lazerMods !== undefined && lazerMods.length > 0) {
    for (const mod of lazerMods) active.add(mod.acronym);
  } else {
    for (const spec of MOD_ICON_SPECS) {
      if (spec.bit !== undefined && (mods & spec.bit) !== 0) active.add(spec.acronym);
    }
  }
  if (active.has('NC')) active.delete('DT');
  if (active.has('PF')) active.delete('SD');
  const out: string[] = [];
  for (const spec of MOD_ICON_SPECS) if (active.has(spec.acronym)) out.push(spec.acronym);
  return out;
}
