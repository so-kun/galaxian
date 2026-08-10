/**
 * Host side of the sound section.
 *
 * The game talks to this the way the Z80 talked to the board: it writes a pitch
 * byte to $7800, toggles FS1..FS3 at $6800, sets the background DAC at
 * $6004-$6007, and pulses HIT and FIRE. Nothing here knows what a "shoot sound"
 * is; that mapping lives in the sound-effect tables, as it did in ROM.
 */

import { WORKLET_SOURCE } from './worklet-source';

/**
 * Sound effects are pitch sequences in ROM, terminated by $E0. These are the
 * three the game plays, transcribed from `galaxian.asm`.
 */
export const SFX_GAME_START = [
  0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x09, 0x08, 0x07, 0x41, 0x42, 0x41, 0x42, 0x45,
  0x42, 0x45, 0x47, 0x45, 0x47, 0x6a, 0x60, 0x41, 0x42, 0x41, 0x42, 0x45, 0x42, 0x45, 0x47, 0x45,
  0x47, 0x6a, 0x60, 0x45, 0x23, 0x24, 0x23, 0x24, 0x23, 0x24, 0x23, 0x24, 0x23, 0x24, 0x23, 0x24,
  0x23, 0x24, 0x23, 0x24, 0x02, 0x03, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x02, 0x03, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a, 0x02, 0x03, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x02, 0x03, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a,
] as const;

/** ALIEN DEATH sound effect, referenced by $1833. */
export const SFX_ALIEN_DEATH = [
  0x08, 0x07, 0x06, 0x05, 0x03, 0x02, 0x08, 0x07, 0x06, 0x05, 0x03, 0x02, 0x02, 0x03, 0x05, 0x06,
  0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0c,
  0x0d,
] as const;

/** FLAGSHIP DEATH sound effect, referenced by $1848. */
export const SFX_FLAGSHIP_DEATH = [
  0x02, 0x17, 0x16, 0x01, 0x16, 0x02, 0x03, 0x05, 0x06, 0x07, 0x18, 0x20, 0x07, 0x06, 0x05, 0x03,
  0x02, 0x03, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x19, 0x20, 0x0a, 0x09, 0x08, 0x07, 0x08, 0x0a, 0x0b,
  0x0c, 0x0d, 0x0e, 0x1a, 0x20, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x10, 0x11,
  0x1b, 0x3c,
] as const;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready = false;

  /** Currently playing pitch sequence, advanced one entry per frame. */
  private sequence: readonly number[] | null = null;
  private sequenceIndex = 0;
  private sequenceHold = 0;

  /** Frames each sound-effect entry is held for. */
  private static readonly SFX_FRAME_HOLD = 2;

  /**
   * Browsers will not start audio without a gesture, so this must be called
   * from a click, key press or touch.
   */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    this.node = new AudioWorkletNode(ctx, 'galaxian-sound', { outputChannelCount: [1] });
    this.node.connect(ctx.destination);
    this.ready = true;
  }

  private send(message: Record<string, unknown>): void {
    if (this.ready && this.node) this.node.port.postMessage(message);
  }

  /** $7800: the sound effect base pitch latch. */
  setPitch(value: number): void {
    this.send({ type: 'pitch', value: value & 0xff });
    this.send({ type: 'tone', value: value !== 0 });
  }

  /** $6800-$6802: FS1..FS3, which gate the three background 555 astables. */
  setBackgroundVoice(index: 0 | 1 | 2, on: boolean): void {
    this.send({ type: 'fs', index, value: on });
  }

  /** $6004-$6007: the 4-bit DAC that sets the background LFO frequency. */
  setBackgroundFrequency(value: number): void {
    this.send({ type: 'bg', value: value & 0x0f });
  }

  /** The HIT line: a filtered, decaying burst of LFSR noise. */
  hit(): void {
    this.send({ type: 'hit' });
  }

  /** The FIRE line: a short fixed-length pulse. */
  fire(): void {
    this.send({ type: 'fire' });
  }

  setVolume(value: number): void {
    this.send({ type: 'volume', value });
  }

  /** Start one of the ROM pitch sequences. */
  playSequence(seq: readonly number[]): void {
    this.sequence = seq;
    this.sequenceIndex = 0;
    this.sequenceHold = 0;
  }

  /** Advance the active pitch sequence; call once per video frame. */
  tick(): void {
    if (!this.sequence) return;
    if (this.sequenceHold-- > 0) return;
    this.sequenceHold = AudioEngine.SFX_FRAME_HOLD;
    if (this.sequenceIndex >= this.sequence.length) {
      this.sequence = null;
      this.setPitch(0);
      return;
    }
    this.setPitch(this.sequence[this.sequenceIndex++]!);
  }

  get isRunning(): boolean {
    return this.ready;
  }
}
