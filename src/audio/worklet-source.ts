/**
 * The discrete sound section, as an AudioWorklet.
 *
 * Delivered as a source string and loaded from a Blob URL so it needs no build
 * configuration and no separate asset.
 *
 * This is a model of the circuit, not a netlist simulation, and it is worth
 * being clear that exact Galaxian audio is unsolved even in MAME -- the
 * driver's TODO has said "background humming is incorrect, it's faster on a
 * real machine" and "explosion sound is much softer, filter involved?" since
 * the 1990s, and the audio device notes that the CD4066 switch mixing cannot be
 * reproduced by a discrete core at all. What is reproduced faithfully here is
 * the structure and the arithmetic:
 *
 *  - the tone divider chain and, critically, which of its taps are audible;
 *  - the same 17-bit LFSR the video starfield uses, as the noise source;
 *  - separate HIT (filtered, decaying) and FIRE (fixed-length pulse) paths.
 *
 * The one thing most easily got wrong: `SOUND_CLOCK / (256 - pitch)` is the
 * clock going *into* the 74393, not a pitch. The audible output is taken from
 * the QA, QC and QD taps, so the note you hear is that clock divided by 2, 8
 * and 16. Treating the divider input as the note is wrong by 2 to 16 times.
 */

export const WORKLET_SOURCE = String.raw`
const SOUND_CLOCK = 1536000;

// 17-bit LFSR: bit12 XNOR bit0 shifted into bit16. The same register drives the
// starfield in the video section.
class Lfsr {
  constructor() { this.state = 0; }
  step() {
    this.state = ((this.state >> 1) | (((((this.state >> 12) ^ ~this.state) & 1) << 16))) & 0x1ffff;
    return this.state & 1;
  }
}

// One-pole low-pass, standing in for the op-amp filters on the noise paths.
class LowPass {
  constructor(cutoff, rate) {
    this.a = Math.exp(-2 * Math.PI * cutoff / rate);
    this.z = 0;
  }
  process(x) {
    this.z = x * (1 - this.a) + this.z * this.a;
    return this.z;
  }
}

class GalaxianSound extends AudioWorkletProcessor {
  constructor() {
    super();
    const rate = sampleRate;

    // --- tone section -----------------------------------------------------
    // Pitch latch written to $7800; 0 means silent here.
    this.pitch = 0;
    this.toneEnabled = false;
    this.dividerPhase = 0;   // fractional position within one divider clock
    this.dividerCount = 0;   // the 74393's 4-bit count

    // --- background / drone ----------------------------------------------
    // FS1..FS3 enable three 555 astables; the 4-bit DAC at $6004-$6007 sets a
    // fourth 555 that pulls the whole drone up and down in pitch.
    this.fs = [false, false, false];
    this.bgDac = 0;
    this.bgPhase = [0, 0, 0];

    // --- noise ------------------------------------------------------------
    this.lfsr = new Lfsr();
    this.noisePhase = 0;
    // MAME runs the LFSR at RNG_RATE/100 for performance; what matters is the
    // polynomial and the resulting spectrum, not the literal 12.288 MHz.
    this.noiseStep = 122880 / rate;

    this.hitLevel = 0;       // HIT gates a filtered, decaying noise burst
    this.hitFilter = new LowPass(1200, rate);
    this.fireLevel = 0;      // FIRE triggers a fixed-length pulse via a 555
    this.fireFilter = new LowPass(2600, rate);
    this.firePhase = 0;

    this.rate = rate;
    this.volume = 0.22;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pitch') { this.pitch = m.value & 0xff; }
      else if (m.type === 'tone') { this.toneEnabled = !!m.value; }
      else if (m.type === 'fs') { this.fs[m.index] = !!m.value; }
      else if (m.type === 'bg') { this.bgDac = m.value & 0x0f; }
      else if (m.type === 'hit') { this.hitLevel = 1; }
      else if (m.type === 'fire') { this.fireLevel = 1; this.firePhase = 0; }
      else if (m.type === 'volume') { this.volume = m.value; }
    };
  }

  // Frequency clocking the 74393: SOUND_CLOCK / (256 - pitch).
  dividerClock() {
    return SOUND_CLOCK / (256 - this.pitch);
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const rate = this.rate;

    // A 555 astable's frequency rises with the 4-bit DAC value.
    const bgBase = 60 + this.bgDac * 26;
    const bgFreqs = [bgBase, bgBase * 1.5, bgBase * 2.02];

    for (let i = 0; i < out.length; i++) {
      let sample = 0;

      // --- tone: 74393 taps QA (/2), QC (/8), QD (/16) --------------------
      if (this.toneEnabled && this.pitch > 0) {
        this.dividerPhase += this.dividerClock() / rate;
        while (this.dividerPhase >= 1) {
          this.dividerPhase -= 1;
          this.dividerCount = (this.dividerCount + 1) & 0x0f;
        }
        const qa = (this.dividerCount >> 0) & 1;
        const qc = (this.dividerCount >> 2) & 1;
        const qd = (this.dividerCount >> 3) & 1;
        // Summed through two 47k resistors into a 10k load: the taps are mixed,
        // not selected, which is what gives the tone its stepped character.
        sample += ((qa * 0.34 + qc * 0.33 + qd * 0.33) - 0.5) * 0.9;
      }

      // --- background drone: three 555 astables ---------------------------
      for (let f = 0; f < 3; f++) {
        if (!this.fs[f]) continue;
        this.bgPhase[f] += bgFreqs[f] / rate;
        if (this.bgPhase[f] >= 1) this.bgPhase[f] -= 1;
        sample += (this.bgPhase[f] < 0.5 ? 0.16 : -0.16);
      }

      // --- noise ----------------------------------------------------------
      this.noisePhase += this.noiseStep;
      let bit = this.lfsr.state & 1;
      while (this.noisePhase >= 1) {
        this.noisePhase -= 1;
        bit = this.lfsr.step();
      }
      const noise = bit ? 1 : -1;

      // HIT: filtered noise that decays away.
      if (this.hitLevel > 0) {
        sample += this.hitFilter.process(noise) * this.hitLevel * 0.8;
        this.hitLevel -= 1.6 / rate;
        if (this.hitLevel < 0) this.hitLevel = 0;
      } else {
        this.hitFilter.process(0);
      }

      // FIRE: a short fixed-length pulse whose pitch sweeps down.
      if (this.fireLevel > 0) {
        this.firePhase += 1 / rate;
        const sweep = Math.max(0, 1 - this.firePhase * 6);
        sample += this.fireFilter.process(noise * sweep) * 0.55;
        this.fireLevel -= 3.4 / rate;
        if (this.fireLevel < 0) this.fireLevel = 0;
      } else {
        this.fireFilter.process(0);
      }

      out[i] = Math.max(-1, Math.min(1, sample * this.volume));
    }
    return true;
  }
}

registerProcessor('galaxian-sound', GalaxianSound);
`;
