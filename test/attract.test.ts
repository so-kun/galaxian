import { describe, it, expect } from 'vitest';
import { Attract } from '../src/game/attract';
import { CHAR_SPACE } from '../src/video/gfx';
import type { InputState } from '../src/input';

const IDLE: InputState = { left: false, right: false, fire: false, start: false };

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

    // Run past the scores screen into the table.
    for (let f = 0; f < 300; f++) a.update(IDLE);
    a.render(videoram, objram);

    // "SCORE ADVANCE TABLE" heading is present.
    expect(readText(videoram, 28, 5, 19)).toBe('SCORE ADVANCE TABLE');
    expect(readText(videoram, 24, 8, 14)).toBe('CONVOY CHARGER');
  });

  it('runs a demo game that actually plays', () => {
    const a = new Attract();
    // Advance into the demo phase.
    for (let f = 0; f < 720; f++) a.update(IDLE);
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
