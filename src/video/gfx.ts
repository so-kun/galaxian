/**
 * Tile and sprite bitmaps.
 *
 * The original graphics live in two 2 KB ROMs (1h.bin, 1k.bin) which we do not
 * have and cannot legally distribute, so the artwork here is authored. What is
 * *not* invented is the layout: every character ordinal and sprite code below
 * was read out of the disassembly, so the game logic addresses graphics exactly
 * as the original does.
 *
 * Character ordinals (from `galaxian.asm`):
 *   $00-$09  digits '0'-'9'      -- ordinal is ASCII - $30
 *   $10      space               -- "ordinal of empty character"
 *   $11-$2A  letters 'A'-'Z'
 *   $31,$35,$41  swarm alien, 1x2 cells (ALIEN_SWARM_CHARACTERS_SET_1x2 =
 *                {$41,$35,$41,$31}: four animation frames, three distinct)
 *   $38,$3C,$44  swarm alien, 2x2 cells (ALIEN_SWARM_CHARACTERS_SET_2x2 =
 *                {$44,$38,$44,$3C})
 *   $60      player ship, 2x2 cells
 *   $A4      flagship in formation, 2x2 cells
 *   $C0,$D0,$E0,$F0  player explosion, four frames of 4x4 cells
 *
 * Sprite codes (in-flight aliens only -- the ship and the formation are tiles):
 *   $11-$1D  regular alien, 13 rotation frames (AnimFrameStartCode = $00)
 *   $29-$35  flagship,      13 rotation frames (AnimFrameStartCode = $18)
 *
 * Thirteen frames plus the hardware's X/Y flip bits cover all 24 headings the
 * game tracks in `INFLIGHT_ALIEN.AnimationFrame`.
 */

/** Pixels are 2 bits: 0 is transparent, 1-3 select pens within a colour code. */
export type Bitmap = Uint8Array;

export const CHAR_SIZE = 8;
export const SPRITE_SIZE = 16;

/**
 * Parse string art into a bitmap. `.` (or space) is transparent; `1`, `2`, `3`
 * are pen values.
 *
 * The art below is written the way it appears to the *player*, because that is
 * the only way to author it without going cross-eyed. Storage is in hardware
 * orientation, and since the rotation maps `screen_x = scanline` and
 * `screen_y = dot` with no inversion on either axis, converting between the two
 * is a plain transpose.
 */
export function parseArt(rows: string[], size: number): Bitmap {
  const bmp = new Uint8Array(size * size);
  for (let screenRow = 0; screenRow < size; screenRow++) {
    const row = rows[screenRow] ?? '';
    for (let screenCol = 0; screenCol < size; screenCol++) {
      const ch = row[screenCol] ?? '.';
      const pen = ch === '.' || ch === ' ' ? 0 : (ch.charCodeAt(0) - 48) & 3;
      // hardware (y = scanline, x = dot) <- screen (row, col), transposed
      bmp[screenCol * size + screenRow] = pen;
    }
  }
  return bmp;
}

/** Cut an 8x8 character out of a larger bitmap. */
function subTile(src: Bitmap, srcSize: number, cx: number, cy: number): Bitmap {
  const out = new Uint8Array(CHAR_SIZE * CHAR_SIZE);
  for (let y = 0; y < CHAR_SIZE; y++) {
    for (let x = 0; x < CHAR_SIZE; x++) {
      out[y * CHAR_SIZE + x] = src[(cy * CHAR_SIZE + y) * srcSize + (cx * CHAR_SIZE + x)]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

/**
 * 5x7 glyphs in an 8x8 cell. Galaxian's font is a plain uppercase set; only the
 * characters the game actually prints are defined.
 */
const GLYPHS: Record<string, string[]> = {
  '0': ['.111.', '1...1', '1..11', '1.1.1', '11..1', '1...1', '.111.'],
  '1': ['..1..', '.11..', '..1..', '..1..', '..1..', '..1..', '.111.'],
  '2': ['.111.', '1...1', '....1', '...1.', '..1..', '.1...', '11111'],
  '3': ['11111', '...1.', '..1..', '...1.', '....1', '1...1', '.111.'],
  '4': ['...11', '..1.1', '.1..1', '1...1', '11111', '....1', '....1'],
  '5': ['11111', '1....', '1111.', '....1', '....1', '1...1', '.111.'],
  '6': ['..11.', '.1...', '1....', '1111.', '1...1', '1...1', '.111.'],
  '7': ['11111', '....1', '...1.', '..1..', '.1...', '.1...', '.1...'],
  '8': ['.111.', '1...1', '1...1', '.111.', '1...1', '1...1', '.111.'],
  '9': ['.111.', '1...1', '1...1', '.1111', '....1', '...1.', '.11..'],
  A: ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  B: ['1111.', '1...1', '1...1', '1111.', '1...1', '1...1', '1111.'],
  C: ['.111.', '1...1', '1....', '1....', '1....', '1...1', '.111.'],
  D: ['111..', '1..1.', '1...1', '1...1', '1...1', '1..1.', '111..'],
  E: ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
  F: ['11111', '1....', '1....', '1111.', '1....', '1....', '1....'],
  G: ['.111.', '1...1', '1....', '1.111', '1...1', '1...1', '.111.'],
  H: ['1...1', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
  I: ['.111.', '..1..', '..1..', '..1..', '..1..', '..1..', '.111.'],
  J: ['..111', '...1.', '...1.', '...1.', '...1.', '1..1.', '.11..'],
  K: ['1...1', '1..1.', '1.1..', '11...', '1.1..', '1..1.', '1...1'],
  L: ['1....', '1....', '1....', '1....', '1....', '1....', '11111'],
  M: ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
  N: ['1...1', '11..1', '1.1.1', '1..11', '1...1', '1...1', '1...1'],
  O: ['.111.', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
  P: ['1111.', '1...1', '1...1', '1111.', '1....', '1....', '1....'],
  Q: ['.111.', '1...1', '1...1', '1...1', '1.1.1', '1..1.', '.11.1'],
  R: ['1111.', '1...1', '1...1', '1111.', '1.1..', '1..1.', '1...1'],
  S: ['.1111', '1....', '1....', '.111.', '....1', '....1', '1111.'],
  T: ['11111', '..1..', '..1..', '..1..', '..1..', '..1..', '..1..'],
  U: ['1...1', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
  V: ['1...1', '1...1', '1...1', '1...1', '1...1', '.1.1.', '..1..'],
  W: ['1...1', '1...1', '1...1', '1.1.1', '1.1.1', '11.11', '1...1'],
  X: ['1...1', '1...1', '.1.1.', '..1..', '.1.1.', '1...1', '1...1'],
  Y: ['1...1', '1...1', '.1.1.', '..1..', '..1..', '..1..', '..1..'],
  Z: ['11111', '....1', '...1.', '..1..', '.1...', '1....', '11111'],
  '-': ['.....', '.....', '.....', '11111', '.....', '.....', '.....'],
  '<': ['...1.', '..1..', '.1...', '1....', '.1...', '..1..', '...1.'],
  '>': ['.1...', '..1..', '...1.', '....1', '...1.', '..1..', '.1...'],
};

/** Character ordinal for a printable character: ASCII - $30. */
export function charOrdinal(ch: string): number {
  return (ch.charCodeAt(0) - 0x30) & 0xff;
}

/** Ordinal of the blank character the game writes to erase cells. */
export const CHAR_SPACE = 0x10;

// ---------------------------------------------------------------------------
// Alien artwork
// ---------------------------------------------------------------------------

/*
 * Formation aliens hang upside down, "like bats" as the disassembly puts it.
 * These are drawn in hardware orientation; the renderer's rotation is what
 * turns them the right way up for the player.
 *
 * Odd rows (flagship, purple, blue middle) occupy 2x2 cells; even rows (red,
 * blue top, blue bottom) occupy 1x2 cells.
 */

/**
 * Formation alien for the double-width rows: 16x16 cells.
 *
 * The alien itself is the same size as the 1x2 kind; the extra height is the
 * gap that separates it from the row below, which is why the formation reads
 * as evenly spaced even though alternate rows use different cell sizes.
 */
const SWARM_2X2_FRAMES: string[][] = [
  [
    '................',
    '................',
    '................',
    '................',
    '..1..........1..',
    '...11......11...',
    '....11....11....',
    '..111111111111..',
    '.11.11111111.11.',
    '11...111111...11',
    '1.....1111.....1',
    '.......11.......',
    '................',
    '................',
    '................',
    '................',
  ],
  [
    '................',
    '................',
    '................',
    '................',
    '..1..........1..',
    '..11........11..',
    '...111....111...',
    '..111111111111..',
    '...1111111111...',
    '..11.111111.11..',
    '.1.....11.....1.',
    '.......11.......',
    '................',
    '................',
    '................',
    '................',
  ],
  [
    '................',
    '................',
    '................',
    '................',
    '.1............1.',
    '.11..........11.',
    '..111......111..',
    '..111111111111..',
    '.11..111111..11.',
    '1.....1111.....1',
    '.......11.......',
    '.......11.......',
    '................',
    '................',
    '................',
    '................',
  ],
];

/**
 * Formation alien for the single-width rows: 16 wide by 8 tall.
 *
 * These occupy one character column and two character rows. A character row is
 * the player's *horizontal* axis, so the two cells sit side by side and the art
 * splits down the middle, not across it.
 */
const SWARM_1X2_FRAMES: string[][] = [
  [
    '..1..........1..',
    '...11......11...',
    '....11....11....',
    '..111111111111..',
    '.11.11111111.11.',
    '11...111111...11',
    '1.....1111.....1',
    '.......11.......',
  ],
  [
    '..1..........1..',
    '..11........11..',
    '...111....111...',
    '..111111111111..',
    '...1111111111...',
    '..11.111111.11..',
    '.1.....11.....1.',
    '.......11.......',
  ],
  [
    '.1............1.',
    '.11..........11.',
    '..111......111..',
    '..111111111111..',
    '.11..111111..11.',
    '1.....1111.....1',
    '.......11.......',
    '.......11.......',
  ],
];

/**
 * The flagship as it sits in the formation. It is visibly larger than the
 * rank-and-file aliens, which is why it gets the full 16x16 cell.
 */
const FLAGSHIP_TILE: string[] = [
  '..1..........1..',
  '..11........11..',
  '...11.1111.11...',
  '....111221111...',
  '..11122222211...',
  '.1112222222111..',
  '11122222222211.1',
  '1.1222222222211.',
  '..112222222211..',
  '...1122222211...',
  '....11222211....',
  '.....111111.....',
  '......1111......',
  '................',
  '................',
  '................',
];

/** 16x16 player ship (Galaxip), drawn as 2x2 characters. */
const PLAYER_SHIP: string[] = [
  '.......11.......',
  '.......11.......',
  '......1111......',
  '......1221......',
  '.....112211.....',
  '.....112211.....',
  '....11122111....',
  '....11222211....',
  '...1112222111...',
  '...1122222211...',
  '..111222222111..',
  '..112222222211..',
  '.11122222222111.',
  '.11.11111111.11.',
  '11...111111...11',
  '1.....1111.....1',
];

/** 32x32 player explosion, four frames drawn as 4x4 characters. */
const PLAYER_EXPLOSION: string[][] = [
  [
    '............113223311...........',
    '............132222331...........',
    '..1.........322222223.........1.',
    '...11.......322222223.......11..',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '............1......1............',
    '.............1....1.............',
    '..............1..1..............',
    '.........1.....33.....1.........',
    '..........1...3223...1..........',
    '...........1..3223..1...........',
    '...11.......322222223.......11..',
    '..1.........322222223.........1.',
    '............132222331...........',
    '............113223311...........',
    '...........1..3223..1...........',
    '..........1...3223...1..........',
    '.........1.....33.....1.........',
    '..............1..1..............',
    '.............1....1.............',
    '............1......1............',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
  ],
  [
    '................................',
    '................................',
    '................................',
    '.........1..............1.......',
    '..........1............1........',
    '...........1..........1.........',
    '..............1....1............',
    '...........1....33....1.........',
    '..........1...322223...1........',
    '.........1...32222223...1.......',
    '............3222222223..........',
    '...........322222222223.........',
    '..1.......32222222222223.......1',
    '.11.......32222222222223.......1',
    '1.........32222222222223.........',
    '..........32222222222223........',
    '..........32222222222223........',
    '1.........32222222222223.......1',
    '.11.......32222222222223......11',
    '..1.......32222222222223.......1',
    '...........322222222223.........',
    '............3222222223..........',
    '.........1...32222223...1.......',
    '..........1...322223...1........',
    '...........1....33....1.........',
    '..............1....1............',
    '...........1..........1.........',
    '..........1............1........',
    '.........1..............1.......',
    '................................',
    '................................',
    '................................',
  ],
  [
    '................................',
    '......1..................1......',
    '.......1................1.......',
    '........1..............1........',
    '.........1....3....3...1........',
    '..........1..322..223.1.........',
    '...........1322222223...........',
    '..........13222222222 1.........',
    '.........132222222222231........',
    '........13222222222222231.......',
    '.......1322222222222222231......',
    '......13222222222222222223 .....',
    '.1....32222222222222222222....1.',
    '11....32222222222222222222....11',
    '1.....32222222222222222222.....1',
    '......32222222222222222222......',
    '......32222222222222222222......',
    '1.....32222222222222222222.....1',
    '11....32222222222222222222....11',
    '.1....32222222222222222222....1.',
    '......13222222222222222223......',
    '.......1322222222222222231......',
    '........13222222222222231.......',
    '.........132222222222231........',
    '..........1322222222231.........',
    '...........13222222231..........',
    '..........1..322..223.1.........',
    '.........1....3....3...1........',
    '........1..............1........',
    '.......1................1.......',
    '......1..................1......',
    '................................',
  ],
  [
    '.....1......................1...',
    '....1........................1..',
    '...1..........................1.',
    '..1......33..........33.......1.',
    '.1......3223........3223.......1',
    '1......32..23......32..23.......',
    '......3......3....3......3......',
    '.....3........3..3........3.....',
    '....3..........33..........3....',
    '...3........................3...',
    '..3..........................3..',
    '.3............................3.',
    '3..............................3',
    '3..............................3',
    '3..............................3',
    '.3............................3.',
    '.3............................3.',
    '3..............................3',
    '3..............................3',
    '3..............................3',
    '.3............................3.',
    '..3..........................3..',
    '...3........................3...',
    '....3..........33..........3....',
    '.....3........3..3........3.....',
    '......3......3....3......3......',
    '1......32..23......32..23.......',
    '.1......3223........3223.......1',
    '..1......33..........33.......1.',
    '...1..........................1.',
    '....1........................1..',
    '.....1......................1...',
  ],
];

// ---------------------------------------------------------------------------
// In-flight sprites
// ---------------------------------------------------------------------------

/**
 * Base heading for an in-flight alien: nose pointing along +X, which the
 * disassembly's convention makes "down the screen" toward the player.
 */
const INFLIGHT_ALIEN: string[] = [
  '....1......1....',
  '....11....11....',
  '.....1....1.....',
  '.....11..11.....',
  '..1111111111....',
  '.111111111111...',
  '11.1111111111...',
  '1...111111111...',
  '1...111111111...',
  '11.1111111111...',
  '.111111111111...',
  '..1111111111....',
  '.....11..11.....',
  '.....1....1.....',
  '....11....11....',
  '....1......1....',
];

const INFLIGHT_FLAGSHIP: string[] = [
  '.......11.......',
  '..11..1111..11..',
  '...11.1221.11...',
  '....1112211.....',
  '...11122211.....',
  '..1112222111....',
  '.111222222111...',
  '11122222222111..',
  '11122222222111..',
  '.111222222111...',
  '..1112222111....',
  '...11122211.....',
  '....1112211.....',
  '...11.1221.11...',
  '..11..1111..11..',
  '.......11.......',
];

/** Supersampling factor used when rotating sprite art. */
const ROTATE_OVERSAMPLE = 4;

/**
 * Rotate a square bitmap about its centre.
 *
 * Rotating 16x16 pixel art directly shreds it -- thin features fall between
 * sample points and the alien turns into a blob. Instead we sample at 4x in
 * each axis and resolve each destination pixel by majority vote among its 16
 * subsamples, which keeps the silhouette readable at every angle.
 */
function rotateBitmap(src: Bitmap, size: number, deg: number): Bitmap {
  const out = new Uint8Array(size * size);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const c = (size - 1) / 2;
  const n = ROTATE_OVERSAMPLE;
  const votes = new Uint8Array(4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      votes.fill(0);
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const fx = x + (sx + 0.5) / n - 0.5 - c;
          const fy = y + (sy + 0.5) / n - 0.5 - c;
          const ux = Math.round(c + fx * cos + fy * sin);
          const uy = Math.round(c - fx * sin + fy * cos);
          const pen = ux >= 0 && ux < size && uy >= 0 && uy < size ? src[uy * size + ux]! : 0;
          votes[pen] = votes[pen]! + 1;
        }
      }
      // Any non-transparent majority wins over transparency, so the shape does
      // not erode at the edges as it turns.
      const opaque = votes[1]! + votes[2]! + votes[3]!;
      if (opaque * 2 < n * n) continue;
      let best = 1;
      for (let pen = 2; pen <= 3; pen++) if (votes[pen]! > votes[best]!) best = pen;
      out[y * size + x] = best;
    }
  }
  return out;
}

/**
 * The 13 rotation frames the sprite code arithmetic expects.
 *
 * `INFLIGHT_ALIEN.AnimationFrame` runs over 24 headings; the code at $0C3D
 * folds those onto codes $11..$1D by setting the hardware X and Y flip bits per
 * quadrant. Frame n therefore covers heading n of a quarter turn plus a little
 * overlap, so we generate them 15 degrees apart.
 */
function buildRotationFrames(art: string[]): Bitmap[] {
  const base = parseArt(art, SPRITE_SIZE);
  const frames: Bitmap[] = [];
  for (let i = 0; i < 13; i++) {
    frames.push(i === 0 ? base : rotateBitmap(base, SPRITE_SIZE, i * 15));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Assembled graphics sets
// ---------------------------------------------------------------------------

export const CHAR_COUNT = 256;
export const SPRITE_COUNT = 64;

export interface GfxSet {
  /** 256 characters of 8x8. */
  chars: Bitmap[];
  /** 64 sprites of 16x16. */
  sprites: Bitmap[];
}

/** Ordinals of the three distinct 1x2 swarm alien frames. */
export const SWARM_1X2_ORDINALS = [0x31, 0x35, 0x41] as const;
/** Ordinals of the three distinct 2x2 swarm alien frames. */
export const SWARM_2X2_ORDINALS = [0x38, 0x3c, 0x44] as const;
/** Ordinal of the flagship's 2x2 block in the formation. */
export const FLAGSHIP_ORDINAL = 0xa4;
/** Ordinal of the player ship's 2x2 block. */
export const PLAYER_SHIP_ORDINAL = 0x60;
/** Base ordinals of the four 4x4 player explosion frames. */
export const PLAYER_EXPLOSION_ORDINALS = [0xc0, 0xd0, 0xe0, 0xf0] as const;
/** Sprite code of the first in-flight alien rotation frame. */
export const INFLIGHT_ALIEN_BASE_CODE = 0x11;
/** Offset added for the flagship (`AnimFrameStartCode`). */
export const INFLIGHT_FLAGSHIP_OFFSET = 0x18;

function blank(size: number): Bitmap {
  return new Uint8Array(size * size);
}

export function buildGfx(): GfxSet {
  const chars: Bitmap[] = Array.from({ length: CHAR_COUNT }, () => blank(CHAR_SIZE));
  const sprites: Bitmap[] = Array.from({ length: SPRITE_COUNT }, () => blank(SPRITE_SIZE));

  // Font. Glyphs are 5x7, placed with a one pixel margin.
  for (const [ch, rows] of Object.entries(GLYPHS)) {
    const padded = ['', ...rows.map((r) => `.${r}`), ''];
    chars[charOrdinal(ch)] = parseArt(padded, CHAR_SIZE);
  }

  // Formation aliens, 2x2 cells. PLOT_CHARACTERS_2_BY_2_ASCENDING writes
  // ordinals base..base+3 as [row0col0, row0col1, row1col0, row1col1].
  SWARM_2X2_ORDINALS.forEach((ordinal, frame) => {
    const bmp = parseArt(SWARM_2X2_FRAMES[frame]!, SPRITE_SIZE);
    for (let i = 0; i < 4; i++) {
      chars[ordinal + i] = subTile(bmp, SPRITE_SIZE, i & 1, i >> 1);
    }
  });

  // Formation aliens, 1x2 cells: 16 wide by 8 tall, split left/right because
  // the two character rows are adjacent along the player's horizontal axis.
  SWARM_1X2_ORDINALS.forEach((ordinal, frame) => {
    const rows = SWARM_1X2_FRAMES[frame]!;
    chars[ordinal] = parseArt(
      rows.map((r) => r.slice(0, CHAR_SIZE)),
      CHAR_SIZE,
    );
    chars[ordinal + 1] = parseArt(
      rows.map((r) => r.slice(CHAR_SIZE)),
      CHAR_SIZE,
    );
  });

  // Flagship in formation and the player ship: 2x2 cells each.
  const place2x2 = (ordinal: number, art: string[]) => {
    const bmp = parseArt(art, SPRITE_SIZE);
    for (let i = 0; i < 4; i++) chars[ordinal + i] = subTile(bmp, SPRITE_SIZE, i & 1, i >> 1);
  };
  place2x2(FLAGSHIP_ORDINAL, FLAGSHIP_TILE);
  place2x2(PLAYER_SHIP_ORDINAL, PLAYER_SHIP);

  // Player explosion: four frames of 4x4 cells, ordinals base..base+15.
  PLAYER_EXPLOSION_ORDINALS.forEach((ordinal, frame) => {
    const bmp = parseArt(PLAYER_EXPLOSION[frame]!, 32);
    for (let i = 0; i < 16; i++) {
      chars[ordinal + i] = subTile(bmp, 32, i & 3, i >> 2);
    }
  });

  // In-flight sprites.
  buildRotationFrames(INFLIGHT_ALIEN).forEach((bmp, i) => {
    sprites[INFLIGHT_ALIEN_BASE_CODE + i] = bmp;
  });
  buildRotationFrames(INFLIGHT_FLAGSHIP).forEach((bmp, i) => {
    sprites[INFLIGHT_ALIEN_BASE_CODE + INFLIGHT_FLAGSHIP_OFFSET + i] = bmp;
  });

  return { chars, sprites };
}
