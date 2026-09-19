// Minimal consumer of the replay engine

import {
  configureWorkers, parseReplay, loadSkinFromDir, buildSkin, createReplaySession,
} from '../../dist/index.js';

// Optional: off-thread DT/HT time-stretching. Point the library at the worker bundle
// built next to dist/index.js; omit this call and stretching falls back to a
// synchronous main-thread path (a one-off freeze of a few seconds on DT/HT replays).
configureWorkers({ stretch: new URL('../../dist/stretch-worker.js', import.meta.url).href });

const canvas = document.getElementById('playfield');
const status = document.getElementById('status');
const button = document.getElementById('start');

let session = null;

async function buildSession() {
  // The AudioContext must be created inside a user gesture (browser autoplay policy).
  const audioContext = new AudioContext();

  status.textContent = 'loading assets…';
  const [osrBytes, oszBytes, skin] = await Promise.all([
    fetch('./assets/replay.osr').then(r => {
      if (!r.ok) throw new Error('assets/replay.osr missing — see README.md');
      return r.arrayBuffer();
    }),
    fetch('./assets/map.osz').then(r => {
      if (!r.ok) throw new Error('assets/map.osz missing — see README.md');
      return r.arrayBuffer();
    }),
    // A skin as a static directory of pre-extracted files listed by an index.json
    // manifest of shape { "files": [...] } — see README.md for the layout.
    loadSkinFromDir('../../assets/skin', audioContext),
  ]);

  const replay = await parseReplay(osrBytes);
  status.textContent = 'building session…';
  session = await createReplaySession({
    canvas,
    audioContext,
    replay,
    beatmapSet: oszBytes,
    skin: buildSkin(skin, undefined, { mode: replay.mode }),
    // Optional: the 12 default fallback hitsounds (most taiko skins depend on these)
    // and the lazer-style mod-icon textures.
    lazerDefaultsUrl: '../../assets/lazer-defaults',
    // Optional: parse + draw the beatmap's storyboard, and play its video (needs a DOM).
    // Both default to off. The bundled sample map has neither, so nothing extra is drawn here.
    storyboard: true,
    video: true,
  });

  // `session.renderer.options` is a plain mutable object — flip any of these at
  // any time (before or during playback) to change what's drawn. 
  Object.assign(session.renderer.options, {
    showJudgement:    true, // per-hit judgement popups, score, combo
    showKeyOverlay:   true, // key-press overlay
    showFollowpoints: true, // stream lines between consecutive hit objects
    showURBar:        true, // unstable-rate bar
    showModIcons:     true, // mod icons (HD/HR/DT/...)
    showStoryboard:   true, // storyboard sprites (when loaded with `storyboard: true`)
    showVideo:        true, // beatmap video (when loaded with `video: true`)
  });

  // `session.audioSync` exposes the live audio knobs; each takes effect immediately.
  session.audioSync.setSongVolume(1);          // 0..1, music track
  session.audioSync.setEffectsVolume(1);       // 0..1, hitsounds
  session.audioSync.setBeatmapHitsounds(true); // beatmap-shipped samples override the skin's
  session.audioSync.setUserRate(1);            // 0.1..2, playback rate on top of the mod speed

  session.renderer.start();
}

async function play() {
  const { player, audioSync } = session;
  let presMs = player.currentTimeMs;
  if (presMs >= player.durationMs - 50) presMs = 0;
  // Anchor the player's clock to the audio hardware timeline BEFORE play().
  player.setClockFn(audioSync.clockFn);
  await audioSync.playFrom(presMs);
  player.seek(presMs);
  player.play();
  status.textContent = 'playing';
  button.textContent = 'Pause';
}

function pause() {
  session.audioSync.pause();
  session.player.pause();
  status.textContent = 'paused';
  button.textContent = 'Play';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    if (session === null) await buildSession();
    if (session.player.isPlaying) pause();
    else await play();
  } catch (err) {
    console.error(err);
    status.textContent = String(err);
  } finally {
    button.disabled = false;
  }
});
