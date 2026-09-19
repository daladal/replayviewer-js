# Embed example — iframe + postMessage, no library required

Instead of importing the JS library and building your own render/playback pipeline, 
this frames replayviewer.com in an iframe at `?embed=1` and feeds it a replay over `postMessage`.
 
There is no library import and nothing to build — the entire
engine runs inside the iframe; this page only supplies replay/beatmap bytes.

If you don't need to supply your own replay/beatmap you can simply add `?embed=1` to a replayviewer URL 
to frame the sites player and settings panel:
`https://www.replayviewer.com/?embed=1#score=1624832558&skin=YUGEN`

## Run it

1. Sample assets ship in `assets/`; swap in your own to view a different play:

   - `assets/replay.osr` — any osu! replay (std / taiko / catch / mania)
   - `assets/map.osz` — the beatmap set it was played on (must contain the
     `.osu` whose MD5 matches the replay's beatmap hash)

2. Serve this directory with any static file server (this example makes no
   requests into the rest of the repo):

   ```sh
   python3 -m http.server 8080
   ```

3. Open <http://localhost:8080/examples/embed/>, wait for "viewer ready",
   then press "Load replay". Playback controls (play/pause, render-options
   toggles, skin, mods, etc.) are the hosted viewer's own UI, visible inside
   the iframe — this page doesn't reimplement them.

## Message protocol

- **Activation**: `<iframe src="https://www.replayviewer.com/?embed=1">` puts the
  viewer into a stripped layout — canvas, render-options panel, and player
  controls only; the upload panel and export UI are hidden.
- **Handshake**: the viewer posts `{ type: 'replayviewer:ready' }` once it's
  listening; wait for it before posting anything in.
- **Loading a replay**: post `{ type: 'replayviewer:load', osr, osz? }`
  (`ArrayBuffer`s, transferable for zero-copy) at the viewer's origin. No
  login required — if `osz` is omitted or doesn't contain the matching `.osu`,
  the viewer resolves the beatmap itself via public mirrors. The viewer acks
  with `{ type: 'replayviewer:loaded' }` or `{ type: 'replayviewer:error',
  message }`.
- **Auto replays**: post `{ type: 'replayviewer:loadAuto', beatmap, mods? }`
  instead — `beatmap` is a beatmap link or ID string, `mods` an optional array
  of mod acronyms (e.g. `['HD', 'DT']`; off-mode or unknown acronyms are
  ignored). The viewer generates a perfect "Auto" play for that beatmap and
  renders it; no `.osr` is needed. Same `loaded`/`error` acks. (Not exercised
  by this example's UI, but the same handshake and origin rules apply.)

## Tradeoffs vs. `examples/minimal/`

Nothing to build, no per-ruleset rendering code to maintain, and playback
stays in sync with whatever replayviewer.com ships next. In exchange, the
host page has no direct API access — no `RenderOptions`/audio control from
JavaScript, only whatever toggles the viewer's own UI exposes — and depends
on replayviewer.com being reachable.
