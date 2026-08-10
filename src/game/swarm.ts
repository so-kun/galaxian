/**
 * The alien formation.
 *
 * The formation is not made of sprites -- it is drawn into character RAM, and
 * swept sideways by writing the per-column scroll registers. Only aliens that
 * have broken away become sprites, which is why at most seven can be in flight
 * at once: there are only eight sprite slots and one is reserved for scratch.
 *
 * `ALIEN_SWARM_FLAGS` at $4100 is a 128-byte occupancy grid, 8 rows of 16
 * columns, of which six rows are used. The disassembly notes it is stored
 * upside down and mirrored horizontally relative to the screen.
 *
 * Row -> character column (from GET_ALIEN_CHAR_RAM_ADDR at $20E1):
 *
 *   flagship    $5004 + col*$40    row 7
 *   red         $5006 + col*$40    row 6
 *   purple      $5007 + col*$40    row 5
 *   blue top    $5009 + col*$40    row 4
 *   blue mid    $500A + col*$40    row 3
 *   blue bottom $500C + col*$40    row 2
 *
 * A character column is the player's *vertical* axis, so those offsets are what
 * stack the formation: flagships at the top, blue at the bottom. A swarm column
 * index maps to two character rows (`col * $40` is two rows of 32), which is
 * the player's horizontal axis.
 */

import { CHAR_SPACE, SWARM_1X2_ORDINALS, SWARM_2X2_ORDINALS, FLAGSHIP_ORDINAL } from '../video/gfx';

export const SWARM_ROWS = 8;
export const SWARM_COLS = 16;
export const SWARM_FLAG_COUNT = SWARM_ROWS * SWARM_COLS; // 128

export type AlienKind = 'flagship' | 'red' | 'purple' | 'blue';

export interface SwarmRow {
  /** Index into the flags array's row dimension. */
  row: number;
  kind: AlienKind;
  /** Character column of the row's top-left cell. */
  charCol: number;
  /** Whether the alien occupies 2x2 character cells (as opposed to 1x2). */
  wide: boolean;
  /** Columns of the grid this row populates at the start of a stage. */
  columns: number[];
  /** Colour code written into the attribute RAM for this row. */
  colorCode: number;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * The six populated rows: 2 flagships + 6 red + 8 purple + 3 x 10 blue = 46.
 *
 * Column spans narrow by one on each side as the rows go up, which is what
 * gives the formation its stepped silhouette. The flagships sit above the red
 * row with a gap between them.
 */
export const SWARM_LAYOUT: SwarmRow[] = [
  { row: 7, kind: 'flagship', charCol: 4, wide: true, columns: [6, 9], colorCode: 3 },
  { row: 6, kind: 'red', charCol: 6, wide: false, columns: range(5, 10), colorCode: 2 },
  { row: 5, kind: 'purple', charCol: 7, wide: true, columns: range(4, 11), colorCode: 1 },
  { row: 4, kind: 'blue', charCol: 9, wide: false, columns: range(3, 12), colorCode: 0 },
  { row: 3, kind: 'blue', charCol: 10, wide: true, columns: range(3, 12), colorCode: 0 },
  { row: 2, kind: 'blue', charCol: 12, wide: false, columns: range(3, 12), colorCode: 0 },
];

/** Character columns the formation occupies, used when writing scroll values. */
export const SWARM_CHAR_COLS = SWARM_LAYOUT.map((r) => r.charCol).flatMap((c) => [c, c + 1]);

export const ALIENS_PER_STAGE = SWARM_LAYOUT.reduce((n, r) => n + r.columns.length, 0); // 46

const rowByIndex = new Map(SWARM_LAYOUT.map((r) => [r.row, r]));

/** Pack a row and column into the flags array index the game uses. */
export function swarmIndex(row: number, col: number): number {
  return (row << 4) | (col & 0x0f);
}

export class Swarm {
  /** ALIEN_SWARM_FLAGS: 1 = alien present. */
  readonly flags = new Uint8Array(SWARM_FLAG_COUNT);
  /** ALIEN_IN_COLUMN_FLAGS at $41F0: which columns still hold anyone. */
  readonly columnFlags = new Uint8Array(SWARM_COLS);

  /** SWARM_DIRECTION at $420D: 0 = left, 1 = right. */
  direction: 0 | 1 = 1;
  /** SWARM_SCROLL_VALUE at $420E, a 16-bit accumulator. */
  scroll16 = 0;

  /** Animation counter; the swarm flaps in four frames. */
  private animTick = 0;

  reset(): void {
    this.flags.fill(0);
    for (const row of SWARM_LAYOUT) {
      for (const col of row.columns) this.flags[swarmIndex(row.row, col)] = 1;
    }
    this.direction = 1;
    this.scroll16 = 0;
    this.animTick = 0;
    this.refreshColumnFlags();
  }

  get aliveCount(): number {
    let n = 0;
    for (const f of this.flags) if (f) n++;
    return n;
  }

  /** Remove an alien; returns false if the cell was already empty. */
  remove(row: number, col: number): boolean {
    const i = swarmIndex(row, col);
    if (!this.flags[i]) return false;
    this.flags[i] = 0;
    this.refreshColumnFlags();
    return true;
  }

  private refreshColumnFlags(): void {
    this.columnFlags.fill(0);
    for (let col = 0; col < SWARM_COLS; col++) {
      for (const row of SWARM_LAYOUT) {
        if (this.flags[swarmIndex(row.row, col)]) {
          this.columnFlags[col] = 1;
          break;
        }
      }
    }
  }

  /** Leftmost and rightmost occupied columns, or null when the swarm is empty. */
  occupiedSpan(): { min: number; max: number } | null {
    let min = -1;
    let max = -1;
    for (let col = 0; col < SWARM_COLS; col++) {
      if (this.columnFlags[col]) {
        if (min < 0) min = col;
        max = col;
      }
    }
    return min < 0 ? null : { min, max };
  }

  /**
   * Sweep the formation.
   *
   * The original speeds up as the swarm thins out; the sweep is driven by a
   * 16-bit accumulator whose high byte becomes the scroll register value, so
   * sub-pixel rates are possible.
   */
  update(): void {
    this.animTick++;

    const span = this.occupiedSpan();
    if (!span) return;

    // Fewer aliens sweep faster. With a full formation this is a slow drift.
    const alive = this.aliveCount;
    const speed = 0x40 + Math.round((ALIENS_PER_STAGE - alive) * 6);

    this.scroll16 += this.direction === 1 ? -speed : speed;

    // A cell at swarm column `col` lands at screen_x = col*16 - scroll - 16, so
    // a more negative scroll pushes the formation right. Turn around when the
    // outermost occupied column would leave the visible 224 pixels.
    const scroll = this.scroll16 >> 8;
    const maxScroll = span.min * 16 - 16; // leftmost column reaches x = 0
    const minScroll = span.max * 16 - 224; // rightmost column reaches x = 208
    if (this.direction === 1 && scroll <= minScroll) this.direction = 0;
    else if (this.direction === 0 && scroll >= maxScroll) this.direction = 1;
  }

  /** Scroll value written to the formation's character columns. */
  get scroll(): number {
    return (this.scroll16 >> 8) & 0xff;
  }

  /**
   * Render the formation into character RAM.
   *
   * The animation frame for each alien is offset by its position so the swarm
   * shimmers rather than flapping in unison.
   */
  draw(videoram: Uint8Array, objram: Uint8Array): void {
    // Clear the formation band, then repaint the occupied cells.
    for (const row of SWARM_LAYOUT) {
      const width = row.wide ? 2 : 1;
      for (let col = 0; col < SWARM_COLS; col++) {
        for (let cy = 0; cy < 2; cy++) {
          for (let cx = 0; cx < width; cx++) {
            videoram[charAddr(col, row.charCol + cx, cy)] = CHAR_SPACE;
          }
        }
      }
    }

    const frameOf = (row: number, col: number) => ((this.animTick >> 3) + row + col) & 3;

    for (const row of SWARM_LAYOUT) {
      // Attribute RAM: colour code per character column.
      const codes = row.wide ? [row.charCol, row.charCol + 1] : [row.charCol];
      for (const c of codes) objram[c * 2 + 1] = row.colorCode;

      for (const col of row.columns) {
        if (!this.flags[swarmIndex(row.row, col)]) continue;
        const frame = frameOf(row.row, col);

        if (row.kind === 'flagship') {
          plot2x2(videoram, col, row.charCol, FLAGSHIP_ORDINAL);
        } else if (row.wide) {
          // ALIEN_SWARM_CHARACTERS_SET_2x2 = {$44,$38,$44,$3C}
          const ordinals = [SWARM_2X2_ORDINALS[2], SWARM_2X2_ORDINALS[0], SWARM_2X2_ORDINALS[2], SWARM_2X2_ORDINALS[1]];
          plot2x2(videoram, col, row.charCol, ordinals[frame]!);
        } else {
          // ALIEN_SWARM_CHARACTERS_SET_1x2 = {$41,$35,$41,$31}
          const ordinals = [SWARM_1X2_ORDINALS[2], SWARM_1X2_ORDINALS[1], SWARM_1X2_ORDINALS[2], SWARM_1X2_ORDINALS[0]];
          plot1x2(videoram, col, row.charCol, ordinals[frame]!);
        }
      }
    }

    // Scroll the formation's character columns together.
    const scroll = this.scroll;
    for (const c of SWARM_CHAR_COLS) objram[c * 2] = scroll;
  }
}

/**
 * Character RAM address for a formation cell.
 *
 * A swarm column occupies two character rows (`col * $40` in the original), and
 * `cy` selects which of the two.
 */
function charAddr(col: number, charCol: number, cy: number): number {
  return (((col * 2 + cy) & 0x1f) << 5) | (charCol & 0x1f);
}

/** PLOT_CHARACTERS_2_BY_2_ASCENDING: base, base+1 on one row, base+2, base+3 below. */
function plot2x2(videoram: Uint8Array, col: number, charCol: number, base: number): void {
  videoram[charAddr(col, charCol, 0)] = base;
  videoram[charAddr(col, charCol + 1, 0)] = base + 1;
  videoram[charAddr(col, charCol, 1)] = base + 2;
  videoram[charAddr(col, charCol + 1, 1)] = base + 3;
}

/** PLOT_TWO_CHARACTERS_IN_SAME_COLUMN: base and base+1 stacked. */
function plot1x2(videoram: Uint8Array, col: number, charCol: number, base: number): void {
  videoram[charAddr(col, charCol, 0)] = base;
  videoram[charAddr(col, charCol, 1)] = base + 1;
}

export { rowByIndex };
