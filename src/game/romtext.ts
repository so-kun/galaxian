/**
 * The ROM's text table, transcribed from TEXTPTRS at $235C.
 *
 * Each entry is exactly what PRINT_TEXT ($22F1) consumes: a character RAM
 * address (which fixes both the screen row and the left margin) followed by
 * character ordinals, written at successive addresses minus $20 -- one
 * character row up per character, which is left-to-right on the rotated
 * screen.
 *
 * Ordinals are the ROM's own: space is $10 ('@' - $30 in the source bytes),
 * the dash is $2B, the colon is $A3, "PTS" is the wide glyphs $A0-$A2, and
 * the NAMCO logo is the eight glyphs $9A-$9F, $6E, $6F.
 */

export interface RomText {
  /** Character RAM address ($5000-$53FF) of the first character. */
  addr: number;
  /** Character ordinals to write. */
  chars: readonly number[];
}

const SP = 0x10;
const DASH = 0x2b;
const COLON = 0xa3;
const PTS = [0xa0, 0xa1, 0xa2] as const;

/** Encode a plain uppercase/digit string to ordinals (ASCII - $30). */
function ord(text: string): number[] {
  return [...text].map((c) => (c === ' ' ? SP : c.charCodeAt(0) - 0x30));
}

export const TEXT_GAME_OVER: RomText = { addr: 0x5296, chars: ord('GAME  OVER') };
export const TEXT_PUSH_START: RomText = { addr: 0x52f1, chars: ord('PUSH START BUTTON') };
export const TEXT_PLAYER_ONE: RomText = { addr: 0x5294, chars: ord('PLAYER 0NE') };
export const TEXT_PLAYER_TWO: RomText = { addr: 0x5294, chars: ord('PLAYER TWO') };
export const TEXT_HIGH_SCORE: RomText = { addr: 0x5280, chars: ord('HIGH SCORE') };
export const TEXT_CREDIT: RomText = { addr: 0x537f, chars: ord('CREDIT  ') };
export const TEXT_FREE_PLAY: RomText = { addr: 0x537f, chars: ord('FREE PLAY') };
export const TEXT_CONVOY_CHARGER: RomText = { addr: 0x52d1, chars: ord('CONVOY  CHARGER') };
export const TEXT_SCORE_ADVANCE: RomText = {
  addr: 0x534f,
  chars: [DASH, SP, ...ord('SCORE ADVANCE TABLE'), SP, DASH],
};
export const TEXT_MISSION: RomText = {
  addr: 0x5369,
  chars: [...ord('MISSION'), COLON, SP, ...ord('DESTROY ALIENS')],
};
export const TEXT_WE_ARE: RomText = { addr: 0x5327, chars: ord('WE ARE THE GALAXIANS') };
export const TEXT_PTS_30_60: RomText = {
  addr: 0x52d9,
  chars: [...ord('  30       60  '), ...PTS],
};
export const TEXT_PTS_40_80: RomText = {
  addr: 0x52d7,
  chars: [...ord('  40       80  '), ...PTS],
};
export const TEXT_PTS_50_100: RomText = {
  addr: 0x52d5,
  chars: [...ord('  50      100  '), ...PTS],
};
export const TEXT_PTS_60_300: RomText = {
  addr: 0x52d3,
  chars: [...ord('  60      300  '), ...PTS],
};
export const TEXT_NAMCO: RomText = {
  addr: 0x527c,
  chars: [0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0x6e, 0x6f],
};

/** Compose the BONUS GALAXIP line ($23D1) with the configured threshold. */
export function bonusGalaxipText(threshold: number): RomText {
  const digits = threshold.toString().padStart(5, ' ');
  return { addr: 0x5398, chars: [...ord(`BONUS GALAXIP FOR ${digits} `), ...PTS] };
}

/**
 * Write a RomText into character RAM, PRINT_TEXT-style.
 *
 * @param reveal number of characters to draw (for the scroll-in effect);
 *   defaults to the whole string.
 */
export function printText(videoram: Uint8Array, text: RomText, reveal?: number): void {
  const n = Math.min(reveal ?? text.chars.length, text.chars.length);
  let idx = text.addr - 0x5000;
  for (let i = 0; i < n; i++) {
    videoram[idx & 0x3ff] = text.chars[i]!;
    idx -= 0x20;
  }
}

/** The screen row (attribute column) a RomText sits on. */
export function textCol(text: RomText): number {
  return (text.addr - 0x5000) & 0x1f;
}
