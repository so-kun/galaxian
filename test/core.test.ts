import { describe, it, expect } from 'vitest';
import {
  MASTER_CLOCK,
  CPU_CLOCK,
  DOT_CLOCK,
  HSYNC,
  REFRESH_RATE,
  VBLANK_US,
  HTOTAL,
  VTOTAL,
  XSCALE,
  SCREEN_H,
  VISIBLE_W,
  VISIBLE_H,
  SOUND_CLOCK,
  RNG_RATE,
} from '../src/core/clock';
import {
  LFSR_PERIOD,
  LFSR_LOCKUP_STATE,
  lfsrNext,
  buildLfsrTable,
  starEnabled,
  starColorIndex,
} from '../src/core/lfsr';

describe('timing constants', () => {
  it('derives every clock from the 18.432 MHz crystal', () => {
    expect(MASTER_CLOCK).toBe(18_432_000);
    expect(CPU_CLOCK).toBe(3_072_000); // XTAL/6
    expect(DOT_CLOCK).toBe(6_144_000); // XTAL/3
    expect(SOUND_CLOCK).toBe(1_536_000); // XTAL/6/2
    expect(RNG_RATE).toBe(12_288_000); // XTAL/3*2
  });

  it('produces 16 kHz HSYNC and 60.606 Hz refresh, not 60 Hz', () => {
    expect(HSYNC).toBe(16_000);
    expect(REFRESH_RATE).toBeCloseTo(60.60606, 5);
    expect(REFRESH_RATE).not.toBe(60);
  });

  it('cross-checks the refresh rate against the subpixel raster', () => {
    // MAME feeds set_raw() with a pixel clock of XTAL and HTOTAL of 384*3.
    expect(MASTER_CLOCK / (HTOTAL * XSCALE)).toBe(HSYNC);
    expect(MASTER_CLOCK / (HTOTAL * XSCALE) / VTOTAL).toBeCloseTo(REFRESH_RATE, 9);
  });

  it('has a 2500 us vertical blank spanning 40 scanlines', () => {
    expect(VBLANK_US).toBeCloseTo(2500, 6);
    expect(VTOTAL - SCREEN_H).toBe(40);
    // 40 lines at 62.5 us per line == 2500 us
    expect(40 * (1_000_000 / HSYNC)).toBeCloseTo(2500, 6);
  });

  it('presents a 224x256 portrait screen after the 90 degree rotation', () => {
    expect(SCREEN_H).toBe(224);
    expect(VISIBLE_W).toBe(224);
    expect(VISIBLE_H).toBe(256);
  });
});

describe('17-bit LFSR', () => {
  it('is maximal length: period is exactly 2^17 - 1', () => {
    expect(LFSR_PERIOD).toBe(131071);
    let state = 0;
    let steps = 0;
    do {
      state = lfsrNext(state);
      steps++;
    } while (state !== 0 && steps <= LFSR_PERIOD + 1);
    expect(steps).toBe(LFSR_PERIOD);
  });

  it('locks up only on all-ones, because the feedback is an XNOR', () => {
    expect(lfsrNext(LFSR_LOCKUP_STATE)).toBe(LFSR_LOCKUP_STATE);
    // ...which is why starting from zero (as the hardware does) is safe.
    expect(lfsrNext(0)).not.toBe(0);
  });

  it('visits every state except the lockup state', () => {
    const table = buildLfsrTable();
    expect(table.length).toBe(LFSR_PERIOD);
    const seen = new Set(table);
    expect(seen.size).toBe(LFSR_PERIOD);
    expect(seen.has(LFSR_LOCKUP_STATE)).toBe(false);
  });

  it('lights a star when the top 8 bits are set and bit 0 is clear', () => {
    expect(starEnabled(0x1fe00)).toBe(true);
    expect(starEnabled(0x1fe01)).toBe(false); // low bit set
    expect(starEnabled(0x0fe00)).toBe(false); // top bit clear
  });

  it('produces a star density in the range the hardware is known for', () => {
    const table = buildLfsrTable();
    let lit = 0;
    for (const s of table) if (starEnabled(s)) lit++;
    // 9 of the 17 bits are constrained, so ~1/512 of states light a star.
    expect(lit / LFSR_PERIOD).toBeCloseTo(1 / 512, 3);
  });

  it('yields star colours across the full 64-entry table', () => {
    const table = buildLfsrTable();
    const colors = new Set<number>();
    for (const s of table) if (starEnabled(s)) colors.add(starColorIndex(s));
    expect(colors.size).toBe(64);
    for (const c of colors) expect(c).toBeGreaterThanOrEqual(0);
    for (const c of colors) expect(c).toBeLessThan(64);
  });
});
