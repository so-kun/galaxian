/**
 * The alien formation, ported from the original game code (via the annotated
 * disassembly and JOTD's line-by-line 68k transcode of it).
 *
 * The formation is drawn into character RAM and swept sideways by the
 * per-column scroll registers. The details below are the original's:
 *
 *  - The sweep moves one unit every fourth frame (`TIMING_VARIABLE & 3 == 0`
 *    in HANDLE_SWARM_MOVEMENT at $093E). It does not speed up as the swarm
 *    thins; the rising tension comes from the sound and the attack cadence.
 *  - The turnaround limits (SWARM_SCROLL_MAX_EXTENTS, $4210) tighten as edge
 *    columns empty: the left limit starts at $22 and grows by $10 per empty
 *    column on the left, the right limit starts at -$20 and shrinks by $10 per
 *    empty column on the right, so a thinned swarm sweeps wider.
 *  - The famous detail at $0910: while the player's shot is climbing through
 *    the swarm's band, the column it is about to hit *stops scrolling* -- the
 *    swarm holds still to meet the bullet.
 *
 * Formation geometry, from GET_ALIEN_CHAR_RAM_ADDR ($20E1) and
 * SET_INFLIGHT_ALIEN_START_POSITION ($1147):
 *
 *   row -> character column: flagship 4, red 6, purple 7, blue 9/10/12
 *   sprite anchor: X = 124 - 12*row,  Y = col*16 + 7 + scroll
 */

import {
  CHAR_SPACE,
  SWARM_1X2_ORDINALS,
  SWARM_2X2_ORDINALS,
  FLAGSHIP_ORDINAL,
} from '../video/gfx';
import {
  COLOR_CODE_FLAGSHIP,
  COLOR_CODE_RED,
  COLOR_CODE_PURPLE,
  COLOR_CODE_BLUE,
} from '../video/palette';

export const SWARM_ROWS = 8;
export const SWARM_COLS = 16;
export const SWARM_FLAG_COUNT = SWARM_ROWS * SWARM_COLS; // 128

export type AlienKind = 'flagship' | 'red' | 'purple' | 'blue';

export interface SwarmRow {
  row: number;
  kind: AlienKind;
  charCol: number;
  wide: boolean;
  columns: number[];
  colorCode: number;
  /** Speed field from ALIEN_PARAMS_TABLE ($1DD1). */
  speed: number;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * The six populated rows: 2 flagships + 6 red + 8 purple + 3 x 10 blue = 46.
 * Colour and speed pairs are ALIEN_PARAMS_TABLE at $1DD1.
 */
export const SWARM_LAYOUT: SwarmRow[] = [
  { row: 7, kind: 'flagship', charCol: 4, wide: true, columns: [6, 9], colorCode: COLOR_CODE_FLAGSHIP, speed: 2 },
  { row: 6, kind: 'red', charCol: 6, wide: false, columns: range(5, 10), colorCode: COLOR_CODE_RED, speed: 2 },
  { row: 5, kind: 'purple', charCol: 7, wide: true, columns: range(4, 11), colorCode: COLOR_CODE_PURPLE, speed: 3 },
  { row: 4, kind: 'blue', charCol: 9, wide: false, columns: range(3, 12), colorCode: COLOR_CODE_BLUE, speed: 1 },
  { row: 3, kind: 'blue', charCol: 10, wide: true, columns: range(3, 12), colorCode: COLOR_CODE_BLUE, speed: 2 },
  { row: 2, kind: 'blue', charCol: 12, wide: false, columns: range(3, 12), colorCode: COLOR_CODE_BLUE, speed: 1 },
];

/** Character columns the formation occupies: 4 through 12, nine of them. */
export const SWARM_CHAR_COLS = range(4, 12);

export const ALIENS_PER_STAGE = SWARM_LAYOUT.reduce((n, r) => n + r.columns.length, 0); // 46

const rowByIndex = new Map(SWARM_LAYOUT.map((r) => [r.row, r]));

export function swarmIndex(row: number, col: number): number {
  return (row << 4) | (col & 0x0f);
}

/** Sprite anchor X (hardware, vertical axis) for a formation row. */
export function rowAnchorX(row: number): number {
  return 124 - 12 * row;
}

/** Sprite anchor Y (hardware, horizontal axis) for a column at a scroll. */
export function colAnchorY(col: number, scrollLsb: number): number {
  return (col * 16 + 7 + scrollLsb) & 0xff;
}

export class Swarm {
  /** ALIEN_SWARM_FLAGS: 1 = alien present. */
  readonly flags = new Uint8Array(SWARM_FLAG_COUNT);
  /** ALIEN_IN_COLUMN_FLAGS at $41F0. */
  readonly columnFlags = new Uint8Array(SWARM_COLS);

  /** SWARM_DIRECTION ($420D): 0 = moving left, 1 = moving right. */
  direction: 0 | 1 = 0;
  /** SWARM_SCROLL_VALUE ($420E), a 16-bit signed accumulator. */
  scroll16 = 0;

  /** SWARM_SCROLL_MAX_EXTENTS ($4210): [leftLimit, rightLimit lsb]. */
  leftLimit = 0x22;
  rightLimit = -0x20;

  reset(): void {
    this.flags.fill(0);
    for (const row of SWARM_LAYOUT) {
      for (const col of row.columns) this.flags[swarmIndex(row.row, col)] = 1;
    }
    this.direction = 0;
    this.scroll16 = 0;
    this.refreshPresence();
  }

  get aliveCount(): number {
    let n = 0;
    for (const f of this.flags) if (f) n++;
    return n;
  }

  /** True while any of the four blue/purple rows still has aliens. */
  get hasBlueOrPurple(): boolean {
    for (const row of SWARM_LAYOUT) {
      if (row.kind !== 'blue' && row.kind !== 'purple') continue;
      for (const col of row.columns) if (this.flags[swarmIndex(row.row, col)]) return true;
    }
    return false;
  }

  get hasFlagships(): boolean {
    for (const col of SWARM_LAYOUT[0]!.columns) {
      if (this.flags[swarmIndex(7, col)]) return true;
    }
    return false;
  }

  remove(row: number, col: number): boolean {
    const i = swarmIndex(row, col);
    if (!this.flags[i]) return false;
    this.flags[i] = 0;
    this.refreshPresence();
    return true;
  }

  /** Re-add an alien that returned from flight. */
  add(row: number, col: number): void {
    this.flags[swarmIndex(row, col)] = 1;
    this.refreshPresence();
  }

  /**
   * SET_ALIEN_PRESENCE_FLAGS ($0998): column occupancy and the scroll limits.
   * Limits widen by $10 for every empty column on the respective flank.
   */
  private refreshPresence(): void {
    this.columnFlags.fill(0);
    for (let col = 0; col < SWARM_COLS; col++) {
      for (const row of SWARM_LAYOUT) {
        if (this.flags[swarmIndex(row.row, col)]) {
          this.columnFlags[col] = 1;
          break;
        }
      }
    }

    let left = 0x22;
    for (let col = 12; col >= 3; col--) {
      if (this.columnFlags[col]) break;
      left += 0x10;
    }
    let right = -0x20;
    for (let col = 3; col <= 12; col++) {
      if (this.columnFlags[col]) break;
      right -= 0x10;
    }
    this.leftLimit = left;
    this.rightLimit = right;
  }

  /**
   * HANDLE_SWARM_MOVEMENT ($0910).
   *
   * @param frame          TIMING_VARIABLE equivalent
   * @param playerBullet   the player's shot, if one is in flight (hardware
   *                       coords), used for the hold-still check
   */
  update(frame: number, playerBullet: { x: number; y: number } | null): void {
    // The column the bullet is about to hit stands still to meet it.
    if (playerBullet) {
      const bx = (playerBullet.x - 0x22) & 0xff;
      if (bx < 0x50) {
        const a = (this.scroll16 - playerBullet.y) & 0xff;
        const rel = (256 - a) & 0xff;
        if (((rel + 2) & 0x0f) < 3) {
          const col = rel >> 4;
          if (this.columnFlags[col]) return;
        }
      }
    }

    const lsb = this.scroll16 & 0xff;
    if (this.direction === 0) {
      // Moving left: positive territory, turn round at the left limit.
      if (this.scroll16 >= 0 && lsb >= this.leftLimit) {
        this.direction = 1;
        return;
      }
      if ((frame & 3) === 0) this.scroll16++;
    } else {
      // Moving right: negative territory, turn round at the right limit.
      if (this.scroll16 < 0 && this.scroll16 <= this.rightLimit) {
        this.direction = 0;
        return;
      }
      if ((frame & 3) === 0) this.scroll16--;
    }
  }

  /** Low byte of the scroll accumulator, as the hardware sees it. */
  get scroll(): number {
    return this.scroll16 & 0xff;
  }

  /**
   * Render the formation into character RAM.
   *
   * Animation frame selection follows $210A: the frame index mixes the frame
   * counter (changing every 16 frames) with the alien's position, so the flap
   * ripples across the formation instead of beating in unison.
   */
  draw(videoram: Uint8Array, objram: Uint8Array, frame: number): void {
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

    for (const row of SWARM_LAYOUT) {
      const codes = row.wide ? [row.charCol, row.charCol + 1] : [row.charCol];
      for (const c of codes) objram[c * 2 + 1] = row.colorCode;

      for (const col of row.columns) {
        if (!this.flags[swarmIndex(row.row, col)]) continue;
        const anim = ((frame >> 4) + row.row + col) & 3;

        if (row.kind === 'flagship') {
          plot2x2(videoram, col, row.charCol, FLAGSHIP_ORDINAL);
        } else if (row.wide) {
          // ALIEN_SWARM_CHARACTERS_SET_2x2 = {$44,$38,$44,$3C}
          const seq = [SWARM_2X2_ORDINALS[2], SWARM_2X2_ORDINALS[0], SWARM_2X2_ORDINALS[2], SWARM_2X2_ORDINALS[1]];
          plot2x2(videoram, col, row.charCol, seq[anim]!);
        } else {
          // ALIEN_SWARM_CHARACTERS_SET_1x2 = {$41,$35,$41,$31}
          const seq = [SWARM_1X2_ORDINALS[2], SWARM_1X2_ORDINALS[1], SWARM_1X2_ORDINALS[2], SWARM_1X2_ORDINALS[0]];
          plot1x2(videoram, col, row.charCol, seq[anim]!);
        }
      }
    }

    // SET_SWARM_SCROLL_OFFSET: the negated low byte goes to all nine columns.
    const offset = (256 - (this.scroll16 & 0xff)) & 0xff;
    for (const c of SWARM_CHAR_COLS) objram[c * 2] = offset;
  }
}

/** Character RAM address for a formation cell. */
function charAddr(col: number, charCol: number, cy: number): number {
  return (((col * 2 + cy) & 0x1f) << 5) | (charCol & 0x1f);
}

/** PLOT_CHARACTERS_2_BY_2_ASCENDING. */
function plot2x2(videoram: Uint8Array, col: number, charCol: number, base: number): void {
  videoram[charAddr(col, charCol, 0)] = base;
  videoram[charAddr(col, charCol + 1, 0)] = base + 1;
  videoram[charAddr(col, charCol, 1)] = base + 2;
  videoram[charAddr(col, charCol + 1, 1)] = base + 3;
}

/** PLOT_TWO_CHARACTERS_IN_SAME_COLUMN ($25A9): the second cell is base + 2. */
function plot1x2(videoram: Uint8Array, col: number, charCol: number, base: number): void {
  videoram[charAddr(col, charCol, 0)] = base;
  videoram[charAddr(col, charCol, 1)] = base + 2;
}

export { rowByIndex };
