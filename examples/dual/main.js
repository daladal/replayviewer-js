// Dual-canvas consumer: two replays of the same beatmap playing side by side
import {
  configureWorkers, parseReplay, loadSkinFromDir, buildSkin, createReplaySession,
} from '../../dist/index.js';

// Optional: off-thread DT/HT time-stretching (see the minimal example).
configureWorkers({ stretch: new URL('../../dist/stretch-worker.js', import.meta.url).href });

const canvasA = document.getElementById('playfield-a');
const canvasB = document.getElementById('playfield-b');
const labelA = document.getElementById('label-a');
const labelB = document.getElementById('label-b');
const status = document.getElementById('status');
const button = document.getElementById('start');

let sessionA = null; // drives audio + the shared clock
let sessionB = null; // muted follower

async function fetchAsset(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} missing — see README.md`);
  return r.arrayBuffer();
}

async function buildSessions() {
  // The AudioContext must be created inside a user gesture (browser autoplay policy).
  const audioContext = new AudioContext();

  status.textContent = 'loading assets…';
  const [osrA, osrB, oszBytes, skin] = await Promise.all([
    fetchAsset('./assets/replay-a.osr'),
    fetchAsset('./assets/replay-b.osr'),
    fetchAsset('./assets/map.osz'),
    loadSkinFromDir('../../assets/skin', audioContext),
  ]);

  const replayA = await parseReplay(osrA);
  const replayB = await parseReplay(osrB);
  // Asset reuse skips the .osz's hash lookup for the second replay, so check it here.
  if (replayA.beatmapHash !== replayB.beatmapHash) {
    throw new Error('the two replays were not set on the same beatmap');
  }

  const skinAssets = buildSkin(skin, undefined, { mode: replayA.mode });

  status.textContent = 'building sessions…';
  sessionA = await createReplaySession({
    canvas: canvasA,
    audioContext,
    replay: replayA,
    beatmapSet: oszBytes,
    skin: skinAssets,
    lazerDefaultsUrl: '../../assets/lazer-defaults',
  });

  // Reuse session A's decoded assets.
  sessionB = await createReplaySession({
    canvas: canvasB,
    audioContext,
    replay: replayB,
    beatmapSet: sessionA.assets,
    skin: skinAssets,
    lazerDefaultsUrl: '../../assets/lazer-defaults',
  });

  // One clock, one audio source. 
  if (sessionA.speed !== sessionB.speed) {
    throw new Error('the two replays must carry the same speed mods (DT/HT/NC)');
  }
  sessionB.audioSync.setSongVolume(0);
  sessionB.audioSync.setEffectsVolume(0);
  sessionB.player.setClockFn(sessionA.audioSync.clockFn);

  // Render options are per-renderer — mirror them so the two sides look alike.
  for (const s of [sessionA, sessionB]) {
    Object.assign(s.renderer.options, {
      showJudgement:    true,
      showKeyOverlay:   true,
      showFollowpoints: true,
      showURBar:        true,
      showModIcons:     true,
      showStoryboard:   true,
      showVideo:        true,
    });
    s.renderer.start();
  }

  labelA.textContent = replayA.username;
  labelB.textContent = replayB.username;
}

async function play() {
  let presMs = sessionA.player.currentTimeMs;
  if (presMs >= sessionA.player.durationMs - 50) presMs = 0;
  // Anchor A's clock to the audio hardware timeline BEFORE play(); B is already
  // locked to the same clock, so seeking both players lands them on one timeline.
  sessionA.player.setClockFn(sessionA.audioSync.clockFn);
  await sessionA.audioSync.playFrom(presMs);
  for (const s of [sessionA, sessionB]) {
    s.player.seek(presMs);
    s.player.play();
  }
  status.textContent = 'playing';
  button.textContent = 'Pause';
}

function pause() {
  sessionA.audioSync.pause();
  sessionA.player.pause();
  sessionB.player.pause();
  status.textContent = 'paused';
  button.textContent = 'Play';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    if (sessionA === null) await buildSessions();
    if (sessionA.player.isPlaying) pause();
    else await play();
  } catch (err) {
    console.error(err);
    status.textContent = String(err);
  } finally {
    button.disabled = false;
  }
});
