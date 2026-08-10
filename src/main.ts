import { FrameClock } from './core/clock';
import { Palette } from './video/palette';
import { Starfield } from './video/starfield';
import { Renderer } from './video/renderer';
import { buildGfx } from './video/gfx';
import { VideoHardware } from './video/hardware';
import { Swarm } from './game/swarm';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;

const palette = new Palette();
const gfx = buildGfx();
const renderer = new Renderer(canvas);
const starfield = new Starfield(palette);
const video = new VideoHardware(palette, gfx, starfield);
const swarm = new Swarm();

video.starsEnabled = true; // $7004
swarm.reset();

const clock = new FrameClock(() => {
  starfield.advanceFrame();
  swarm.update();
  swarm.draw(video.videoram, video.objram);
  video.draw(renderer.frame);
  renderer.present();
});

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
  swarm,
  clock,
};
