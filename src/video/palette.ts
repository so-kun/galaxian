/**
 * Colour generation.
 *
 * Tile and sprite colours come from a 32-byte PROM at board position 6L, fed
 * into a resistor ladder DAC. Stars and bullets bypass the PROM entirely and
 * have their own resistor networks, which is why they can be brighter than any
 * PROM colour.
 *
 * Ladder wiring (MAME `galaxian_v.cpp`, transcribed from the schematics):
 *
 *   bit 7 -- 220 ohm -- BLUE
 *         -- 470 ohm -- BLUE
 *         -- 220 ohm -- GREEN
 *         -- 470 ohm -- GREEN
 *         -- 1 kohm  -- GREEN
 *         -- 220 ohm -- RED
 *         -- 470 ohm -- RED
 *   bit 0 -- 1 kohm  -- RED
 *
 * Note blue has only two resistors: it is a 2-bit channel, so blue saturates
 * lower than red and green. That asymmetry is visible in the game.
 */

/**
 * Ceiling for PROM-derived colours. The star and shell/missile networks sit in
 * parallel with the tile/sprite ladder, so the main graphics are deliberately
 * not driven to 255 -- that headroom is what makes stars and bullets read as
 * brighter than anything else on screen.
 */
export const RGB_MAXIMUM = 224;

const RGB_RESISTANCES = [1000, 470, 220] as const;

/**
 * Per-bit weights for a resistor ladder, normalised the way MAME's
 * `compute_resistor_weights()` does with a negative scaler: each bit's
 * contribution is proportional to its conductance, and a single scale factor --
 * derived from whichever network has the highest total conductance -- is shared
 * across all three channels.
 *
 * Sharing the scale is what keeps blue dimmer than red/green rather than
 * silently rescaling it up to full range.
 */
function resistorWeights(resistances: readonly number[], scale: number): number[] {
  return resistances.map((r) => scale / r);
}

function computeWeights(): { r: number[]; g: number[]; b: number[] } {
  const conductance = (rs: readonly number[]) => rs.reduce((sum, r) => sum + 1 / r, 0);
  // Red and green (three resistors) have the higher total conductance, so they
  // define the scale; blue (two resistors) inherits it and tops out lower.
  const maxConductance = Math.max(
    conductance(RGB_RESISTANCES),
    conductance(RGB_RESISTANCES.slice(1)),
  );
  const scale = RGB_MAXIMUM / maxConductance;
  return {
    r: resistorWeights(RGB_RESISTANCES, scale),
    g: resistorWeights(RGB_RESISTANCES, scale),
    b: resistorWeights(RGB_RESISTANCES.slice(1), scale),
  };
}

const WEIGHTS = computeWeights();

function combine(weights: number[], bits: number[]): number {
  let v = 0;
  for (let i = 0; i < weights.length; i++) v += weights[i]! * bits[i]!;
  return Math.round(v);
}

/** The eight levels a 3-bit channel can take: 0, 29, 62, 91, 133, 162, 195, 224. */
export const CHANNEL_LEVELS_3BIT = Array.from({ length: 8 }, (_, v) =>
  combine(WEIGHTS.r, [v & 1, (v >> 1) & 1, (v >> 2) & 1]),
);

/** The four levels the 2-bit blue channel can take: 0, 62, 133, 195. */
export const CHANNEL_LEVELS_2BIT = Array.from({ length: 4 }, (_, v) =>
  combine(WEIGHTS.b, [v & 1, (v >> 1) & 1]),
);

/** Decode one PROM byte into a packed 0xAABBGGRR value (ImageData order). */
export function decodePromByte(byte: number): number {
  const r = combine(WEIGHTS.r, [byte & 1, (byte >> 1) & 1, (byte >> 2) & 1]);
  const g = combine(WEIGHTS.g, [(byte >> 3) & 1, (byte >> 4) & 1, (byte >> 5) & 1]);
  const b = combine(WEIGHTS.b, [(byte >> 6) & 1, (byte >> 7) & 1]);
  return packRgb(r, g, b);
}

/** Pack into the little-endian RGBA word an ImageData Uint32Array view expects. */
export function packRgb(r: number, g: number, b: number): number {
  return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function unpackRgb(v: number): [number, number, number] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
}

/**
 * Contents of the 6L colour PROM.
 *
 * IMPORTANT: these 32 bytes are a *reconstruction*, not a dump. The original
 * PROM is copyrighted ROM data and no free dump is legitimately available, so
 * the values here were chosen to land on the same quantisation lattice the
 * hardware produces (8 red levels x 8 green x 4 blue) and to match the colours
 * the game is known to display. `loadColorProm()` will replace them wholesale
 * if a real dump is ever supplied.
 *
 * Layout: entry = colourCode * 4 + pen. Pen 0 is always transparent/black.
 */
export const DEFAULT_COLOR_PROM = Uint8Array.from([
  // code 0 -- swarm blue / general blue
  0x00, 0xc0, 0xf6, 0x07,
  // code 1 -- swarm purple
  0x00, 0xc7, 0xf6, 0x07,
  // code 2 -- swarm red
  0x00, 0x07, 0xf6, 0x3f,
  // code 3 -- flagship yellow
  0x00, 0x3f, 0xf6, 0x07,
  // code 4 -- player ship
  0x00, 0xf8, 0xf6, 0x3f,
  // code 5 -- explosion
  0x00, 0x07, 0x3f, 0xf6,
  // code 6 -- text / HUD white
  0x00, 0xf6, 0x3f, 0x07,
  // code 7 -- accent
  0x00, 0xf8, 0xc0, 0xf6,
]);

/** Number of colour codes selectable by a tile/sprite attribute byte. */
export const COLOR_CODES = 8;
/** Pens per colour code (graphics are 2 bits per pixel). */
export const PENS_PER_CODE = 4;

export class Palette {
  /** 32 packed RGBA entries decoded from the PROM. */
  readonly pens = new Uint32Array(COLOR_CODES * PENS_PER_CODE);
  /** 64 packed RGBA entries for the starfield. */
  readonly starColors = new Uint32Array(64);
  /** 8 packed RGBA entries for the bullet/shell outputs. */
  readonly bulletColors = new Uint32Array(8);

  constructor(prom: Uint8Array = DEFAULT_COLOR_PROM) {
    this.loadColorProm(prom);
    this.buildStarColors();
    this.buildBulletColors();
  }

  loadColorProm(prom: Uint8Array): void {
    for (let i = 0; i < this.pens.length; i++) {
      this.pens[i] = decodePromByte(prom[i] ?? 0);
    }
  }

  /**
   * Star colours.
   *
   * The star generator drives each channel through a 150 ohm (LSB) and a 100
   * ohm (MSB) resistor, in parallel with the tile/sprite ladder whose fully-on
   * resistance is ~130 ohms. Normalising 130 ohms to RGB_MAXIMUM gives three
   * possible star drive levels, the highest of which would land well above 255,
   * so the range is compressed proportionally into 194..255.
   */
  private buildStarColors(): void {
    const minval = Math.trunc((RGB_MAXIMUM * 130) / 150);
    const midval = Math.trunc((RGB_MAXIMUM * 130) / 100);
    const maxval = Math.trunc((RGB_MAXIMUM * 130) / 60);
    const starmap = [
      0,
      minval,
      minval + Math.trunc(((255 - minval) * (midval - minval)) / (maxval - minval)),
      255,
    ];
    for (let i = 0; i < 64; i++) {
      // bit 5 = red @150 ohm, bit 4 = red @100 ohm (and so on down the word)
      const r = starmap[(((i >> 4) & 1) << 1) | ((i >> 5) & 1)]!;
      const g = starmap[(((i >> 2) & 1) << 1) | ((i >> 3) & 1)]!;
      const b = starmap[(((i >> 0) & 1) << 1) | ((i >> 1) & 1)]!;
      this.starColors[i] = packRgb(r, g, b);
    }
  }

  /** Shells (entries 0-6) render white; the missile (entry 7) renders yellow. */
  private buildBulletColors(): void {
    for (let i = 0; i < 7; i++) this.bulletColors[i] = packRgb(0xff, 0xff, 0xff);
    this.bulletColors[7] = packRgb(0xff, 0xff, 0x00);
  }

  /** Look up a pen for a given colour code (0-7) and pixel value (0-3). */
  pen(colorCode: number, pixel: number): number {
    return this.pens[((colorCode & 7) << 2) | (pixel & 3)]!;
  }
}
