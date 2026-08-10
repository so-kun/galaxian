import { FrameClock } from './core/clock';
import { Palette } from './video/palette';
import { Starfield } from './video/starfield';
import { Renderer } from './video/renderer';
import { buildGfx } from './video/gfx';
import { VideoHardware } from './video/hardware';
import { Game } from './game/game';
import { Attract } from './game/attract';
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

/**
 * Two top-level states, as the board has: attract (SCRIPT_ONE) and a real game
 * (SCRIPT_TWO onward). Start moves attract -> game; game over returns to
 * attract, carrying the high score forward.
 */
const attract = new Attract();
let game: Game | null = null;

input.attach();
input.attachTouch(stage);
video.starsEnabled = true; // $7004

function beginGame(): void {
  game = new Game();
  game.sound = audio;
  game.highScore = attract.highScore;
  audio.gameStart();
}

const clock = new FrameClock(() => {
  starfield.advanceFrame();

  if (game) {
    game.step(input.state);
    game.render(video.videoram, video.objram);
    // The real game runs its own attract-on-game-over via Start; here, once it
    // is over and the player idles, fall back to the attract cycle.
    if (game.gameOver && game.idleFrames > 240) {
      attract.highScore = Math.max(attract.highScore, game.highScore);
      attract.reset();
      game = null;
    }
  } else {
    if (attract.update(input.state)) beginGame();
    else attract.render(video.videoram, video.objram);
  }

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
  attract,
  get game() {
    return game;
  },
  input,
  audio,
  clock,
};
