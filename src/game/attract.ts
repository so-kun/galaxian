/**
 * Attract mode: SCRIPT_ONE's full cycle, ported from the jump table at $0164.
 *
 *   GAME OVER + credit line                    ($018C, parks on PUSH START)
 *   clear, then the intro page ($0218-$028E):
 *     WE ARE THE GALAXIANS / MISSION: DESTROY ALIENS /
 *     - SCORE ADVANCE TABLE - / CONVOY CHARGER, one every 80 frames;
 *     then four aliens (flagship, red, purple, blue) scroll in from the
 *     right at 1 px/frame, each towing its points row on the column-scroll
 *     register ($18C0: one character plotted every 8th pixel);
 *     the right-hand values blink and the flagship's cycles 150/200/300/800
 *     ($0367, characters at $5193 +2 columns per row);
 *     the NAMCO logo prints 210 frames after the last alien, and the page
 *     blinks for $40*$11 frames.
 *   GAME OVER again ($02D1), then a demonstration game, then round again.
 *
 * Timings are the script's own counter values ($01F7 $0440, $0220 $50,
 * $024B $D2, $0281 $1140). The demo player is a simple threat-tracking AI
 * rather than the ROM's scripted fake controller ($0892).
 */

import { CHAR_SPACE } from '../video/gfx';
import {
  COLOR_CODE_TEXT_WHITE,
  COLOR_CODE_TEXT_RED,
  COLOR_CODE_RED,
  COLOR_CODE_PURPLE,
  COLOR_CODE_BLUE,
  COLOR_CODE_FLAGSHIP,
} from '../video/palette';
import { SPRITE_BASE } from '../video/hardware';
import { Game } from './game';
import { INFLIGHT_SLOTS } from './inflight';
import { spriteForHeading } from './arc';
import { INFLIGHT_FLAGSHIP_OFFSET } from '../video/gfx';
import {
  printText,
  textCol,
  bonusGalaxipText,
  TEXT_GAME_OVER,
  TEXT_PUSH_START,
  TEXT_HIGH_SCORE,
  TEXT_CREDIT,
  TEXT_FREE_PLAY,
  TEXT_CONVOY_CHARGER,
  TEXT_SCORE_ADVANCE,
  TEXT_MISSION,
  TEXT_WE_ARE,
  TEXT_PTS_30_60,
  TEXT_PTS_40_80,
  TEXT_PTS_50_100,
  TEXT_PTS_60_300,
  TEXT_NAMCO,
  type RomText,
} from './romtext';
import type { InputState } from '../input';

const enum Phase {
  GameOver,
  Intro,
  GameOver2,
  Demo,
}

/** Frames on each GAME OVER page before the script moves on. */
const GAME_OVER_FRAMES = 240;
/** First header prints after TEMP_COUNTER_1 = $40 frames ($01F7). */
const INTRO_FIRST_TEXT = 0x40;
/** Then one header every $50 frames ($0220). */
const INTRO_TEXT_SPACING = 0x50;
/** The first alien starts TEMP_COUNTER_1 = $20 frames later ($022F). */
const ALIEN_FIRST_DELAY = 0x20;
/** One alien every $D2 frames ($0250). */
const ALIEN_SPACING = 0xd2;
/** The alien scrolls $18 frames before its text row is queued ($10AF). */
const ALIEN_TEXT_DELAY = 0x18;
/** Aliens stop at hardware Y = $C8 ($10DB); the text scroll starts there. */
const ALIEN_TARGET_Y = 0xc8;
/** The finished page blinks for TEMP counters $40 * $11 frames ($0281). */
const BLINK_FRAMES = 0x40 * 0x11;
const DEMO_MAX_FRAMES = 1800;

/** When header line i prints (intro-relative). */
const headerAt = (i: number) => INTRO_FIRST_TEXT + i * INTRO_TEXT_SPACING;
/** When rank-row alien k (0 = flagship) starts scrolling on. */
const alienAt = (k: number) => headerAt(3) + ALIEN_FIRST_DELAY + k * ALIEN_SPACING;
const NAMCO_AT = alienAt(3) + ALIEN_SPACING;
const INTRO_FRAMES = NAMCO_AT + BLINK_FRAMES;

/** Blinking values under the table ($039A/$03A6): character ordinals. */
const FLAGSHIP_VALUES = [
  [0x01, 0x05, 0x00], // 150
  [0x02, 0x00, 0x00], // 200
  [0x03, 0x00, 0x00], // 300
  [0x08, 0x00, 0x00], // 800
] as const;
const STATIC_VALUES = [
  [0x01, 0x00, 0x00], // 100
  [CHAR_SPACE, 0x08, 0x00], //  80
  [CHAR_SPACE, 0x06, 0x00], //  60
] as const;
/** Character RAM offset of the flagship's value ($5193); +2 per row. */
const VALUE_ADDR = 0x193;

/** The four table rows, top to bottom, as INIT_CONVOY_CHARGER_SPRITE makes
 * them ($0341/$109B): colour = type + 1, X = $8C + 16 * colour. */
const RANK_ROWS = [
  { text: TEXT_PTS_60_300, startCode: INFLIGHT_FLAGSHIP_OFFSET, colour: COLOR_CODE_FLAGSHIP },
  { text: TEXT_PTS_50_100, startCode: 0, colour: COLOR_CODE_RED },
  { text: TEXT_PTS_40_80, startCode: 0, colour: COLOR_CODE_PURPLE },
  { text: TEXT_PTS_30_60, startCode: 0, colour: COLOR_CODE_BLUE },
] as const;

const HEADERS: RomText[] = [TEXT_WE_ARE, TEXT_MISSION, TEXT_SCORE_ADVANCE, TEXT_CONVOY_CHARGER];

/** COLOUR_ATTRIBUTE_TABLE_3 ($1DB1): the intro page's per-column colours. */
// prettier-ignore
const INTRO_ATTRS = [
  0x00, 0x05, 0x00, 0x00, 0x01, 0x01, 0x02, 0x03, 0x05, 0x04, 0x05, 0x04, 0x04, 0x00, 0x00, 0x00,
  0x00, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x00, 0x00, 0x07, 0x07, 0x06, 0x06,
] as const;

const IDLE: InputState = { left: false, right: false, fire: false, start: false, start2: false, coin: false };

export class Attract {
  private phase = Phase.GameOver;
  private timer = 0;
  private demo: Game | null = null;
  private demoInput: InputState = { ...IDLE };
  private aiFireCooldown = 0;

  highScore = 0;
  /** Credits available, provided by the session; parks the cycle on start. */
  credits = 0;
  freePlay = false;
  bonusThreshold = 7000;

  reset(): void {
    this.phase = Phase.GameOver;
    this.timer = 0;
    this.demo = null;
  }

  update(input: InputState): boolean {
    if (input.start) return true;
    this.timer++;

    switch (this.phase) {
      case Phase.GameOver:
        // With credits waiting, park here showing PUSH START BUTTON.
        if (this.credits > 0 || this.freePlay) break;
        if (this.timer >= GAME_OVER_FRAMES) this.enter(Phase.Intro);
        break;
      case Phase.Intro:
        if (this.credits > 0 || this.freePlay) {
          this.enter(Phase.GameOver);
          break;
        }
        if (this.timer >= INTRO_FRAMES) this.enter(Phase.GameOver2);
        break;
      case Phase.GameOver2:
        if (this.credits > 0 || this.freePlay) {
          this.enter(Phase.GameOver);
          break;
        }
        if (this.timer >= GAME_OVER_FRAMES) this.startDemo();
        break;
      case Phase.Demo:
        if (this.credits > 0 || this.freePlay) {
          this.enter(Phase.GameOver);
          break;
        }
        this.stepDemo();
        if (!this.demo || this.demo.gameOver || this.timer >= DEMO_MAX_FRAMES) {
          this.highScore = Math.max(this.highScore, this.demo?.highScore ?? 0);
          this.enter(Phase.GameOver);
        }
        break;
    }
    return false;
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.timer = 0;
    if (phase !== Phase.Demo) this.demo = null;
  }

  private startDemo(): void {
    this.demo = new Game();
    this.demoInput = { ...IDLE };
    this.aiFireCooldown = 0;
    this.enter(Phase.Demo);
  }

  private stepDemo(): void {
    const game = this.demo;
    if (!game) return;
    this.computeAiInput(game);
    game.step(this.demoInput);
  }

  /** The fake controller: chase the nearest threat, fire on a cadence. */
  private computeAiInput(game: Game): void {
    let targetY = 0x80;
    let bestX = -1;
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const a = game.inflight.slots[i]!;
      if (!a.isActive) continue;
      if (a.x > bestX) {
        bestX = a.x;
        targetY = a.y;
      }
    }
    const dead = ((targetY - game.playerY + 128) & 0xff) - 128;
    this.demoInput.left = dead > 3;
    this.demoInput.right = dead < -3;
    this.demoInput.fire = false;
    if (this.aiFireCooldown > 0) this.aiFireCooldown--;
    else if (Math.abs(dead) < 12) {
      this.demoInput.fire = true;
      this.aiFireCooldown = 8;
    }
  }

  render(videoram: Uint8Array, objram: Uint8Array): void {
    if (this.phase === Phase.Demo && this.demo) {
      this.demo.render(videoram, objram);
      this.drawCreditLine(videoram, objram);
      return;
    }

    videoram.fill(CHAR_SPACE);
    objram.fill(0, SPRITE_BASE, SPRITE_BASE + INFLIGHT_SLOTS * 4);
    for (let c = 0; c < 32; c++) {
      objram[c * 2] = 0;
      objram[c * 2 + 1] = COLOR_CODE_TEXT_WHITE;
    }

    this.drawHeader(videoram, objram);
    this.drawCreditLine(videoram, objram);

    if (this.phase !== Phase.Intro) {
      this.setColor(objram, TEXT_GAME_OVER, COLOR_CODE_TEXT_RED);
      printText(videoram, TEXT_GAME_OVER);
      if ((this.credits > 0 || this.freePlay) && ((this.timer >> 4) & 1) === 0) {
        this.setColor(objram, TEXT_PUSH_START, COLOR_CODE_TEXT_WHITE);
        printText(videoram, TEXT_PUSH_START);
      }
      return;
    }

    const t = this.timer;

    // The four headers, one every $50 frames ($0218).
    for (let i = 0; i < HEADERS.length; i++) {
      if (t < headerAt(i)) break;
      printText(videoram, HEADERS[i]!);
    }

    // The four rank rows: each alien scrolls in from the right towing its
    // points text on the column-scroll register.
    for (let k = 0; k < RANK_ROWS.length; k++) {
      const start = alienAt(k);
      if (t < start) break;
      const row = RANK_ROWS[k]!;

      // The alien ($0341/$109B/$10D8): slot 4 + IndexInSwarm, Y = 1 px/frame
      // up to $C8, X = $8C + 16 * colour, facing down (AnimationFrame $0C).
      const y = Math.min(t - start, ALIEN_TARGET_Y);
      const x = 0x8c + 16 * row.colour;
      const { code, flipX, flipY } = spriteForHeading(0x0c, row.startCode);
      const base = SPRITE_BASE + (7 - k) * 4;
      objram[base] = (~y - 8) & 0xff;
      objram[base + 1] = (code & 0x3f) | (flipX ? 0x40 : 0) | (flipY ? 0x80 : 0);
      objram[base + 2] = row.colour & 7;
      objram[base + 3] = (x - 8) & 0xff;

      // The text row ($18C0): the column scroll starts at $C8 and counts
      // down; a new character is plotted every 8th pixel, so the string
      // rides in behind its alien.
      const e = t - start - ALIEN_TEXT_DELAY;
      if (e >= 0) {
        const scroll = Math.max(0, ALIEN_TARGET_Y - e);
        const reveal = Math.min(row.text.chars.length, (e >> 3) + 1);
        objram[textCol(row.text) * 2] = scroll;
        printText(videoram, row.text, reveal);
      }
    }

    // NAMCO logo, 210 frames after the last alien ($0288).
    if (t >= NAMCO_AT) printText(videoram, TEXT_NAMCO);

    this.drawBlinkingValues(videoram, t);

    // The page's own per-column colours (COLOUR_ATTRIBUTE_TABLE_3, $0212).
    for (let c = 0; c < 32; c++) objram[c * 2 + 1] = INTRO_ATTRS[c]!;
  }

  /**
   * HANDLE_DRAW_CONVOY_CHARGER_POINTS ($0367): the right-hand values blink
   * with a 64-frame period (cleared at t%64==0, drawn at t%64==32) once
   * ATTRACT_MODE_SCROLL_ID covers their row; the flagship's cycles through
   * 150/200/300/800. Until a row's first clear, its text's own digits stand.
   */
  private drawBlinkingValues(videoram: Uint8Array, t: number): void {
    for (let j = 0; j < 4; j++) {
      // Column j is covered once the id reaches j+2 (the flagship's value
      // starts blinking when the red alien starts scrolling, and so on;
      // the blue row's joins at the NAMCO logo).
      const coverage = j < 3 ? alienAt(j + 1) : NAMCO_AT;
      const firstClear = (coverage + 0x3f) & ~0x3f;
      if (t < firstClear) continue;

      const visible = (t & 0x3f) >= 0x20;
      const chars = !visible
        ? [CHAR_SPACE, CHAR_SPACE, CHAR_SPACE]
        : j === 0
          ? FLAGSHIP_VALUES[(t >> 6) & 3]!
          : STATIC_VALUES[j - 1]!;
      let addr = VALUE_ADDR + 2 * j;
      for (const c of chars) {
        videoram[addr & 0x3ff] = c;
        addr -= 0x20;
      }
    }
  }

  /** 1UP / HIGH SCORE header with the score lines, as SCRIPT_ZERO leaves it. */
  private drawHeader(videoram: Uint8Array, objram: Uint8Array): void {
    // "1UP" at $5340 (rows 26.., col 0) and HIGH SCORE from the text table.
    const write = (row: number, col: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        const addr = (((row - i) & 0x1f) << 5) | (col & 0x1f);
        videoram[addr] = str[i] === ' ' ? CHAR_SPACE : str.charCodeAt(i) - 0x30;
      }
    };
    objram[0 * 2 + 1] = COLOR_CODE_TEXT_RED;
    objram[1 * 2 + 1] = COLOR_CODE_TEXT_WHITE;
    write(26, 0, '1UP');
    this.setColor(objram, TEXT_HIGH_SCORE, COLOR_CODE_TEXT_RED);
    printText(videoram, TEXT_HIGH_SCORE);
    write(25, 1, '     00');
    write(17, 1, this.highScore.toString().padStart(6, '0').replace(/^00/, '  '));
  }

  /** CREDIT n (or FREE PLAY) at the bottom, from the ROM's own strings. */
  private drawCreditLine(videoram: Uint8Array, objram: Uint8Array): void {
    if (this.freePlay) {
      this.setColor(objram, TEXT_FREE_PLAY, COLOR_CODE_TEXT_WHITE);
      printText(videoram, TEXT_FREE_PLAY);
      return;
    }
    this.setColor(objram, TEXT_CREDIT, COLOR_CODE_TEXT_WHITE);
    printText(videoram, TEXT_CREDIT);
    // The credit count goes after the label.
    const label = this.credits.toString();
    let idx = TEXT_CREDIT.addr - 0x5000 - 0x20 * TEXT_CREDIT.chars.length;
    for (let i = 0; i < label.length; i++) {
      videoram[idx & 0x3ff] = label.charCodeAt(i) - 0x30;
      idx -= 0x20;
    }
    // BONUS GALAXIP FOR nnnn PTS above it, on the game-over pages only.
    if (this.phase === Phase.GameOver || this.phase === Phase.GameOver2) {
      const bonus = bonusGalaxipText(this.bonusThreshold);
      this.setColor(objram, bonus, COLOR_CODE_TEXT_WHITE);
      printText(videoram, bonus);
    }
  }

  private setColor(objram: Uint8Array, text: RomText, color: number): void {
    const col = textCol(text);
    objram[col * 2 + 1] = color;
    objram[col * 2] = 0;
  }
}
