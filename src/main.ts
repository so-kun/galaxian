import { FrameClock } from './core/clock';
import { Palette } from './video/palette';
import { Starfield } from './video/starfield';
import { Renderer } from './video/renderer';
import { buildGfx } from './video/gfx';
import { VideoHardware } from './video/hardware';
import { Session } from './game/session';
import { dipFromQuery } from './game/dip';
import { Input } from './input';
import { AudioEngine } from './audio/engine';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;

const palette = new Palette();
const gfx = buildGfx();
const renderer = new Renderer(canvas);
const starfield = new Starfield(palette);
const video = new VideoHardware(palette, gfx, starfield);
const input = new Input();
const audio = new AudioEngine();

// The cabinet session owns credits, the attract cycle, and one- or two-player
// games. It renders whichever is current into the shared hardware memory.
const session = new Session();
// DIP switches come from the URL: ?bonus=7000|10000|12000|20000&lives=2|3&freeplay=1
session.dip = dipFromQuery(location.search);

/**
 * High score persistence.
 *
 * The board keeps HI_SCORE in plain working RAM and the power-on memory
 * fill wipes it, so a real Galaxian forgets its high score every morning --
 * and it has no initial-entry screen to attach a name to. Keeping the score
 * across visits is therefore ours, not the ROM's, and it is deliberately
 * confined to this file. Storage can throw (private browsing, disabled
 * cookies, quota), and none of it is worth losing a game over.
 */
const HIGH_SCORE_KEY = 'galaxian.highScore';

const loadHighScore = (): number => {
  try {
    const stored = Number(localStorage.getItem(HIGH_SCORE_KEY));
    // Scores are six BCD digits on the board, so anything else is not ours.
    if (!Number.isFinite(stored) || stored < 0 || stored > 999999) return 0;
    return Math.floor(stored);
  } catch {
    return 0;
  }
};

session.highScore = loadHighScore();
session.onHighScore = (score) => {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(score));
  } catch {
    // Storage unavailable: the score still stands for this session.
  }
};

input.attach();
input.attachTouch(stage);

const clock = new FrameClock(() => {
  starfield.advanceFrame();
  session.update(input.state);
  // $7004: off through the power-on self test, on from $1BBE for good.
  video.starsEnabled = session.starsEnabled;
  session.render(video.videoram, video.objram);
  video.draw(renderer.frame);
  renderer.present();
});

/** Audio needs a user gesture; the first key or tap starts it. */
let started = false;
const begin = async () => {
  if (started) return;
  started = true;
  // Attach the sink before starting, not after. That first gesture is
  // usually the coin going in, and its sound is asked for a frame later --
  // long before ten WAVs can be fetched and decoded. The engine holds such
  // a request and plays it the moment it is ready, so the coin is heard.
  session.sound = audio;
  try {
    await audio.start();
  } catch {
    // No audio: the game still runs, silently.
    session.sound = null;
  }
};

/**
 * Every gesture also gets a chance to revive a parked audio context, and so
 * does coming back to the tab. Without this the sound can die during a long
 * spell in attract and stay dead until the browser happens to wake it.
 */
const onGesture = () => {
  void begin();
  audio.resumeIfNeeded();
};

for (const event of ['keydown', 'pointerdown', 'touchstart']) {
  addEventListener(event, onGesture);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) audio.resumeIfNeeded();
});
// Nothing may happen for minutes at a time in attract, so the audio graph is
// checked on a timer rather than only when something wants to make a noise.
setInterval(() => audio.checkAlive(), 3000);

const fit = () => renderer.fitToWindow(stage);
fit();
addEventListener('resize', fit);
clock.start();

(globalThis as unknown as Record<string, unknown>).galaxian = {
  palette,
  gfx,
  starfield,
  renderer,
  video,
  session,
  input,
  audio,
  clock,
};
