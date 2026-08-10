/**
 * Tile and sprite graphics.
 *
 * The pixel data in `gfx-data.ts` is decoded from the original graphics ROMs
 * (via JOTD's galaxian500 project), so every glyph, alien and rotation frame is
 * the arcade board's own artwork. This module just unpacks it.
 *
 * Character ordinals (from `galaxian.asm`):
 *   $00-$09  digits '0'-'9'      -- ordinal is ASCII - $30
 *   $10      space               -- "ordinal of empty character"
 *   $11-$2A  letters 'A'-'Z'
 *   $31,$35,$41  swarm alien, 1x2 cells (ALIEN_SWARM_CHARACTERS_SET_1x2 =
 *                {$41,$35,$41,$31})
 *   $38,$3C,$44  swarm alien, 2x2 cells (ALIEN_SWARM_CHARACTERS_SET_2x2 =
 *                {$44,$38,$44,$3C})
 *   $60      player ship, 2x2 cells at $51FC
 *   $A4      flagship in formation, 2x2 cells
 *   $C0,$D0,$E0,$F0  player explosion, four frames of 4x4 cells
 *
 * Sprite codes:
 *   $11-$1D  alien rotation frames (AnimFrameStartCode = $00)
 *   $29-$35  flagship rotation frames (AnimFrameStartCode = $18)
 *
 * The 13 frames plus the hardware flip bits cover all 24 headings the game
 * tracks in `INFLIGHT_ALIEN.AnimationFrame`.
 */

import { TILE_DATA, SPRITE_DATA } from './gfx-data';

/** Pixels are 2 bits: 0 is transparent, 1-3 select pens within a colour code. */
export type Bitmap = Uint8Array;

export const CHAR_SIZE = 8;
export const SPRITE_SIZE = 16;
export const CHAR_COUNT = 256;
export const SPRITE_COUNT = 64;

/** Character ordinal for a printable character: ASCII - $30. */
export function charOrdinal(ch: string): number {
  return (ch.charCodeAt(0) - 0x30) & 0xff;
}

/** Ordinal of the blank character the game writes to erase cells. */
export const CHAR_SPACE = 0x10;

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
/** AnimFrameStartCode offset for the flagship's sprite frames. */
export const INFLIGHT_FLAGSHIP_OFFSET = 0x18;
/** Sprite code of the alien explosion. */
export const ALIEN_EXPLOSION_SPRITE = 0x1e;

export interface GfxSet {
  /** 256 characters of 8x8. */
  chars: Bitmap[];
  /** 64 sprites of 16x16. */
  sprites: Bitmap[];
}

/**
 * Unpack one hex-digit-per-pixel data into a bitmap in hardware orientation.
 *
 * The data is stored the way the player sees it (row-major, top-left first).
 * The monitor rotation maps `screen_x = 223 - scanline` and `screen_y = dot`:
 * the scanline axis is *inverted* on screen, which is why moving an object
 * "left" means incrementing its hardware Y. Converting visual data to hardware
 * storage is therefore a transpose with the scanline dimension reversed.
 */
function unpack(data: string, size: number): Bitmap {
  const bmp = new Uint8Array(size * size);
  for (let screenRow = 0; screenRow < size; screenRow++) {
    for (let screenCol = 0; screenCol < size; screenCol++) {
      const pen = (data.charCodeAt(screenRow * size + screenCol) - 48) & 3;
      // hardware (y = scanline, x = dot) <- screen (row, col)
      bmp[(size - 1 - screenCol) * size + screenRow] = pen;
    }
  }
  return bmp;
}

export function buildGfx(): GfxSet {
  return {
    chars: TILE_DATA.map((d) => unpack(d, CHAR_SIZE)),
    sprites: SPRITE_DATA.map((d) => unpack(d, SPRITE_SIZE)),
  };
}
