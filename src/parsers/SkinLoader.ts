import { MOD_ICON_SPECS, type LazerModIconTextures } from '../utils/modIcons.js';
import type { SkinAssets, SkinConfig, ManiaSkinSection } from '../types/index.js';
import { unzipAsync } from './BeatmapSetLoader.js';

function rgbaFromCsv(val: string): string | undefined {
  const parts = val.split(',').map(p => parseInt(p.trim(), 10));
  if (parts.length < 3) return undefined;
  const [r, g, b] = parts as [number, number, number];
  const a = parts.length >= 4 ? parts[3]! : 255;
  if ([r, g, b, a].some(v => Number.isNaN(v))) return undefined;
  const hex = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

function rgbFromCsv(val: string): string | undefined {
  const parts = val.split(',').map(p => parseInt(p.trim(), 10));
  if (parts.length < 3) return undefined;
  const [r, g, b] = parts as [number, number, number];
  if ([r, g, b].some(v => Number.isNaN(v))) return undefined;
  const hex = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function parseNumberList(val: string): number[] {
  // Stable behaviour (see ppy/osu issue #26464): malformed entries read as 0.
  return val.split(',').map(p => {
    const n = parseFloat(p.trim());
    return Number.isFinite(n) ? n : 0;
  });
}

function freshManiaSection(): ManiaSkinSection {
  return {
    keys: 0,
    imageLookups: {},
    colours: [],
    coloursLight: [],
  };
}

function applyManiaKey(s: ManiaSkinSection, key: string, val: string): void {
  // Image lookups have to be matched precisely — a generic `^(Hit|Stage|...)` prefix
  // greedily eats `HitPosition`, `StagePaddingTop`/`StagePaddingBottom`, etc. and
  // would short-circuit the numeric branches below. Only the keys consumers actually
  // read are stored:
  //   - NoteImage{N}, NoteImage{N}H/T/L  (per-column, 0-based)
  //   - KeyImage{N}, KeyImage{N}D        (per-column, 0-based)
  //   - StageHint, StageLight
  //   - LightingN, LightingL             (hit-explosion / hold-light overrides)
  // Both key and value are lowercased so consumers can do case-insensitive lookups.
  // Storing LightingN/L is what lets a skin's explicit `blank` (a 1×1 sentinel)
  // suppress the explosion/hold-light instead of us falling back to a default —
  // matching osu!, where the skin's value wins over the `lightingN`/`lightingL`
  // fallback filename.
  if (
    /^(NoteImage|KeyImage)\d+/i.test(key) ||
    /^Stage(Hint|Light)$/i.test(key) ||
    /^Lighting[NL]$/i.test(key)
  ) {
    s.imageLookups[key.toLowerCase()] = val.replace(/\\/g, '/').toLowerCase();
    return;
  }

  // Per-column colour entries: 1-based in ini → 0-based here.
  const colourM      = /^Colour(\d+)$/i.exec(key);
  const colourLightM = /^ColourLight(\d+)$/i.exec(key);
  if (colourM) {
    const idx = parseInt(colourM[1]!, 10) - 1;
    if (idx >= 0) {
      const c = rgbaFromCsv(val);
      if (c !== undefined) s.colours[idx] = c;
    }
    return;
  }
  if (colourLightM) {
    const idx = parseInt(colourLightM[1]!, 10) - 1;
    if (idx >= 0) {
      const c = rgbaFromCsv(val);
      if (c !== undefined) s.coloursLight[idx] = c;
    }
    return;
  }

  if (/^ColourColumnLine$/i.test(key))   { const c = rgbaFromCsv(val); if (c) s.colourColumnLine = c; return; }
  if (/^JudgementLineColour$/i.test(key)){ const c = rgbaFromCsv(val); if (c) s.judgementLineColour = c; return; }

  if (/^HitPosition$/i.test(key))            { const n = parseFloat(val); if (Number.isFinite(n)) s.hitPosition = n; return; }
  if (/^ColumnWidth$/i.test(key))            { s.columnWidth      = parseNumberList(val); return; }
  if (/^ColumnSpacing$/i.test(key))          { s.columnSpacing    = parseNumberList(val); return; }
  if (/^ColumnLineWidth$/i.test(key))        { s.columnLineWidth  = parseNumberList(val); return; }
  if (/^BarlineHeight$/i.test(key))          { const n = parseFloat(val); if (Number.isFinite(n)) s.barlineHeight = n; return; }
  if (/^JudgementLine$/i.test(key))          { s.judgementLine = /^(1|true|yes)$/i.test(val.trim()); return; }
  if (/^KeysUnderNotes$/i.test(key))         { s.keysUnderNotes = /^(1|true|yes)$/i.test(val.trim()); return; }
  if (/^UpsideDown$/i.test(key))             { s.upsideDown = /^(1|true|yes)$/i.test(val.trim()); return; }
  if (/^LightPosition$/i.test(key))          { const n = parseFloat(val); if (Number.isFinite(n)) s.lightPosition = n; return; }
  if (/^ScorePosition$/i.test(key))          { const n = parseFloat(val); if (Number.isFinite(n)) s.scorePosition = n; return; }
  if (/^ComboPosition$/i.test(key))          { const n = parseFloat(val); if (Number.isFinite(n)) s.comboPosition = n; return; }
  if (/^NoteBodyStyle$/i.test(key))          {
    const n = parseInt(val, 10);
    if (n === 0 || n === 2 || n === 3 || n === 4) s.noteBodyStyle = n;
    return;
  }
  if (/^WidthForNoteHeightScale$/i.test(key)) { const n = parseFloat(val); if (Number.isFinite(n)) s.widthForNoteHeightScale = n; return; }
  if (/^LightFramePerSecond$/i.test(key))    { const n = parseFloat(val); if (Number.isFinite(n)) s.lightFramePerSecond = n; return; }
}

function parseSkinIni(text: string): SkinConfig {
  const sparse: (string | undefined)[] = [];
  let hitCircleOverlap = -2;
  let hitCirclePrefix = 'default';
  let scorePrefix = 'score';
  // osu!stable defaults combo sprites to score-*.
  let comboPrefix = 'score';
  let sliderBorder = '#ffffff';
  let sliderTrackOverride: string | null = null;
  let allowSliderBallTint = false;
  let name = '';
  // empty == unspecified; osu!stable treats as '1.0'
  let version = '';
  let section = '';

  const parseBool = (val: string): boolean => {
    const v = val.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  };

  const normalizePrefix = (val: string): string =>
    val.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  // Mania sections: skin.ini can declare any number of [Mania] blocks, one per
  // key count. We collect properties into `currentMania` and commit it whenever
  // a new section starts or EOF is reached. Per ppy/osu's LegacyManiaSkinDecoder,
  // sections without a positive `Keys: N` are dropped (no useful lookup).
  const maniaSections: ManiaSkinSection[] = [];
  let currentMania: ManiaSkinSection | null = null;
  const commitMania = (): void => {
    if (currentMania !== null && currentMania.keys > 0) {
      maniaSections.push(currentMania);
    }
    currentMania = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//')) continue;

    if (line.startsWith('[')) {
      commitMania();
      section = line.toLowerCase();
      if (section === '[mania]') currentMania = freshManiaSection();
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();

    if (section === '[general]') {
      if (/^Name$/i.test(key)) name = val;
      else if (/^Version$/i.test(key)) version = val;
      else if (/^AllowSliderBallTint$/i.test(key)) allowSliderBallTint = parseBool(val);
    } else if (section === '[colours]') {
      const comboMatch = /^Combo(\d+)$/i.exec(key);
      if (comboMatch) {
        const idx = parseInt(comboMatch[1]!, 10) - 1;
        const c = rgbFromCsv(val);
        if (c !== undefined) sparse[idx] = c;
      } else if (/^SliderBorder$/i.test(key)) {
        const c = rgbFromCsv(val);
        if (c !== undefined) sliderBorder = c;
      } else if (/^SliderTrackOverride$/i.test(key)) {
        const c = rgbFromCsv(val);
        if (c !== undefined) sliderTrackOverride = c;
      }
    } else if (section === '[fonts]') {
      if (/^HitCircleOverlap$/i.test(key)) {
        const parsed = parseInt(val, 10);
        if (!isNaN(parsed)) hitCircleOverlap = parsed;
      } else if (/^HitCirclePrefix$/i.test(key) && val !== '') {
        hitCirclePrefix = normalizePrefix(val);
      } else if (/^ScorePrefix$/i.test(key) && val !== '') {
        scorePrefix = normalizePrefix(val);
      } else if (/^ComboPrefix$/i.test(key) && val !== '') {
        comboPrefix = normalizePrefix(val);
      }
    } else if (section === '[mania]' && currentMania !== null) {
      if (/^Keys$/i.test(key)) {
        const n = parseInt(val, 10);
        if (Number.isFinite(n) && n > 0) currentMania.keys = n;
      } else {
        applyManiaKey(currentMania, key, val);
      }
    }
  }
  commitMania();

  const comboColors = sparse.filter((c): c is string => c !== undefined);
  return {
    comboColors,
    hitCircleOverlap,
    hitCirclePrefix,
    scorePrefix,
    comboPrefix,
    sliderBorder,
    sliderTrackOverride,
    allowSliderBallTint,
    name,
    version,
    maniaSections,
  };
}

// Bounded-concurrency runner for the skin decode burst (see decodeSkinEntries).
// createImageBitmap / decodeAudioData are dispatched to a small browser-internal
// decode pool, so firing all 100+ of a skin's images at once gains no throughput —
// it only spikes GPU/RAM and, in Firefox, intermittently rejects with a bare
// InvalidStateError ("...object that is not, or is no longer, usable"). Capping the
// in-flight work keeps near-peak throughput without that failure window.
const DECODE_CONCURRENCY = 12;

/**
 * Run async tasks through a bounded pool. Browser image/audio decoders are themselves a small
 * internal pool, so firing hundreds at once only spikes GPU/RAM (and intermittently rejects in
 * Firefox); shared by the skin and storyboard decoders.
 */
export async function runPooled(tasks: ReadonlyArray<() => Promise<void>>): Promise<void> {
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await task();
    }
  };
  const width = Math.min(DECODE_CONCURRENCY, tasks.length);
  await Promise.all(Array.from({ length: width }, runner));
}

async function decodeSkinEntries(
  entries: Record<string, Uint8Array>,
  audioCtx?: AudioContext,
): Promise<SkinAssets> {
  const images = new Map<string, ImageBitmap>();
  const sounds = new Map<string, AudioBuffer>();
  let config: SkinConfig = {
    comboColors: [],
    hitCircleOverlap: -2,
    hitCirclePrefix: 'default',
    scorePrefix: 'score',
    comboPrefix: 'score',
    sliderBorder: '#ffffff',
    sliderTrackOverride: null,
    allowSliderBallTint: false,
    name: '',
    version: '',
    maniaSections: [],
  };

  // Subfolder paths kept so [Fonts]-prefix renderer lookups (e.g. `fonts/hitcircle/default-0`)
  // don't collide with root-level basenames.
  const normalized: [string, Uint8Array][] = Object.entries(entries).map(
    ([name, bytes]) => [name.replace(/\\/g, '/').toLowerCase(), bytes]
  );

  // Subfolder skin.ini files are leftovers; only the root one is honored.
  const skinIniEntry = normalized.find(([name]) => name === 'skin.ini');
  if (skinIniEntry) {
    const iniText = new TextDecoder('utf-8').decode(skinIniEntry[1]);
    config = parseSkinIni(iniText);
  }

  const imageEntries = normalized.filter(
    ([name]) => name.endsWith('.png') || name.endsWith('.jpg')
  );

  const audioEntries = audioCtx !== undefined
    ? normalized.filter(([name]) => {
        return name.endsWith('.wav') || name.endsWith('.mp3') || name.endsWith('.ogg');
      })
    : [];

  // Each image is guarded individually so one transient/corrupt sprite can't reject
  // the whole skin load (mirrors BeatmapSetLoader's per-asset try/catch) — worst case
  // is a single missing sprite the renderer falls back from, not a failed load.
  const decodeTasks: Array<() => Promise<void>> = [
    ...imageEntries.map(([name, bytes]) => async () => {
      const ext = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
      // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: ext });
      try {
        images.set(name, await createImageBitmap(blob));
      } catch (err) {
        console.warn(`SkinLoader: could not decode image '${name}':`, err);
      }
    }),
    ...audioEntries.map(([name, bytes]) => async () => {
      if (audioCtx === undefined) return;
      try {
        const copy = bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const audioBuf = await audioCtx.decodeAudioData(copy);
        const basename = name.split('/').pop() ?? name;
        sounds.set(basename, audioBuf);
      } catch { /* undecodable */ }
    }),
  ];
  await runPooled(decodeTasks);

  return { images, sounds, config, spinnerImages: new Map() };
}

/**
 * Loads a skin from a zipped archive (`.osk`/`.zip`) buffer: decodes all images and —
 * when `audioCtx` is provided — all sounds, and parses the root `skin.ini`. Asset keys
 * are normalized to lowercase forward-slash paths; sound keys are basenames.
 */
export async function loadSkin(
  buffer: ArrayBuffer,
  audioCtx?: AudioContext,
): Promise<SkinAssets> {
  const files = await unzipAsync(new Uint8Array(buffer));
  return decodeSkinEntries(files, audioCtx);
}

const audioStemOf = (key: string): string => key.replace(/\.(wav|mp3|ogg)$/i, '');

/**
 * Merges two sound maps stem-aware: an overlay sound blocks every base sound sharing
 * its extension-stripped basename. Hitsound lookup walks extensions in a fixed order
 * (`.wav` → `.mp3` → `.ogg`), so a naive key-keyed merge would let a base
 * `soft-hitnormal.wav` survive alongside an overlay `soft-hitnormal.ogg` and win the
 * lookup; displacing the whole stem prevents that.
 */
export function mergeSounds(
  base: ReadonlyMap<string, AudioBuffer>,
  overlay: ReadonlyMap<string, AudioBuffer>,
): Map<string, AudioBuffer> {
  const overlayStems = new Set<string>();
  for (const key of overlay.keys()) overlayStems.add(audioStemOf(key));
  const merged = new Map<string, AudioBuffer>();
  for (const [key, val] of base) {
    if (overlayStems.has(audioStemOf(key))) continue;
    merged.set(key, val);
  }
  for (const [key, val] of overlay) merged.set(key, val);
  return merged;
}

/**
 * Layers `overlay`'s assets over `base`. Any image stem shipped by the overlay
 * (including 1×1 placeholder sprites) blocks all base variants of that stem, so @2x
 * preference can't pull base images through behind a deliberately blanked element.
 * An asset "family" is atomic: if the overlay ships any frame of a family
 * (`stem.png` OR any `stem-N.png`), it fully owns the family — e.g. an overlay's
 * single-file `mania-hit300g.png` blocks the base's animated `mania-hit300g-0/1/2.png`
 * frames (otherwise animation-frame lookup would walk `stem-N` first and play the
 * base's animation despite the override), and in reverse an overlay `mania-hit300g-0.png`
 * blocks the base's bare `mania-hit300g.png`. Sounds merge via `mergeSounds`; the
 * overlay's `skin.ini` config wins outright.
 */
export function mergeSkinAssets(base: SkinAssets, overlay: SkinAssets): SkinAssets {
  const overlayStems = new Set<string>();
  // Family root = stem with any trailing `-\d+` stripped. e.g. `mania-hit300g-2`
  // → `mania-hit300g`, `mania-hit300g` → `mania-hit300g`. Score / combo digit
  // sets (`score-0..9`, `combo-0..9`) are also "families" by this rule — that's
  // intentional: a skin shipping any digit overrides the whole font (lazer's
  // legacy font fallback works the same way per `LegacySkinExtensions`).
  const overlayFamilyRoots = new Set<string>();
  const stemOf = (key: string): string => key.replace(/@2x\.png$|\.png$/i, '').toLowerCase();
  const familyOf = (stem: string): string => stem.replace(/-\d+$/, '');
  for (const key of overlay.images.keys()) {
    const stem = stemOf(key);
    overlayStems.add(stem);
    overlayFamilyRoots.add(familyOf(stem));
  }
  // osu! treats cursor + cursormiddle as one unit: a skin's `cursor.png` IS the
  // full cursor unless the author also ships `cursormiddle.png`. Without this,
  // skins that have their own `cursor` but no `cursormiddle` would inherit the
  // base's middle dot layered on top of their finished cursor art.
  if (overlayStems.has('cursor')) overlayStems.add('cursormiddle');
  const mergedImages = new Map<string, ImageBitmap>();
  for (const [key, val] of base.images) {
    const stem = stemOf(key);
    if (overlayStems.has(stem)) continue;
    if (overlayFamilyRoots.has(familyOf(stem))) continue;
    mergedImages.set(key, val);
  }
  for (const [key, val] of overlay.images) {
    mergedImages.set(key, val);
  }
  return {
    images: mergedImages,
    sounds: mergeSounds(base.sounds, overlay.sounds),
    config: overlay.config,
    spinnerImages: new Map(),
  };
}

// The 12 default hitsound wavs (normal/soft/drum × hitnormal/hitwhistle/hitfinish/hitclap),
// sourced from ppy/osu-resources. Used as the hitsound-cascade fallback below skin lookups.
// The host app must serve them under `baseUrl` (default: `skins/lazer-defaults/` relative
// to the page); a missing/partial directory degrades to the synthesized fallback sounds.
let _lazerDefaultSounds: Map<string, AudioBuffer> | null = null;
let _lazerDefaultLoadInFlight: Promise<Map<string, AudioBuffer>> | null = null;

const LAZER_DEFAULT_STEMS = [
  'normal-hitnormal', 'normal-hitwhistle', 'normal-hitfinish', 'normal-hitclap',
  'soft-hitnormal',   'soft-hitwhistle',   'soft-hitfinish',   'soft-hitclap',
  'drum-hitnormal',   'drum-hitwhistle',   'drum-hitfinish',   'drum-hitclap',
];

/**
 * Loads (once — memoized module-wide, so the first call's `baseUrl` wins) the lazer
 * default hitsound samples from `${baseUrl}/<stem>.wav`. Individual fetch/decode
 * failures are skipped, so the returned map may be partial.
 */
export async function loadLazerDefaultSounds(
  audioCtx: AudioContext,
  baseUrl: string = 'skins/lazer-defaults',
): Promise<Map<string, AudioBuffer>> {
  if (_lazerDefaultSounds !== null) return _lazerDefaultSounds;
  if (_lazerDefaultLoadInFlight !== null) return _lazerDefaultLoadInFlight;
  _lazerDefaultLoadInFlight = (async () => {
    const out = new Map<string, AudioBuffer>();
    await Promise.all(LAZER_DEFAULT_STEMS.map(async stem => {
      try {
        const resp = await fetch(`${baseUrl}/${stem}.wav`);
        if (!resp.ok) return;
        const buf = await resp.arrayBuffer();
        out.set(`${stem}.wav`, await audioCtx.decodeAudioData(buf));
      } catch { /* network / decode failure — synth still backs up the resolver. */ }
    }));
    _lazerDefaultSounds = out;
    return out;
  })();
  return _lazerDefaultLoadInFlight;
}

// osu!'s default mod-icon textures (see `LazerModIconTextures`), served by the host app under
// `${baseUrl}/mods/`: `mod-icon.png`, `mod-icon-extender.png`, and the `mod-<name>.png` glyphs
// named in `MOD_ICON_SPECS`. Missing glyphs just leave those mods on the text fallback.
let _lazerDefaultModIcons: LazerModIconTextures | null = null;
let _lazerDefaultModIconLoadInFlight: Promise<LazerModIconTextures | null> | null = null;

/**
 * Loads (once — memoized module-wide, so the first call's `baseUrl` wins) osu!'s default
 * mod-icon textures from `${baseUrl}/mods/`. Returns null when the badge is missing;
 * otherwise the glyph map may be partial (fetch/decode failures are skipped). The HUD
 * composes them per session (`composeModIcon`) for mods the skin has no sprite for and for
 * mods carrying extended info such as a custom rate.
 */
export async function loadLazerDefaultModIcons(
  baseUrl: string = 'skins/lazer-defaults',
): Promise<LazerModIconTextures | null> {
  if (_lazerDefaultModIcons !== null) return _lazerDefaultModIcons;
  if (_lazerDefaultModIconLoadInFlight !== null) return _lazerDefaultModIconLoadInFlight;
  _lazerDefaultModIconLoadInFlight = (async () => {
    const fetchBitmap = async (name: string): Promise<ImageBitmap | null> => {
      try {
        const resp = await fetch(`${baseUrl}/mods/${name}.png`);
        if (!resp.ok) return null;
        return await createImageBitmap(await resp.blob());
      } catch {
        return null;
      }
    };
    const [badge, extender] = await Promise.all([fetchBitmap('mod-icon'), fetchBitmap('mod-icon-extender')]);
    if (badge === null) return null;
    const glyphs = new Map<string, ImageBitmap>();
    await Promise.all(MOD_ICON_SPECS.map(async spec => {
      if (spec.glyph === undefined) return;
      const glyph = await fetchBitmap(spec.glyph);
      if (glyph !== null) glyphs.set(spec.acronym, glyph);
    }));
    _lazerDefaultModIcons = { badge, extender, glyphs };
    return _lazerDefaultModIcons;
  })();
  return _lazerDefaultModIconLoadInFlight;
}

/**
 * Loads a skin from a static directory of pre-extracted files. Expects
 * `${baseUrl}/index.json` of shape `{ files: string[] }` listing every file path in
 * the skin; files that fail to fetch are skipped.
 */
export async function loadSkinFromDir(
  baseUrl: string,
  audioCtx?: AudioContext,
): Promise<SkinAssets> {
  const indexResp = await fetch(`${baseUrl}/index.json`);
  if (!indexResp.ok) {
    throw new Error(`Failed to load skin index at ${baseUrl}/index.json (${indexResp.status})`);
  }
  const { files: fileList } = await indexResp.json() as { files: string[] };

  const entries: Record<string, Uint8Array> = {};
  await Promise.all(fileList.map(async name => {
    // Encode per path segment so subfolder entries (skin.ini can reference sprites in
    // subdirectories, e.g. `circles/notes/baby pink.png`) keep their `/` separators
    // while spaces and other reserved chars stay escaped. encodeURIComponent over the
    // whole name would turn `/` into `%2F`, which some static hosts (e.g. Cloudflare
    // Pages) 404 on. Flat basenames (no `/`) encode identically either way.
    const url = `${baseUrl}/${name.split('/').map(encodeURIComponent).join('/')}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    entries[name] = new Uint8Array(await resp.arrayBuffer());
  }));

  return decodeSkinEntries(entries, audioCtx);
}
