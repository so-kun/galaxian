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
const overlay = document.getElementById('overlay') as HTMLElement;

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

input.attach();
input.attachTouch(stage);
video.starsEnabled = true; // $7004

const clock = new FrameClock(() => {
  starfield.advanceFrame();
  session.update(input.state);
  session.render(video.videoram, video.objram);
  video.draw(renderer.frame);
  renderer.present();
});

/** Audio needs a user gesture; the first key or tap starts it. */
let started = false;
const begin = async () => {
  if (started) return;
  started = true;
  overlay.hidden = true;
  try {
    await audio.start();
    session.sound = audio;
  } catch {
    // No audio: the game still runs.
  }
};

for (const event of ['keydown', 'pointerdown', 'touchstart']) {
  addEventListener(event, begin);
}

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
