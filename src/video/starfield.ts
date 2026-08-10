/**
 * The starfield.
 *
 * This is the part of the board most often reproduced incorrectly, so it is
 * worth being precise about why.
 *
 * The RNG that places stars is clocked by (18 MHz AND 6 MHz). The divide-by-3
 * that makes the pixel clock has a 2/3 duty cycle, so the AND produces an
 * *asymmetric* clock: three master clocks per pixel, but only two RNG clocks,
 * spaced 1-then-2. A star drawn from the first RNG clock is one third of a
 * pixel wide; a star from the second is two thirds. Sampling the RNG once per
 * pixel gives a starfield with the right density and the wrong pattern.
 *
 * We therefore render into a buffer that is 3x wider than the dot clock, which
 * is what MAME does for the same reason.
 *
 * Two further details that are easy to miss:
 *  - Stars are suppressed unless V1 XOR H8 == 1, i.e. `(y ^ (x >> 3)) & 1`.
 *    This halves the density in a checkerboard of 8-dot cells.
 *  - The scroll comes from an off-by-one. Each frame clocks the register
 *    512*256 = 2^17 times, one more than its 2^17-1 period. When not flipped, a
 *    pair of D flip-flops at 6B delays the count to 2^17-2, i.e. one *less*
 *    than the period. Either way the pattern walks by one step per frame, and
 *    that is the entire scrolling mechanism -- there is no position counter.
 */

import { LFSR_PERIOD, lfsrNext, starEnabled, starColorIndex } from '../core/lfsr';
import type { Palette } from './palette';
import { SCREEN_W, XSCALE } from '../core/clock';

/** RNG clocks consumed per scanline: 2 per dot across a 256-dot line. */
const CLOCKS_PER_LINE = 512;

/**
 * Precomputed RNG stream: colour in the low 6 bits, enable in bit 7.
 * One byte per LFSR state, 131071 entries.
 */
export function buildStarStream(): Uint8Array {
  const stream = new Uint8Array(LFSR_PERIOD);
  let shiftreg = 0;
  for (let i = 0; i < LFSR_PERIOD; i++) {
    stream[i] = starColorIndex(shiftreg) | (starEnabled(shiftreg) ? 0x80 : 0);
    shiftreg = lfsrNext(shiftreg);
  }
  return stream;
}

export class Starfield {
  private readonly stream: Uint8Array;
  private origin = 0;
  /** Stars are gated by a write to $7004. */
  enabled = false;
  flipScreenX = false;

  constructor(private readonly palette: Palette) {
    this.stream = buildStarStream();
  }

  /**
   * Walk the RNG origin forward by one frame.
   *
   * The direction depends on flip state: +1 flipped, -1 not. This is the only
   * thing that makes the stars move.
   */
  advanceFrame(): void {
    const delta = this.flipScreenX ? 1 : -1;
    this.origin = (((this.origin + delta) % LFSR_PERIOD) + LFSR_PERIOD) % LFSR_PERIOD;
  }

  reset(): void {
    this.origin = 0;
    this.enabled = false;
  }

  /**
   * Draw stars into a subpixel framebuffer.
   *
   * @param buf       width = SCREEN_W * XSCALE, height = `lines`
   * @param firstLine absolute scanline of buffer row 0 (VBEND, i.e. 16)
   * @param lines     number of visible scanlines (224)
   *
   * The absolute scanline number matters twice over: it seeds the per-row RNG
   * offset, and its low bit drives the V1^H8 gate. Passing a zero-based row
   * index instead shifts the whole field and inverts the checkerboard.
   */
  draw(buf: Uint32Array, firstLine: number, lines: number): void {
    if (!this.enabled) return;
    const stride = SCREEN_W * XSCALE;
    const stream = this.stream;
    const colors = this.palette.starColors;

    for (let row = 0; row < lines; row++) {
      const y = firstLine + row;
      let offs = (this.origin + y * CLOCKS_PER_LINE) % LFSR_PERIOD;
      const rowBase = row * stride;
      for (let x = 0; x < SCREEN_W; x++) {
        // V1 ^ H8: stars only appear on alternating 8-dot cells per scanline.
        const enableStar = (y ^ (x >> 3)) & 1;

        // First RNG clock covers one subpixel.
        let star = stream[offs++]!;
        if (offs >= LFSR_PERIOD) offs = 0;
        if (enableStar && (star & 0x80) !== 0) {
          buf[rowBase + x * XSCALE] = colors[star & 0x3f]!;
        }

        // Second RNG clock covers the remaining two subpixels.
        star = stream[offs++]!;
        if (offs >= LFSR_PERIOD) offs = 0;
        if (enableStar && (star & 0x80) !== 0) {
          const c = colors[star & 0x3f]!;
          buf[rowBase + x * XSCALE + 1] = c;
          buf[rowBase + x * XSCALE + 2] = c;
        }
      }
    }
  }
}
