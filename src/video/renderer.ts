/**
 * Composites the video layers and presents them the way the cabinet does.
 *
 * We render into a buffer laid out the way the *hardware raster* is: 256 dots
 * across a scanline (expanded 3x so the starfield's sub-dot timing survives),
 * by 224 visible scanlines. Only at the very end is that rotated into the
 * portrait image the player actually sees.
 *
 * The rotation follows from the sprite hardware. MAME places a sprite at
 * horizontal position `base[3]` and vertical position `240 - base[0]`, and the
 * disassembly names those bytes X and Y respectively, with the convention that
 * incrementing Y moves the object left and incrementing X moves it down. So:
 *
 *   hardware dot (256 across)      -> player's vertical axis   (256 tall)
 *   hardware scanline (224 lines)  -> player's horizontal axis (224 wide)
 *
 * The dimensions corroborate this: the visible raster is 256x224 and the
 * cabinet shows a 224x256 portrait screen.
 */

import { SCREEN_W, SCREEN_H, VBEND, XSCALE, VISIBLE_W, VISIBLE_H } from '../core/clock';

/** Width of the hardware-space framebuffer, in subpixels. */
export const FB_WIDTH = SCREEN_W * XSCALE; // 768
/** Height of the hardware-space framebuffer, in scanlines. */
export const FB_HEIGHT = SCREEN_H; // 224

export class Renderer {
  /** Hardware-space framebuffer: 768 subpixels x 224 scanlines, packed RGBA. */
  readonly frame = new Uint32Array(FB_WIDTH * FB_HEIGHT);

  /** Absolute scanline number of framebuffer row 0. */
  readonly firstScanline = VBEND;

  private readonly image: ImageData;
  private readonly out: Uint32Array;
  private readonly ctx: CanvasRenderingContext2D;

  flipScreenX = false;
  flipScreenY = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.width = VISIBLE_W;
    canvas.height = VISIBLE_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;
    this.image = this.ctx.createImageData(VISIBLE_W, VISIBLE_H);
    this.out = new Uint32Array(this.image.data.buffer);
  }

  /** Clear the framebuffer to black before drawing a frame. */
  clear(): void {
    this.frame.fill(0xff000000);
  }

  /**
   * Rotate, resolve subpixels, and blit to the canvas.
   *
   * The 3:1 horizontal resolve is a box filter, which is the physically honest
   * answer: a star lit for one subpixel really is a third of a dot wide, so it
   * really is dimmer than a full dot. Tiles and sprites always fill all three
   * subpixels, so they resolve exactly and stay crisp.
   */
  present(): void {
    const src = this.frame;
    const dst = this.out;

    for (let row = 0; row < FB_HEIGHT; row++) {
      // Hardware scanline -> player's horizontal axis.
      const screenX = this.flipScreenY ? VISIBLE_W - 1 - row : row;
      const rowBase = row * FB_WIDTH;

      for (let dot = 0; dot < SCREEN_W; dot++) {
        // Hardware dot -> player's vertical axis.
        const screenY = this.flipScreenX ? VISIBLE_H - 1 - dot : dot;

        const i = rowBase + dot * XSCALE;
        const a = src[i]!;
        const b = src[i + 1]!;
        const c = src[i + 2]!;

        let packed: number;
        if (a === b && b === c) {
          packed = a; // tiles, sprites, bullets: no subpixel structure
        } else {
          const r = (((a & 0xff) + (b & 0xff) + (c & 0xff)) / 3) | 0;
          const g = ((((a >> 8) & 0xff) + ((b >> 8) & 0xff) + ((c >> 8) & 0xff)) / 3) | 0;
          const bl = ((((a >> 16) & 0xff) + ((b >> 16) & 0xff) + ((c >> 16) & 0xff)) / 3) | 0;
          packed = ((0xff << 24) | (bl << 16) | (g << 8) | r) >>> 0;
        }
        dst[screenY * VISIBLE_W + screenX] = packed;
      }
    }

    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Scale the canvas element to fit its container at an integer ratio. */
  fitToWindow(container: HTMLElement): void {
    const scale = Math.max(
      1,
      Math.floor(Math.min(container.clientWidth / VISIBLE_W, container.clientHeight / VISIBLE_H)),
    );
    this.canvas.style.width = `${VISIBLE_W * scale}px`;
    this.canvas.style.height = `${VISIBLE_H * scale}px`;
  }
}
