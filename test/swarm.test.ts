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

  it('sweeps one pixel every fourth frame and turns at the extents', () => {
    const swarm = new Swarm();
    swarm.reset();
    let reversals = 0;
    let previous = swarm.direction;
    let min = 0;
    let max = 0;
    for (let frame = 0; frame < 8000; frame++) {
      swarm.update(frame, null);
      min = Math.min(min, swarm.scroll16);
      max = Math.max(max, swarm.scroll16);
      if (swarm.direction !== previous) {
        reversals++;
        previous = swarm.direction;
      }
    }
    expect(reversals).toBeGreaterThanOrEqual(2);
    // Full formation: extents are +$22 (left) and -$20 (right).
    expect(max).toBe(0x22);
    expect(min).toBe(-0x20);
  });

  it('holds the column the player bullet is about to hit', () => {
    const swarm = new Swarm();
    swarm.reset();
    // Park a bullet inside the swarm band, aligned with column 6.
    const bullet = { x: 0x40, y: (6 * 16 + (swarm.scroll16 & 0xff)) & 0xff };
    const before = swarm.scroll16;
    for (let frame = 0; frame < 64; frame++) swarm.update(frame, bullet);
    expect(swarm.scroll16).toBe(before);
    // Without a bullet the swarm moves in the same span of frames.
    for (let frame = 0; frame < 64; frame++) swarm.update(frame, null);
    expect(swarm.scroll16).not.toBe(before);
  });

  it('widens its sweep as edge columns empty', () => {
    const swarm = new Swarm();
    swarm.reset();
    for (const row of SWARM_LAYOUT) swarm.remove(row.row, 3);
    for (const row of SWARM_LAYOUT) swarm.remove(row.row, 12);
    let min = 0;
    let max = 0;
    for (let frame = 0; frame < 16000; frame++) {
      swarm.update(frame, null);
      min = Math.min(min, swarm.scroll16);
      max = Math.max(max, swarm.scroll16);
    }
    expect(max).toBe(0x32);
    expect(min).toBe(-0x30);
  });

  it('paints the formation into character RAM and leaves the rest blank', () => {
    const swarm = new Swarm();
    swarm.reset();
    const videoram = new Uint8Array(0x400).fill(CHAR_SPACE);
    const objram = new Uint8Array(0x100);
    swarm.draw(videoram, objram, 0);

    let painted = 0;
    for (const v of videoram) if (v !== CHAR_SPACE) painted++;
    // 2 flagships and 18 wide aliens at 4 cells each, 26 narrow ones at 2.
    expect(painted).toBe((2 + 8 + 10) * 4 + (6 + 10 + 10) * 2);

    // Most painted ordinals resolve to non-empty glyphs. (Some frames of the
    // real artwork legitimately leave a companion cell blank, e.g. $42.)
    const { chars } = buildGfx();
    let nonEmpty = 0;
    let total = 0;
    for (const v of videoram) {
      if (v === CHAR_SPACE) continue;
      total++;
      if (chars[v]!.some((p) => p !== 0)) nonEmpty++;
    }
    expect(nonEmpty / total).toBeGreaterThan(0.85);
  });

  it('writes a colour code and a shared scroll value for the formation columns', () => {
    const swarm = new Swarm();
    swarm.reset();
    const videoram = new Uint8Array(0x400).fill(CHAR_SPACE);
    const objram = new Uint8Array(0x100);
    for (let f = 0; f < 8; f++) swarm.update(f, null);
    swarm.draw(videoram, objram, 8);

    for (const row of SWARM_LAYOUT) {
      expect(objram[row.charCol * 2 + 1]).toBe(row.colorCode);
    }
    // All formation columns get the negated scroll low byte.
    const offset = (256 - (swarm.scroll16 & 0xff)) & 0xff;
    for (const row of SWARM_LAYOUT) {
      expect(objram[row.charCol * 2]).toBe(offset);
    }
  });
});
