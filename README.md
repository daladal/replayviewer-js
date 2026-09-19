# replayviewer-js

Render osu! replays in the browser. A TypeScript engine that parses `.osr`
replays, `.osu`/`.osz` beatmaps, and skins; re-judges the play from raw input
frames; and renders synchronized gameplay + audio onto a canvas.

- **All four rulesets** — osu!standard, taiko, catch, mania.
- **Stable and lazer replays**, with mod support: HD, HR/EZ, DT/HT/NC (real
  audio time-stretch, pitch-correct for DT/HT), FL, MR, and more.
- **Storyboards and beatmap video** — opt-in, rendered in sync with gameplay.
- **Headless analysis** — judge a replay and compute score/accuracy/combo/UR
  timelines with no canvas, skin, or audio.
- **Auto replays** — synthesize a perfect play for any beatmap.
- **Zero runtime dependencies**

This is the engine behind [replayviewer.com](https://replayviewer.com). The
code here is generated from an upstream repository that I run the site out of, so please
file issues rather than pull requests against `src/`.

## Install

```sh
npm install replayviewer-js
```

The package ships `dist/index.js` (a single self-contained ES-module bundle),
`dist/stretch-worker.js`, and the full type-declaration tree — see
[Usage](#usage). Note that skins and other sample assets are not part of the
npm package; clone this repo to get them along with the runnable examples.

## Building from source

```sh
npm install
npm run build     # → dist/index.js + dist/stretch-worker.js + d.ts tree
```

Then try the examples (sample replay/beatmap assets and a skin are included):

- [`examples/minimal/`](examples/minimal/) — load a replay + beatmap + skin
  and play it back.
- [`examples/dual/`](examples/dual/) — two replays of the same map side by
  side, clock-locked to one audio timeline.
- [`examples/embed/`](examples/embed/) — skip the library entirely and embed
  replayviewer.com in an iframe. postMessage protocol available for more advanced usage.

## Dependencies

- `lzma` — decodes the LZMA-compressed input-frame stream inside `.osr` replays.
- `fflate` — unzips `.osz` beatmap sets and `.osk` skins.
- `@soundtouchjs/core` — pitch-correct audio time-stretching for DT/HT playback.
- `esbuild` — bundles `src/` into `dist/index.js` + `dist/stretch-worker.js`.
- `typescript` — type-checks and emits the `dist/` declaration tree.

## Usage

```js
import {
  configureWorkers, parseReplay, loadSkinFromDir, buildSkin, createReplaySession,
} from 'replayviewer-js';

// Optional: off-thread DT/HT time-stretching (falls back to a synchronous
// in-thread path when omitted).
configureWorkers({ stretch: '/path/to/dist/stretch-worker.js' });

const audioContext = new AudioContext();  // must be created inside a user gesture
const replay = await parseReplay(osrArrayBuffer);
const skin = await loadSkinFromDir('/skins/my-skin', audioContext);

const session = await createReplaySession({
  canvas,                 // HTMLCanvasElement
  audioContext,
  replay,
  beatmapSet: oszArrayBuffer,
  skin: buildSkin(skin, undefined, { mode: replay.mode }),
  storyboard: true,       // optional: parse + draw the beatmap's storyboard
  video: true,            // optional: also play the beatmap video (needs a DOM)
});

// Start playback: anchor the player's clock to the audio timeline, then go.
session.renderer.start();
session.player.setClockFn(session.audioSync.clockFn);
await session.audioSync.playFrom(0);
session.player.seek(0);
session.player.play();

// ...later
session.destroy();
```

## API overview

**Parsing**

- `parseReplay(ArrayBuffer)` — decode a `.osr` into `ReplayData`.
- `parseBeatmap(text)` — decode a `.osu` into `BeatmapData`.
- `loadBeatmapSet(ArrayBuffer, options?)` / `extractBeatmapBackground(...)` —
  unpack a `.osz` beatmap set; `options.storyboard` / `options.video` also
  load the storyboard and video.
- `loadSkin(...)` / `loadSkinFromDir(url)` / `mergeSkinAssets(...)` — skin
  loading (see [Skins](#skins)).
- `md5(bytes)` — the hash osu! uses to match replays to beatmaps.

**Headless analysis** (no canvas / skin / audio; Node-compatible)

- `analyzeReplay(beatmap, replay)` — dispatches on the replay's ruleset and
  returns `{ mode, modDiff, hitResults, scoreFrames, accFrames, comboFrames,
  urTimeline }`.
- `computeModDifficulty(...)`, `applyStacking(...)` — helpers.
- Ruleset conversions consumers may need alongside the analysis outputs:
  `convertBeatmapToMania`, `convertBeatmapToCatch`, `applyPositionOffsets`, …

**Rendering + playback**

- `createReplaySession(inputs)` — the full pipeline: parse → difficulty →
  stacking → skin merge → `TimeMapper`/`Player`/`Renderer`/`AudioSync`, wired
  together and returned as a `CoreSession` with a `destroy()`.
- `buildSkin(base, overlay?, { mode? })` — merge skin layers before a session.
- `Renderer` / `RenderOptions`, `Player`, `TimeMapper`, `AudioSync` — the
  individual pieces, for custom wiring.
- `synthesizeAutoReplay` + `generate{Std,Taiko,Mania,Catch}AutoReplay` —
  perfect-play generation for beatmaps without a replay.
- `configureWorkers({ stretch })` — inject the worker bundle URL for
  off-thread DT/HT audio stretching.

**Storyboards**

- Pass `storyboard: true` (and optionally `video: true`) to
  `createReplaySession` to load and draw the beatmap's storyboard;
  `RenderOptions.showStoryboard` / `showVideo` toggle the layers live, and
  `session.videoStatus` reports whether the video can play.
- `parseStoryboard(...)` + the `Storyboard*` types — the parsed model, for
  consumers that want the storyboard without the renderer.

## Skins

A skin is a required input to `createReplaySession`. This repo ships one ready
to use, pre-extracted at `assets/skin/` (the examples load it from there),
plus osu!'s default assets at `assets/lazer-defaults/`: the fallback hitsounds
and the lazer-style mod-icon textures. Point `lazerDefaultsUrl` at that
directory when calling `createReplaySession`.

`loadSkinFromDir(baseUrl)` consumes a static directory of pre-extracted skin
files with an `index.json` manifest:

```
<skin dir>/
  index.json          { "files": ["skin.ini", "hitcircle.png", ...] }
  skin.ini
  hitcircle.png
  ...
```

`scripts/extract-skin.mjs` produces this layout from any `.osk`:

```sh
node scripts/extract-skin.mjs "My Skin.osk" path/to/skin-dir
```

The script needs `fflate`

## Credits

- [Wieku/danser-go](https://github.com/Wieku/danser-go) — the osu!standard
  ruleset (judgement behavior, mod formulas, and much of the renderer's
  animation/layout detail) was built with danser as the reference
  implementation and validated against it.
- [ppy/osu](https://github.com/ppy/osu) — most features were built and validated 
  against osu! lazer or directly ported to TypeScript from it.

## License

[MIT](LICENSE) The bundled sample assets are not ours:
the default hitsounds and mod-icon textures in `assets/lazer-defaults/` come from
[ppy/osu-resources](https://github.com/ppy/osu-resources) (CC BY-NC 4.0), and
the skin, beatmaps, and replays under `assets/` and `examples/*/assets/`
belong to their respective creators and are included as sample data only.
osu! is a trademark of ppy Pty Ltd; this project is not affiliated with or
endorsed by ppy.
