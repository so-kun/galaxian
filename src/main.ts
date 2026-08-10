import { FrameClock } from './core/clock';
import { Palette } from './video/palette';
import { Starfield } from './video/starfield';
import { Renderer, FB_HEIGHT } from './video/renderer';

const canvas = document.getElementById('screen') as HTMLCanvasElement;
const stage = document.getElementById('stage') as HTMLElement;

const palette = new Palette();
const renderer = new Renderer(canvas);
const starfield = new Starfield(palette);

// $7004 -- stars are on during attract and gameplay alike.
starfield.enabled = true;

const clock = new FrameClock(() => {
  starfield.advanceFrame();
  renderer.clear();
  starfield.draw(renderer.frame, renderer.firstScanline, FB_HEIGHT);
  renderer.present();
});

const fit = () => renderer.fitToWindow(stage);
fit();
addEventListener('resize', fit);
clock.start();

// Expose for screenshot-based verification.
(globalThis as unknown as Record<string, unknown>).galaxian = { palette, starfield, renderer, clock };
