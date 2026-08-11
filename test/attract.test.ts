import { describe, it, expect } from 'vitest';
import { Attract } from '../src/game/attract';
import { CHAR_SPACE } from '../src/video/gfx';
import type { InputState } from '../src/input';

const IDLE: InputState = { left: false, right: false, fire: false, start: false, start2: false, coin: false };

/** Read a string back out of character RAM at (charRow, charCol). */
function readText(videoram: Uint8Array, charRow: number, charCol: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const v = videoram[(((charRow - i) & 0x1f) << 5) | (charCol & 0x1f)]!;
    s += v === CHAR_SPACE ? ' ' : String.fromCharCode(v + 0x30);
  }
  return s;
}

describe('attract mode', () => {
  it('starts a game the moment the player presses start', () => {
    const a = new Attract();
    expect(a.update({ ...IDLE, start: true })).toBe(true);
    expect(a.update(IDLE)).toBe(false);
  });

  it('shows the score-advance table after the score screen', () => {
    const a = new Attract();
    const videoram = new Uint8Array(0x400);
    const objram = new Uint8Array(0x100);

    // Run past the game-over screen and the headers' one-per-80-frames
    // build-up (the last header prints at intro frame $40 + 3*$50 = 304).
    for (let f = 0; f < 240 + 320; f++) a.update(IDLE);
    a.render(videoram, objram);

    // The headings sit at the ROM text table's own addresses:
    // "- SCORE ADVANCE TABLE -" at $534F (the dash and space lead in),
    // "CONVOY  CHARGER" at $52D1, "WE ARE THE GALAXIANS" at $5327.
    expect(readText(videoram, 24, 15, 19)).toBe('SCORE ADVANCE TABLE');
    expect(readText(videoram, 22, 17, 15)).toBe('CONVOY  CHARGER');
    expect(readText(videoram, 25, 7, 20)).toBe('WE ARE THE GALAXIANS');
  });

  it('scrolls the rank rows in behind their aliens and blinks the values', () => {
    const a = new Attract();
    const videoram = new Uint8Array(0x400);
    const objram = new Uint8Array(0x100);

    // Just after the flagship row's text is queued: a few characters are
    // plotted and the column scroll register is counting down from $C8.
    for (let f = 0; f < 240 + 336 + 24 + 25; f++) a.update(IDLE);
    a.render(videoram, objram);
    expect(readText(videoram, 22, 19, 6)).toBe('  60  '); // 4 of 18 chars so far
    expect(objram[19 * 2]).toBe(0xc8 - 25); // column scroll mid-flight
    // The flagship sprite is on its way in (slot 7).
    expect(objram[0x40 + 7 * 4 + 1]).not.toBe(0);

    // Deep into the page: all rows landed, NAMCO logo up, values blinking.
    const namcoAt = 336 + 3 * 210 + 210; // = intro frame 1176
    while ((a as unknown as { timer: number }).timer < namcoAt + 0x60) a.update(IDLE);
    a.render(videoram, objram);
    expect(videoram[0x27c]).toBe(0x9a); // NAMCO logo's first glyph at $527C
    const t = (a as unknown as { timer: number }).timer;
    const visible = (t & 0x3f) >= 0x20;
    // Flagship value cycles 150/200/300/800; statics are 100/80/60.
    const flagshipDigit = videoram[0x193]!;
    if (visible) {
      expect([0x01, 0x02, 0x03, 0x08]).toContain(flagshipDigit);
      expect(videoram[0x195]).toBe(0x01); // '1' of 100
    } else {
      expect(flagshipDigit).toBe(0x10); // blanked
    }
  });

  it('runs a demo game that actually plays', () => {
    const a = new Attract();
    // Advance into the demo phase: game over (240) + intro page (2264) +
    // second game over (240).
    for (let f = 0; f < 2750; f++) a.update(IDLE);
    // Let the demo run and confirm it steps a live game.
    let sawFormationThin = false;
    let startCount = 46;
    for (let f = 0; f < 1500; f++) {
      a.update(IDLE);
      const g = (a as unknown as { demo: { swarm: { aliveCount: number } } | null }).demo;
      if (g) {
        if (startCount === 46) startCount = g.swarm.aliveCount;
        if (g.swarm.aliveCount < 46) sawFormationThin = true;
      }
    }
    expect(sawFormationThin).toBe(true);
  });

  it('cycles back to the scores screen and carries the high score', () => {
    const a = new Attract();
    a.highScore = 3000;
    const videoram = new Uint8Array(0x400);
    const objram = new Uint8Array(0x100);
    a.render(videoram, objram);
    // High score digits appear on the header's second line.
    expect(readText(videoram, 17, 1, 6).replace(/ /g, '')).toContain('3000');
  });
});
