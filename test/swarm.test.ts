import { describe, it, expect } from 'vitest';
import { Swarm, SWARM_LAYOUT, ALIENS_PER_STAGE, swarmIndex, SWARM_FLAG_COUNT } from '../src/game/swarm';
import { buildGfx, CHAR_SPACE } from '../src/video/gfx';

describe('alien formation', () => {
  it('starts a stage with the canonical 46 aliens', () => {
    const swarm = new Swarm();
    swarm.reset();
    expect(ALIENS_PER_STAGE).toBe(46);
    expect(swarm.aliveCount).toBe(46);
  });

  it('has the 2 + 6 + 8 + 10 + 10 + 10 row structure', () => {
    const counts = SWARM_LAYOUT.map((r) => r.columns.length);
    expect(counts).toEqual([2, 6, 8, 10, 10, 10]);
    const kinds = SWARM_LAYOUT.map((r) => r.kind);
    expect(kinds).toEqual(['flagship', 'red', 'purple', 'blue', 'blue', 'blue']);
  });

  it('stacks the rows down the screen with no overlapping character columns', () => {
    // A character column is the player's vertical axis, so these offsets are
    // what puts flagships at the top and the blue rows at the bottom.
    const spans = SWARM_LAYOUT.map((r) => [r.charCol, r.charCol + (r.wide ? 1 : 0)] as const);
    expect(spans).toEqual([
      [4, 5],
      [6, 6],
      [7, 8],
      [9, 9],
      [10, 11],
      [12, 12],
    ]);
    // Contiguous, no gaps and no overlaps.
    const used = spans.flatMap(([a, b]) => (a === b ? [a] : [a, b]));
    expect(used).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('centres the narrower rows over the wider ones', () => {
    const [flag, red, purple, blue] = SWARM_LAYOUT;
    expect(blue!.columns).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(purple!.columns).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(red!.columns).toEqual([5, 6, 7, 8, 9, 10]);
    expect(flag!.columns).toEqual([6, 9]);
  });

  it('keeps the flags array within its 128 bytes', () => {
    const swarm = new Swarm();
    swarm.reset();
    expect(swarm.flags.length).toBe(SWARM_FLAG_COUNT);
    for (const row of SWARM_LAYOUT) {
      for (const col of row.columns) {
        const i = swarmIndex(row.row, col);
        expect(i).toBeLessThan(SWARM_FLAG_COUNT);
        expect(swarm.flags[i]).toBe(1);
      }
    }
  });

  it('clears a column flag only once its last alien is gone', () => {
    const swarm = new Swarm();
    swarm.reset();
    expect(swarm.columnFlags[3]).toBe(1);
    // Column 3 is only populated by the three blue rows.
    for (const row of SWARM_LAYOUT.filter((r) => r.columns.includes(3))) {
      expect(swarm.columnFlags[3]).toBe(1);
      swarm.remove(row.row, 3);
    }
    expect(swarm.columnFlags[3]).toBe(0);
    expect(swarm.remove(SWARM_LAYOUT[5]!.row, 3)).toBe(false);
  });

  it('sweeps side to side and turns around at the edges', () => {
    const swarm = new Swarm();
    swarm.reset();
    const seen = new Set<number>();
    let reversals = 0;
    let previous = swarm.direction;
    for (let frame = 0; frame < 4000; frame++) {
      swarm.update();
      seen.add(swarm.scroll16 >> 8);
      if (swarm.direction !== previous) {
        reversals++;
        previous = swarm.direction;
      }
    }
    expect(reversals).toBeGreaterThanOrEqual(2);
    // The sweep stays inside the range that keeps every column on screen.
    const scrolls = [...seen];
    expect(Math.min(...scrolls)).toBeGreaterThanOrEqual(12 * 16 - 224 - 4);
    expect(Math.max(...scrolls)).toBeLessThanOrEqual(3 * 16 - 16 + 4);
  });

  it('paints the formation into character RAM and leaves the rest blank', () => {
    const swarm = new Swarm();
    swarm.reset();
    const videoram = new Uint8Array(0x400).fill(CHAR_SPACE);
    const objram = new Uint8Array(0x100);
    swarm.draw(videoram, objram);

    let painted = 0;
    for (const v of videoram) if (v !== CHAR_SPACE) painted++;
    // 2 flagships and 18 wide aliens at 4 cells each, 26 narrow ones at 2.
    expect(painted).toBe((2 + 8 + 10) * 4 + (6 + 10 + 10) * 2);

    // Every painted ordinal must resolve to a non-empty glyph.
    const { chars } = buildGfx();
    for (const v of videoram) {
      if (v === CHAR_SPACE) continue;
      expect(chars[v]!.some((p) => p !== 0)).toBe(true);
    }
  });

  it('writes a colour code and a shared scroll value for the formation columns', () => {
    const swarm = new Swarm();
    swarm.reset();
    const videoram = new Uint8Array(0x400).fill(CHAR_SPACE);
    const objram = new Uint8Array(0x100);
    swarm.update();
    swarm.draw(videoram, objram);

    for (const row of SWARM_LAYOUT) {
      expect(objram[row.charCol * 2 + 1]).toBe(row.colorCode);
    }
    // All formation columns scroll together, which is what moves the swarm.
    const scroll = swarm.scroll;
    for (const row of SWARM_LAYOUT) {
      expect(objram[row.charCol * 2]).toBe(scroll);
    }
  });
});
