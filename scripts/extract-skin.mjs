// Extract the skin assets the renderer actually references from an .osk into a
// static directory consumable by `loadSkinFromDir(url)`, emitting the
// index.json manifest ({ "files": [...] }) the loader expects.
//
// Requires `fflate` (a devDependency of this repo — `npm install` covers it;
// if you copied this script elsewhere, `npm install fflate` alongside it).
//
// Usage:
//   node scripts/extract-skin.mjs <skin.osk> <out-dir>
//   node scripts/extract-skin.mjs "My Skin.osk" examples/minimal/assets/skin

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { unzipSync } from 'fflate';

const [oskPath, outDir] = process.argv.slice(2);
if (!oskPath || !outDir) {
  console.error('usage: node scripts/extract-skin.mjs <skin.osk> <out-dir>');
  process.exit(1);
}
if (!existsSync(oskPath)) {
  console.error(`extract-skin: ${oskPath} not found`);
  process.exit(1);
}

// File basenames to keep (case-insensitive) — every stem the renderer or the
// hitsound resolver looks up, across all four rulesets.
const ALLOW = [
  /^skin\.ini$/,
  // osu!standard hit objects + cursor + HUD
  /^hitcircle(@2x)?\.png$/,
  /^hitcircleoverlay(@2x)?\.png$/,
  /^sliderstartcircle(@2x)?\.png$/,
  /^sliderstartcircleoverlay(@2x)?\.png$/,
  /^approachcircle(@2x)?\.png$/,
  /^sliderb0?(@2x)?\.png$/,
  /^sliderfollowcircle(@2x)?\.png$/,
  /^reversearrow(@2x)?\.png$/,
  /^default-\d(@2x)?\.png$/,
  /^spinner-(background|circle|bottom|top|middle|middle2|glow|metre|approachcircle|spin|clear|osu|warning)(@2x)?\.png$/,
  // Score / Combo / ScoreEntry glyph fonts. ComboPrefix defaults to "score" but
  // skins often override. Per ppy/osu LegacySkinExtensions there is NO
  // cross-prefix fallback (a missing combo-0 does NOT use score-0), so both
  // prefixes are extracted.
  /^score-(\d|dot|percent|x|comma)(@2x)?\.png$/,
  /^combo-(\d|dot|percent|x|comma)(@2x)?\.png$/,
  /^scoreentry-\d(@2x)?\.png$/,
  /^inputoverlay-(background|key)(@2x)?\.png$/,
  /^followpoint(-\d+)?(@2x)?\.png$/,
  /^cursor(@2x)?\.png$/,
  /^cursormiddle(@2x)?\.png$/,
  /^cursortrail(@2x)?\.png$/,
  /^hit(300|100|50|0)(-0)?(@2x)?\.png$/,
  // taiko: judgement popups (strong-success uses the `…k` variant), hit
  // objects, drum-roll body, playfield bars, drum, mascot
  /^taiko-hit(300|100|0)(k)?(-\d+)?(@2x)?\.png$/,
  /^pippidon(idle|kiai|clear|fail)\d*(@2x)?\.png$/,
  /^taikohitcircle(@2x)?\.png$/,
  /^taikohitcircleoverlay(-\d+)?(@2x)?\.png$/,
  /^taikobigcircle(@2x)?\.png$/,
  /^taikobigcircleoverlay(-\d+)?(@2x)?\.png$/,
  /^taiko-roll-(middle|end)(@2x)?\.png$/,
  /^sliderscorepoint(@2x)?\.png$/,
  /^taiko-bar-(left|right|right-glow)(@2x)?\.png$/,
  /^taiko-drum-(inner|outer)(@2x)?\.png$/,
  /^taiko-barline(@2x)?\.png$/,
  /^taiko-glow(@2x)?\.png$/,
  // mod icons
  /^selection-mod-(nofail|easy|hidden|hardrock|suddendeath|perfect|doubletime|relax|halftime|nightcore|flashlight|spunout|fadein|mirror)(@2x)?\.png$/,
  // samples
  /^combobreak\.(wav|mp3|ogg)$/,
  /^spinnerbonus\.(wav|mp3|ogg)$/,
  /^(normal|soft|drum)-hit(normal|whistle|finish|clap)\d*\.(wav|mp3|ogg)$/,
  /^taiko-(normal|soft|drum)-hit(normal|whistle|finish|clap)\d*\.(wav|mp3|ogg)$/,
  // mania: note/hold/key sprites (per-column overrides included), stage,
  // judgements, hit-explosion frames
  /^mania-note(\d+|s)(h|l|t)?(-\d+)?(@2x)?\.png$/,
  /^mania-key(\d+|s|turn)d?(@2x)?\.png$/,
  /^mania-stage-(left|right|bottom|hint|light)(@2x)?\.png$/,
  /^mania-hit(300g|300|200|100|50|0)(-\d+)?(@2x)?\.png$/,
  /^lighting[nl](-\d+)?(@2x)?\.png$/,
  // catch: fruits, catcher (new-style states + old-style ryuuta), hit explosion
  /^fruit-(pear|grapes|apple|orange)(-overlay)?(@2x)?\.png$/,
  /^fruit-drop(-overlay)?(@2x)?\.png$/,
  /^fruit-bananas(-overlay)?(@2x)?\.png$/,
  /^fruit-catcher-(idle|fail|kiai)(-\d+)?(@2x)?\.png$/,
  /^fruit-ryuuta(-\d+)?(@2x)?\.png$/,
  /^scoreboard-explosion-[12](@2x)?\.png$/,
];

function allowed(name) {
  return ALLOW.some(re => re.test(name));
}

// A catch `-overlay` sprite is only ever drawn alongside its base texture
// (osu! gates each component on the BASE — an orphan `fruit-bananas-overlay`
// with no `fruit-bananas` is never used), so drop overlays whose base stem
// isn't in the archive.
function isOrphanCatchOverlay(name, stems) {
  const m = name.match(/^fruit-(.+)-overlay(@2x)?\.png$/);
  return m !== null && !stems.has(`fruit-${m[1]}`);
}

// Some skins reference sprites via skin.ini subfolder PATHS rather than flat
// basenames — e.g. `NoteImage0: Circles\Notes\pl0x\Baby Pink` or
// `ComboPrefix: font/score`. The renderer resolves these as lowercased
// forward-slash stems, so referenced files are kept at their full relative
// path instead of being flattened. The @2x strip mirrors osu!'s
// LegacySkin.GetTexture (a baked-in `Receptor@2x` keeps BOTH `Receptor.png`
// and `Receptor@2x.png`).
const FONT_GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'dot', 'comma', 'percent', 'x'];
function referencedPathStems(iniBytes) {
  const text = Buffer.from(iniBytes).toString('latin1');
  const stems = new Set();
  for (const line of text.split(/\r?\n/)) {
    const noteM = /^\s*(?:NoteImage|KeyImage)\d+[a-z]*\s*:\s*(.+?)\s*$/i.exec(line);
    if (noteM !== null) {
      const val = noteM[1].replace(/\\/g, '/').replace(/@2x/gi, '').toLowerCase();
      if (val.includes('/')) stems.add(val);
      continue;
    }
    const fontM = /^\s*(?:Score|Combo)Prefix\s*:\s*(.+?)\s*$/i.exec(line);
    if (fontM !== null) {
      const prefix = fontM[1].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (prefix.includes('/')) for (const g of FONT_GLYPHS) stems.add(`${prefix}-${g}`);
    }
  }
  return stems;
}

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const files = unzipSync(new Uint8Array(readFileSync(oskPath)));

// Bare basename stems (sans @2x/.png) present in the archive — gates orphan
// catch overlays.
const stems = new Set();
for (const fullPath of Object.keys(files)) {
  const b = (fullPath.split('/').pop() ?? fullPath).toLowerCase();
  stems.add(b.replace(/@2x\.png$|\.png$/i, ''));
}

// Sprite stems referenced by skin.ini subfolder paths.
let refStems = new Set();
const iniEntry = Object.entries(files).find(
  ([p]) => (p.split('/').pop() ?? p).toLowerCase() === 'skin.ini',
);
if (iniEntry) refStems = referencedPathStems(iniEntry[1]);

const kept = new Set();
let collisions = 0;
for (const [fullPath, bytes] of Object.entries(files)) {
  const base = (fullPath.split('/').pop() ?? fullPath).toLowerCase();
  if (refStems.size > 0) {
    const rel = fullPath.replace(/\\/g, '/').toLowerCase();
    if (rel.includes('/') && /\.(png|jpg)$/.test(rel)) {
      const stem = rel.replace(/\.(png|jpg)$/, '').replace(/@2x$/, '');
      if (refStems.has(stem) && !kept.has(rel)) {
        const dest = join(outDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, bytes);
        kept.add(rel);
        continue;
      }
    }
    // A path-ref skin resolves subfolder sprites by their declared path, so an
    // UNreferenced subfolder file is dropped — never flattened onto a root
    // basename it could collide with.
    if (fullPath.replace(/\\/g, '/').includes('/')) continue;
  }
  if (!allowed(base)) continue;
  if (isOrphanCatchOverlay(base, stems)) continue;
  if (kept.has(base)) { collisions++; continue; }
  writeFileSync(join(outDir, base), bytes);
  kept.add(base);
}

const sorted = [...kept].sort();
writeFileSync(
  join(outDir, 'index.json'),
  JSON.stringify({ files: sorted }, null, 2) + '\n',
);

console.log(`${outDir}: kept ${sorted.length} files${collisions ? ` (${collisions} basename collisions skipped)` : ''}`);
