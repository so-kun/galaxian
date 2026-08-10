/**
 * The 17-bit linear feedback shift register.
 *
 * One of the more surprising findings about this board: a single LFSR feeds
 * BOTH the video starfield and the audio noise source. It is not two circuits
 * that happen to be similar -- it is the same shift register, tapped twice.
 *
 * Feedback (from MAME `galaxian_v.cpp`, transcribed off the schematics):
 *
 *   shiftreg = (shiftreg >> 1) | ((((shiftreg >> 12) ^ ~shiftreg) & 1) << 16)
 *
 * i.e. bit 12 XOR (NOT bit 0) -- equivalently XNOR(bit12, bit0) -- is shifted
 * into bit 16. This is a maximal-length polynomial, so the period is 2^17 - 1.
 *
 * Note the inversion: because the feedback is an XNOR rather than an XOR, the
 * forbidden self-looping state is all-ones (0x1FFFF), not all-zeros. Starting
 * from 0 is therefore perfectly valid, which is what the hardware does at
 * power-on.
 */

export const LFSR_BITS = 17;
export const LFSR_PERIOD = (1 << LFSR_BITS) - 1; // 131071

/** The state that loops back to itself and must never be entered. */
export const LFSR_LOCKUP_STATE = 0x1ffff;

/** Advance one step. Pure function so it can be used to build lookup tables. */
export function lfsrNext(state: number): number {
  return ((state >> 1) | ((((state >> 12) ^ ~state) & 1) << 16)) & 0x1ffff;
}

/**
 * A star is lit when the top 8 bits are all 1 and the low bit is 0.
 * (MAME: "stars are enabled if the upper 8 bits are 1 and the low bit is 0")
 */
export function starEnabled(state: number): boolean {
  return (state & 0x1fe01) === 0x1fe00;
}

/**
 * Star colour index: the 6 bits sitting just below the top 8, inverted.
 * Yields 0..63, indexing the 64-entry star colour table.
 */
export function starColorIndex(state: number): number {
  return (~state & 0x1f8) >> 3;
}

/**
 * Precomputed full LFSR sequence.
 *
 * The starfield needs random access into the sequence at an arbitrary origin
 * that shifts every frame, so we materialise the whole period once (128 KiB as
 * a Uint32Array) rather than re-running the shift register per pixel.
 */
export function buildLfsrTable(): Uint32Array {
  const table = new Uint32Array(LFSR_PERIOD);
  let state = 0;
  for (let i = 0; i < LFSR_PERIOD; i++) {
    table[i] = state;
    state = lfsrNext(state);
  }
  return table;
}

/** Stateful LFSR, used by the audio noise source. */
export class Lfsr {
  constructor(public state = 0) {}

  step(): number {
    this.state = lfsrNext(this.state);
    return this.state;
  }

  /** Noise output bit. */
  get output(): number {
    return this.state & 1;
  }
}
