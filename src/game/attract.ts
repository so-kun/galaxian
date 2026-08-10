/**
 * Attract mode.
 *
 * The original's SCRIPT_ONE ($03D2) cycles a long jump table: GAME OVER and
 * credits, the "WE ARE THE GALAXIANS" / SCORE ADVANCE TABLE page with the
 * convoy-charger point values, the NAMCO logo, and a demonstration game driven
 * by a fake controller (HANDLE_SIMULATE_PLAYER_IN_ATTRACT_MODE, $0892).
 *
 * This reproduces the visible cycle: a score screen, the score-advance table
 * with the real point sprites, and a demo game played by a simple AI. Pressing
 * start at any point begins a real game. The score-advance values are the
 * ROM's own tables: the flagship cycles 150/200/300/800 ($039A) and the alien
 * ranks show 100/80/60 ($03A6).
 */

import { charOrdinal, CHAR_SPACE } from '../video/gfx';
import {
  COLOR_CODE_TEXT_WHITE,
  COLOR_CODE_TEXT_RED,
  COLOR_CODE_RED,
  COLOR_CODE_PURPLE,
  COLOR_CODE_BLUE,
} from '../video/palette';
import { SPRITE_BASE } from '../video/hardware';
import { Game } from './game';
import { FLAGSHIP_POINT_SPRITE_BASE } from './game';
import { INFLIGHT_SLOTS } from './inflight';
import { spriteForHeading } from './arc';
import { INFLIGHT_FLAGSHIP_OFFSET } from '../video/gfx';
import type { InputState } from '../input';

const enum Phase {
  Scores,
  ScoreTable,
  Demo,
}

/** Frames spent on each non-demo screen (~60 fps). */
const SCORES_FRAMES = 260;
const TABLE_FRAMES = 420;
/** A demo game runs at most this long before the cycle restarts. */
const DEMO_MAX_FRAMES = 1800;

const IDLE: InputState = { left: false, right: false, fire: false, start: false, start2: false, coin: false };

export class Attract {
  private phase = Phase.Scores;
  private timer = 0;
  private demo: Game | null = null;
  private demoInput: InputState = { ...IDLE };
  private aiFireCooldown = 0;

  /** Persisted high score to show across the cycle. */
  highScore = 0;

  reset(): void {
    this.phase = Phase.Scores;
    this.timer = 0;
    this.demo = null;
  }

  /**
   * Advance the attract cycle. Returns true when the player pressed start and a
   * real game should begin.
   */
  update(input: InputState): boolean {
    if (input.start) return true;
    this.timer++;

    switch (this.phase) {
      case Phase.Scores:
        if (this.timer >= SCORES_FRAMES) this.enter(Phase.ScoreTable);
        break;
      case Phase.ScoreTable:
        if (this.timer >= TABLE_FRAMES) this.startDemo();
        break;
      case Phase.Demo:
        this.stepDemo();
        if (!this.demo || this.demo.gameOver || this.timer >= DEMO_MAX_FRAMES) {
          this.highScore = Math.max(this.highScore, this.demo?.highScore ?? 0);
          this.enter(Phase.Scores);
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
    // A silent demo game (no sound sink) that we drive with a simple AI.
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

  /**
   * The fake controller: track the most urgent threat's horizontal position,
   * slide under it, and fire on a short cadence. Crude next to the ROM's
   * scripted routine, but it produces a lively demo.
   */
  private computeAiInput(game: Game): void {
    let targetY = game.playerY;
    let bestX = -1;

    // Prefer the lowest (closest) diving alien; else aim at the swarm centre.
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const a = game.inflight.slots[i]!;
      if (!a.isActive) continue;
      if (a.x > bestX) {
        bestX = a.x;
        targetY = a.y;
      }
    }
    if (bestX < 0) {
      // No divers: drift toward the middle of the surviving formation.
      targetY = 0x80;
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

  /** Draw the current attract screen (or the demo game) into hardware memory. */
  render(videoram: Uint8Array, objram: Uint8Array): void {
    if (this.phase === Phase.Demo && this.demo) {
      this.demo.render(videoram, objram);
      return;
    }

    videoram.fill(CHAR_SPACE);
    objram.fill(0, SPRITE_BASE, SPRITE_BASE + INFLIGHT_SLOTS * 4);
    // Neutral column colours for text.
    for (let c = 0; c < 32; c++) {
      objram[c * 2] = 0;
      objram[c * 2 + 1] = COLOR_CODE_TEXT_WHITE;
    }

    // Header, always present.
    this.text(videoram, objram, 26, 0, '1UP', COLOR_CODE_TEXT_RED);
    this.text(videoram, objram, 19, 0, 'HIGH SCORE', COLOR_CODE_TEXT_RED);
    this.text(videoram, objram, 25, 1, '     00', COLOR_CODE_TEXT_WHITE);
    this.text(
      videoram,
      objram,
      17,
      1,
      this.highScore.toString().padStart(6, '0').replace(/^00/, '  '),
      COLOR_CODE_TEXT_WHITE,
    );

    if (this.phase === Phase.Scores) this.renderScores(videoram, objram);
    else this.renderScoreTable(videoram, objram);
  }

  private renderScores(videoram: Uint8Array, objram: Uint8Array): void {
    this.text(videoram, objram, 22, 8, 'GALAXIAN', COLOR_CODE_TEXT_RED);
    // Blink the prompt.
    if ((this.timer >> 5) & 1) {
      this.text(videoram, objram, 24, 14, 'PUSH START BUTTON', COLOR_CODE_TEXT_WHITE);
    }
    this.text(videoram, objram, 26, 20, 'C 1979 NAMCO', COLOR_CODE_TEXT_RED);
  }

  private renderScoreTable(videoram: Uint8Array, objram: Uint8Array): void {
    this.text(videoram, objram, 28, 5, 'SCORE ADVANCE TABLE', COLOR_CODE_TEXT_RED);
    this.text(videoram, objram, 24, 8, 'CONVOY CHARGER', COLOR_CODE_TEXT_RED);

    // The flagship value cycles 150/200/300/800 like the ROM's blink ($039A).
    const idx = (this.timer >> 5) & 3;
    const flagshipPts = ['150', '200', '300', '800'][idx]!;

    // Rank rows: sprite on the left, points on the right, stacked down-screen.
    const rows: { line: number; startCode: number; color: number; pts: string }[] = [
      { line: 11, startCode: INFLIGHT_FLAGSHIP_OFFSET, color: COLOR_CODE_TEXT_RED, pts: flagshipPts },
      { line: 15, startCode: 0, color: COLOR_CODE_RED, pts: '100' },
      { line: 19, startCode: 0, color: COLOR_CODE_PURPLE, pts: ' 80' },
      { line: 23, startCode: 0, color: COLOR_CODE_BLUE, pts: ' 60' },
    ];

    let slot = 0;
    for (const r of rows) {
      // The sprite sits on the row's display line (hardware X = line*8, the
      // vertical axis) with the points text to its right. The Y register is
      // stored complemented, as the sprite hardware expects.
      const { code, flipX, flipY } = spriteForHeading(0, r.startCode);
      const base = SPRITE_BASE + slot * 4;
      const hwX = r.line * 8;
      const hwY = 0x98; // horizontal position of the sprite column
      objram[base] = (~hwY - 8) & 0xff;
      objram[base + 1] = (code & 0x3f) | (flipX ? 0x40 : 0) | (flipY ? 0x80 : 0);
      objram[base + 2] = r.color & 7;
      objram[base + 3] = (hwX - 8) & 0xff;
      slot++;

      // Points text, a few characters to the right of the sprite column.
      this.text(videoram, objram, 14, r.line, r.pts, COLOR_CODE_TEXT_WHITE);
    }
    void FLAGSHIP_POINT_SPRITE_BASE;
  }

  /**
   * Print a string into character RAM.
   *
   * Same addressing as the HUD: `charCol` selects the horizontal display line
   * (0 = top), and successive characters run toward decreasing `charRow`. The
   * column's colour attribute is set to `color`.
   */
  private text(
    videoram: Uint8Array,
    objram: Uint8Array,
    charRow: number,
    charCol: number,
    str: string,
    color: number,
  ): void {
    for (let i = 0; i < str.length; i++) {
      const addr = (((charRow - i) & 0x1f) << 5) | (charCol & 0x1f);
      videoram[addr] = str[i] === ' ' ? CHAR_SPACE : charOrdinal(str[i]!);
    }
    objram[charCol * 2 + 1] = color;
    objram[charCol * 2] = 0;
  }
}
