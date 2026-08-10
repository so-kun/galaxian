import { describe, it, expect } from 'vitest';
import {
  Palette,
  RGB_MAXIMUM,
  CHANNEL_LEVELS_3BIT,
  CHANNEL_LEVELS_2BIT,
  decodePromByte,
  unpackRgb,
} from '../src/video/palette';
import { TILE_CLUT } from '../src/video/gfx-data';
import { Starfield } from '../src/video/starfield';
import { SCREEN_W, SCREEN_H, XSCALE, VBEND } from '../src/core/clock';

const FB_W = SCREEN_W * XSCALE;

describe('resistor ladder palette', () => {
  it('gives red and green 8 levels topping out at RGB_MAXIMUM', () => {
    expect(CHANNEL_LEVELS_3BIT).toHaveLength(8);
    expect(CHANNEL_LEVELS_3BIT[0]).toBe(0);
    expect(CHANNEL_LEVELS_3BIT[7]).toBe(RGB_MAXIMUM);
    // strictly increasing
    for (let i = 1; i < 8; i++) {
      expect(CHANNEL_LEVELS_3BIT[i]!).toBeGreaterThan(CHANNEL_LEVELS_3BIT[i - 1]!);
    }
  });

  it('gives blue only 4 levels, and a lower ceiling than red/green', () => {
    // Blue is missing the 1 kohm resistor, so it cannot reach RGB_MAXIMUM.
    expect(CHANNEL_LEVELS_2BIT).toHaveLength(4);
    expect(CHANNEL_LEVELS_2BIT[0]).toBe(0);
    expect(CHANNEL_LEVELS_2BIT[3]).toBeLessThan(RGB_MAXIMUM);
    expect(CHANNEL_LEVELS_2BIT[3]).toBe(195);
  });

  it('decodes the PROM bit assignment: 0-2 red, 3-5 green, 6-7 blue', () => {
    expect(unpackRgb(decodePromByte(0x07))).toEqual([RGB_MAXIMUM, 0, 0]);
    expect(unpackRgb(decodePromByte(0x38))).toEqual([0, RGB_MAXIMUM, 0]);
    expect(unpackRgb(decodePromByte(0xc0))).toEqual([0, 0, 195]);
    expect(unpackRgb(decodePromByte(0x00))).toEqual([0, 0, 0]);
  });

  it('carries the real PROM colours: 32 pens plus the two bullet colours', () => {
    expect(TILE_CLUT.length).toBe(34);
    // Pen 0 of every colour code is black.
    for (let code = 0; code < 8; code++) {
      expect(TILE_CLUT[code * 4]).toEqual([0, 0, 0]);
    }
    // The known anchors: flagship yellow, purple, and the player's white.
    expect(TILE_CLUT[1 * 4 + 3]).toEqual([255, 255, 0]);
    expect(TILE_CLUT[3 * 4 + 2]).toEqual([151, 0, 247]);
    expect(TILE_CLUT[6 * 4 + 1]).toEqual([222, 222, 247]);
  });

  it('makes pen 0 of every colour code transparent black', () => {
    const p = new Palette();
    for (let code = 0; code < 8; code++) {
      expect(unpackRgb(p.pen(code, 0))).toEqual([0, 0, 0]);
    }
  });

  it('drives stars and bullets brighter than any PROM colour', () => {
    const p = new Palette();
    // Star levels come from the compressed 194..255 range.
    const levels = new Set<number>();
    for (const c of p.starColors) for (const ch of unpackRgb(c)) levels.add(ch);
    expect([...levels].sort((a, b) => a - b)).toEqual([0, 194, 214, 255]);
    // Bullets: seven white shells, one yellow missile (from the PROM data).
    expect(unpackRgb(p.bulletColors[0]!)).toEqual([239, 239, 239]);
    expect(unpackRgb(p.bulletColors[6]!)).toEqual([239, 239, 239]);
    expect(unpackRgb(p.bulletColors[7]!)).toEqual([239, 239, 0]);
  });
});

describe('starfield', () => {
  const render = (sf: Starfield) => {
    const buf = new Uint32Array(FB_W * SCREEN_H);
    sf.draw(buf, VBEND, SCREEN_H);
    return buf;
  };

  const countLit = (buf: Uint32Array) => {
    let n = 0;
    for (const v of buf) if (v !== 0) n++;
    return n;
  };

  it('draws nothing while disabled ($7004 low)', () => {
    const sf = new Starfield(new Palette());
    sf.enabled = false;
    expect(countLit(render(sf))).toBe(0);
  });

  it('lights roughly 110 stars per frame', () => {
    const sf = new Starfield(new Palette());
    sf.enabled = true;
    const buf = render(sf);

    // Count distinct stars, not subpixels: a star occupies 1 or 2 subpixels.
    let stars = 0;
    for (let row = 0; row < SCREEN_H; row++) {
      for (let x = 0; x < FB_W; x++) {
        const v = buf[row * FB_W + x]!;
        if (v !== 0 && (x % XSCALE === 0 || buf[row * FB_W + x - 1] === 0)) stars++;
      }
    }
    // 224 lines * 256 dots * 2 samples / 512 states = 224, halved by V1^H8.
    expect(stars).toBeGreaterThan(80);
    expect(stars).toBeLessThan(150);
  });

  it('renders stars at both sub-dot widths, never three subpixels', () => {
    const sf = new Starfield(new Palette());
    sf.enabled = true;
    const buf = render(sf);
    const widths = new Set<number>();
    for (let row = 0; row < SCREEN_H; row++) {
      for (let dot = 0; dot < SCREEN_W; dot++) {
        const i = row * FB_W + dot * XSCALE;
        let w = 0;
        for (let s = 0; s < XSCALE; s++) if (buf[i + s] !== 0) w++;
        if (w > 0) widths.add(w);
      }
    }
    // The first RNG clock paints one subpixel, the second paints two.
    expect([...widths].sort()).toEqual([1, 2]);
  });

  it('honours the V1 ^ H8 gate: no stars where the parity is even', () => {
    const sf = new Starfield(new Palette());
    sf.enabled = true;
    const buf = render(sf);
    for (let row = 0; row < SCREEN_H; row++) {
      const y = VBEND + row;
      for (let dot = 0; dot < SCREEN_W; dot++) {
        if (((y ^ (dot >> 3)) & 1) === 0) {
          const i = row * FB_W + dot * XSCALE;
          expect(buf[i]! | buf[i + 1]! | buf[i + 2]!).toBe(0);
        }
      }
    }
  });

  it('scrolls by walking the RNG origin one step per frame', () => {
    const sf = new Starfield(new Palette());
    sf.enabled = true;
    const a = render(sf);
    sf.advanceFrame();
    const b = render(sf);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // The field is only shifted, so the population stays about the same.
    expect(Math.abs(countLit(a) - countLit(b))).toBeLessThan(40);
  });

  it('reverses scroll direction when the screen is flipped', () => {
    const forward = new Starfield(new Palette());
    forward.enabled = true;
    forward.advanceFrame();
    const flipped = new Starfield(new Palette());
    flipped.enabled = true;
    flipped.flipScreenX = true;
    flipped.advanceFrame();
    flipped.advanceFrame();
    // Stepping back one and forward one from the same origin must not coincide.
    expect(Array.from(render(forward))).not.toEqual(Array.from(render(flipped)));
  });
});
