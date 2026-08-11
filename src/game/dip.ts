/**
 * DIP switch settings.
 *
 * The board's option switches, surfaced as a settings object. The values and
 * their meanings follow the Namco ROM's actual behaviour (documented at the
 * top of the disassembly, which corrects the Midway manual):
 *
 *   - Bonus Galaxip at 7000 / 10000 / 12000 / 20000 (switches 3-4, table $0152)
 *   - 2 or 3 Galaxips per game (switch 5)
 *   - Free play (coinage switches)
 *
 * In the browser they are read once at boot from URL parameters:
 *
 *   ?bonus=7000|10000|12000|20000   (default 7000)
 *   ?lives=2|3                      (default 3)
 *   ?freeplay=1                     (default off)
 */

import { BONUS_THRESHOLDS } from './game';

export interface DipSettings {
  /** Bonus-life threshold in points. */
  bonusThreshold: number;
  /** Starting lives (2 or 3; switch 5 ON = 3). */
  lives: 2 | 3;
  /** Free play: starts need no credits. */
  freePlay: boolean;
}

export const DEFAULT_DIP: DipSettings = {
  bonusThreshold: BONUS_THRESHOLDS[0],
  lives: 3,
  freePlay: false,
};

/** Parse DIP settings from a URL query string. Unknown values fall back. */
export function dipFromQuery(query: string): DipSettings {
  const params = new URLSearchParams(query);
  const bonus = Number(params.get('bonus'));
  const lives = Number(params.get('lives'));
  return {
    bonusThreshold: (BONUS_THRESHOLDS as readonly number[]).includes(bonus)
      ? bonus
      : DEFAULT_DIP.bonusThreshold,
    lives: lives === 2 ? 2 : 3,
    freePlay: params.get('freeplay') === '1',
  };
}
