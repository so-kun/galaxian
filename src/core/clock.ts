/**
 * Galaxian timing constants.
 *
 * Every number below is derived by division from the single 18.432 MHz master
 * crystal on the PCB. Source: MAME `src/mame/galaxian/galaxian.cpp` header,
 * which transcribes the values off the original schematics:
 *
 *   Main clock: XTAL = 18.432 MHz
 *   Z80 Clock: XTAL/6 = 3.072 MHz
 *   HSYNC = XTAL/3/192/2 = 16 kHz
 *   VSYNC = HSYNC/132/2 = 60.606060 Hz
 *   VBlank duration: 1/VSYNC * (20/132) = 2500 us
 */

/** Master crystal on the Galaxian PCB. */
export const MASTER_CLOCK = 18_432_000;

/** Z80 CPU clock: XTAL/6. Not used for timing here (we run native logic), but
 *  it is what the original game's per-frame work budget was sized against. */
export const CPU_CLOCK = MASTER_CLOCK / 6; // 3_072_000

/** Video dot clock: XTAL/3. */
export const DOT_CLOCK = MASTER_CLOCK / 3; // 6_144_000

/**
 * Horizontal scale factor.
 *
 * The starfield RNG is clocked by (18 MHz AND 6 MHz), which yields two RNG
 * clocks per pixel, distributed asymmetrically (1 subpixel + 2 subpixels).
 * Reproducing that requires a horizontal resolution 3x the dot clock, exactly
 * as MAME does (`GALAXIAN_XSCALE = 3`). Rendering stars at one sample per dot
 * does NOT match the original.
 */
export const XSCALE = 3;

/** Raster geometry, in dots (not subpixels). */
export const HTOTAL = 384;
export const VTOTAL = 264;

/** Vertical blanking window, in scanlines. */
export const VBEND = 16;
export const VBSTART = 240;

/** Visible raster in hardware orientation: 256 wide x 224 tall. */
export const SCREEN_W = 256;
export const SCREEN_H = VBSTART - VBEND; // 224

/**
 * Visible area as the player sees it. The monitor is rotated 90 degrees, so the
 * 256x224 hardware raster is presented as a 224x256 portrait screen.
 */
export const VISIBLE_W = SCREEN_H; // 224
export const VISIBLE_H = SCREEN_W; // 256

/** Horizontal sync: XTAL/3/192/2 = 16000 Hz. */
export const HSYNC = DOT_CLOCK / 192 / 2; // 16_000

/**
 * Frame rate: HSYNC/132/2 = 60.60606... Hz.
 *
 * This is NOT 60 Hz. Over a minute the difference is about 36 frames, which is
 * audible in the background hum and visible in the swarm's sweep period.
 */
export const REFRESH_RATE = HSYNC / 132 / 2; // 60.606060...

/** Nominal frame period in milliseconds. */
export const FRAME_MS = 1000 / REFRESH_RATE; // ~16.5

/** VBLANK duration in microseconds: (1/VSYNC) * (20/132). */
export const VBLANK_US = (1 / REFRESH_RATE) * (20 / 132) * 1_000_000; // 2500

/** Watchdog trips after this many frames without a kick. */
export const WATCHDOG_VBLANK_COUNT = 8;

/** Discrete sound section clock: XTAL/6/2 = 1.536 MHz. */
export const SOUND_CLOCK = MASTER_CLOCK / 6 / 2; // 1_536_000

/** Noise/star LFSR clock rate: XTAL/3*2 = 12.288 MHz. */
export const RNG_RATE = (MASTER_CLOCK / 3) * 2; // 12_288_000

/**
 * Drives `tick` at the hardware refresh rate using requestAnimationFrame.
 *
 * The display is almost certainly 60 Hz (or some multiple), not 60.606 Hz, so
 * we accumulate real elapsed time and emit exactly as many game frames as have
 * become due. That keeps the game's internal clock locked to the original
 * hardware rate rather than to the host's refresh rate.
 */
export class FrameClock {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Never simulate more than this many frames after a stall (tab backgrounded). */
  private static readonly MAX_CATCHUP = 4;

  constructor(private readonly onFrame: () => void) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.accumulator += now - this.lastTime;
      this.lastTime = now;
      let frames = Math.floor(this.accumulator / FRAME_MS);
      if (frames > FrameClock.MAX_CATCHUP) {
        frames = FrameClock.MAX_CATCHUP;
        this.accumulator = 0;
      } else {
        this.accumulator -= frames * FRAME_MS;
      }
      for (let i = 0; i < frames; i++) this.onFrame();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}
