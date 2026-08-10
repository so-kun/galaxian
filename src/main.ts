import { FrameClock } from './core/clock';
import { Palette } from './video/palette';
import { Starfield } from './video/starfield';
import { Renderer } from './video/renderer';
import { buildGfx } from './video/gfx';
import { VideoHardware } from './video/hardware';
import { Game } from './game/game';
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
const game = new Game();
const input = new Input();
const audio = new AudioEngine();

input.attach();
input.attachTouch(stage);
video.starsEnabled = true; // $7004

const clock = new FrameClock(() => {
  starfield.advanceFrame();
  game.step(input.state);
  game.render(video.videoram, video.objram);
  video.draw(renderer.frame);
  renderer.present();
});

/** Audio needs a user gesture; the first key or tap starts everything. */
let started = false;
const begin = async () => {
  if (started) return;
  started = true;
  overlay.hidden = true;
  try {
    await audio.start();
    game.sound = audio;
    audio.gameStart();
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
  game,
  input,
  audio,
  clock,
};
