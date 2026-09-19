# Minimal example — consume the library from `dist/` alone

1. Build the library (from the repo root):

   ```sh
   npm install
   npm run build
   ```

2. Sample assets are included, so this runs out of the box. To view a
   different play, swap in your own:

   - `assets/replay.osr` — any osu! replay (std / taiko / catch / mania)
   - `assets/map.osz` — the beatmap set it was played on (must contain the
     `.osu` whose MD5 matches the replay's beatmap hash)
   - a skin — loaded from the repo-level `../../assets/skin/` (the YUGEN
     skin). To use another one, extract it from its `.osk`:

     ```sh
     node scripts/extract-skin.mjs "My Skin.osk" path/to/skin-dir
     ```

   - `../../assets/lazer-defaults/` — osu!'s 12 default fallback hitsound
     `.wav`s (`normal-hitnormal.wav`, `soft-hitclap.wav`, …) and, under
     `mods/`, the default mod-icon textures, also shipped with the repo. If
     absent, synthesized fallback sounds and text-label mod icons are used
     instead.

3. Serve the **repo root** (the page reaches up to `dist/` and `assets/`):

   ```sh
   python3 -m http.server 8080
   ```

4. Open <http://localhost:8080/examples/minimal/> and press Play.

## What it demonstrates

- `parseReplay(ArrayBuffer)` — .osr decode, including the LZMA frame stream.
- `loadSkinFromDir(url, audioCtx)` + `buildSkin(...)` — skin loading and merge.
- `createReplaySession({...})` — the full engine pipeline; playback is driven
  with `renderer.start()` then `audioSync.playFrom()` / `player.play()` (clock
  anchored via `player.setClockFn(audioSync.clockFn)`).
- `configureWorkers({ stretch })` — injectable worker URL for off-thread DT/HT
  stretching (`dist/stretch-worker.js`). Optional: without it the library uses
  a synchronous in-thread fallback.
- `lazerDefaultsUrl` — injectable base URL for the default fallback hitsounds
  and mod icons (shipped at `../../assets/lazer-defaults/`).
- `storyboard: true` / `video: true` — opt in to loading and drawing the
  beatmap's storyboard and video. The bundled sample map has neither; swap in
  a `.osz` that does to see them.
- `session.renderer.options` — a plain mutable object; flip flags like
  `showJudgement` / `showKeyOverlay` / `showURBar` / `showStoryboard` at any
  time to toggle HUD and storyboard layers.
- `session.audioSync` — live audio controls: `setSongVolume` /
  `setEffectsVolume` (0..1), `setBeatmapHitsounds` (beatmap samples vs.
  skin-only), `setUserRate` (0.1..2 playback-rate multiplier on top of the mod
  speed).

## Skin directory layout

`loadSkinFromDir(baseUrl)` expects a directory of pre-extracted skin files plus
an `index.json` manifest listing every file path:

```
<skin dir>/
  index.json          { "files": ["skin.ini", "hitcircle.png", "hitcircle@2x.png", ...] }
  skin.ini
  hitcircle.png
  ...
```

`scripts/extract-skin.mjs` unpacks an `.osk` into this layout, keeping only the
files the renderer actually references.
