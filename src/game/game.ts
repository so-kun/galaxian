/**
 * The game.
 *
 * State names and addresses follow the disassembly so the two can be read side
 * by side. Two things about this hardware shape the code more than anything
 * else:
 *
 *  - The player ship is not a sprite. It is a 2x2 block of characters at $51FC,
 *    and it moves by writing the scroll register for its character columns --
 *    which is what PLAYER_Y at $4202 is for.
 *  - Only aliens in flight are sprites. The formation is tiles.
 *
 * Coordinates are the hardware's: X is the player's vertical axis (X++ is down)
 * and Y is the player's horizontal axis (Y++ is left).
 */

import { Swarm } from './swarm';
import { InflightAliens, Stage, INFLIGHT_SLOTS } from './inflight';
import { SWARM_LAYOUT, swarmIndex } from './swarm';
import {
  CHAR_SPACE,
  PLAYER_SHIP_ORDINAL,
  PLAYER_EXPLOSION_ORDINALS,
  charOrdinal,
} from '../video/gfx';
import { SPRITE_BASE, BULLET_BASE } from '../video/hardware';
import { SFX_ALIEN_DEATH, SFX_FLAGSHIP_DEATH } from '../audio/engine';
import type { InputState } from '../input';

/**
 * Sound hooks, named after the board's control lines rather than after game
 * events, so the game drives the audio the way the Z80 drove the sound section.
 */
export interface SoundSink {
  /** The FIRE line. */
  fire(): void;
  /** The HIT line. */
  hit(): void;
  /** Start one of the ROM pitch sequences. */
  playSequence(seq: readonly number[]): void;
  /** FS1..FS3, the three background 555 astables. */
  setBackgroundVoice(index: 0 | 1 | 2, on: boolean): void;
  /** The 4-bit background LFO DAC at $6004-$6007. */
  setBackgroundFrequency(value: number): void;
}

/** Character cell the player ship is plotted at ($51FC). */
const SHIP_CHAR_ADDR = 0x1fc;
const SHIP_CHAR_ROW = SHIP_CHAR_ADDR >> 5; // 15
const SHIP_CHAR_COL = SHIP_CHAR_ADDR & 0x1f; // 28

/** Scroll limits that keep the ship inside the visible 224 pixels. */
const SHIP_SCROLL_MIN = SHIP_CHAR_ROW * 8 - 224 + 16 + 16; // rightmost
const SHIP_SCROLL_MAX = SHIP_CHAR_ROW * 8 - 16; // leftmost

/** Bullet slot 7 is the "missile" and renders yellow -- the player's shot. */
const PLAYER_BULLET_SLOT = 7;
const ENEMY_BULLET_SLOTS = 7;

/** ALIEN_SCORE_TABLE ($22D0), indexed by the value passed to $21A6. */
export const ALIEN_SCORES = [30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 300, 800] as const;

/** Bonus thresholds offered by the DIP switches (text table at $1F52). */
export const BONUS_THRESHOLDS = [7000, 10000, 12000, 20000] as const;

const enum PlayerState {
  Alive,
  Exploding,
  Waiting,
}

export class Game {
  readonly swarm = new Swarm();
  readonly inflight = new InflightAliens();

  /** PLAYER_Y ($4202), as a scroll offset for the ship's character columns. */
  playerScroll = (SHIP_SCROLL_MIN + SHIP_SCROLL_MAX) >> 1;
  private playerState = PlayerState.Alive;
  private explosionCounter = 0; // PLAYER_EXPLOSION_COUNTER ($4205)
  private explosionFrame = 0; // PLAYER_EXPLOSION_ANIM_FRAME ($4206)
  private respawnDelay = 0;

  /** HAS_PLAYER_BULLET_BEEN_FIRED ($4208) and its coordinates. */
  private bulletActive = false;
  private bulletX = 0;
  private bulletY = 0;
  private firePressed = false;

  private enemyBullets = Array.from({ length: ENEMY_BULLET_SLOTS }, () => ({
    active: false,
    x: 0,
    y: 0,
    dy: 0,
  }));

  score = 0;
  highScore = 0;
  lives = 3;
  stage = 1;
  bonusThreshold: number = BONUS_THRESHOLDS[0];
  private bonusAwarded = false;
  gameOver = false;

  private launchTimer = 0;
  private rngState = 0x1234;

  /** Optional sound section; the game runs silently without one. */
  sound: SoundSink | null = null;

  /** Deterministic PRNG so behaviour is reproducible in tests. */
  private rng = (): number => {
    this.rngState = (this.rngState * 1103515245 + 12345) & 0x7fffffff;
    return this.rngState / 0x7fffffff;
  };

  constructor() {
    this.reset();
  }

  reset(): void {
    this.swarm.reset();
    this.inflight.reset();
    this.score = 0;
    this.lives = 3;
    this.stage = 1;
    this.bonusAwarded = false;
    this.gameOver = false;
    this.playerScroll = (SHIP_SCROLL_MIN + SHIP_SCROLL_MAX) >> 1;
    this.playerState = PlayerState.Alive;
    this.bulletActive = false;
    for (const b of this.enemyBullets) b.active = false;
    this.inflight.difficultyBase = 0;
    this.inflight.difficultyExtra = 0;
  }

  /** Screen X of the ship's centre, for aiming. */
  private get playerHardwareY(): number {
    // screen_x = charRow*8 - scroll - 16; hardware Y = 224 - screen_x.
    const screenX = SHIP_CHAR_ROW * 8 - this.playerScroll - 16 + 8;
    return (224 - screenX) & 0xff;
  }

  private get playerHardwareX(): number {
    return SHIP_CHAR_COL * 8;
  }

  step(input: InputState): void {
    if (this.gameOver) {
      if (input.start) this.reset();
      return;
    }

    this.swarm.update();
    this.updateBackgroundHum();
    this.updatePlayer(input);
    this.updateBullet();
    this.updateEnemyBullets();
    this.inflight.update(this.playerHardwareX, this.playerHardwareY);
    this.updateLaunches();
    this.checkCollisions();
    this.checkStageComplete();
  }

  /**
   * The background drone climbs as the formation thins out.
   *
   * The original writes a 4-bit value to $6004-$6007 which sets a 555's
   * frequency, and gates three more 555s with FS1..FS3. Fewer aliens means a
   * higher value and more voices, which is the rising tension you hear.
   */
  private updateBackgroundHum(): void {
    if (!this.sound) return;
    const alive = this.swarm.aliveCount;
    const level = Math.max(0, Math.min(15, 15 - Math.floor((alive * 15) / 46)));
    if (level !== this.lastHumLevel) {
      this.lastHumLevel = level;
      this.sound.setBackgroundFrequency(level);
    }
    const playing = this.playerState === PlayerState.Alive && !this.gameOver;
    for (let v = 0; v < 3; v++) {
      const on = playing && level >= v * 5;
      if (on !== this.humVoices[v]) {
        this.humVoices[v] = on;
        this.sound.setBackgroundVoice(v as 0 | 1 | 2, on);
      }
    }
  }

  private lastHumLevel = -1;
  private humVoices = [false, false, false];

  private updatePlayer(input: InputState): void {
    if (this.playerState === PlayerState.Exploding) {
      if (--this.explosionCounter <= 0) {
        this.explosionFrame++;
        this.explosionCounter = 8;
        if (this.explosionFrame >= PLAYER_EXPLOSION_ORDINALS.length) {
          this.playerState = PlayerState.Waiting;
          this.respawnDelay = 60;
        }
      }
      return;
    }
    if (this.playerState === PlayerState.Waiting) {
      if (--this.respawnDelay <= 0) {
        if (this.lives <= 0) this.gameOver = true;
        else {
          this.playerState = PlayerState.Alive;
          this.playerScroll = (SHIP_SCROLL_MIN + SHIP_SCROLL_MAX) >> 1;
        }
      }
      return;
    }

    // Moving left increases the scroll value.
    if (input.left) this.playerScroll = Math.min(SHIP_SCROLL_MAX, this.playerScroll + 1);
    if (input.right) this.playerScroll = Math.max(SHIP_SCROLL_MIN, this.playerScroll - 1);

    // One shot on screen at a time, and the button must be released between
    // shots -- holding it down does not autofire.
    if (input.fire && !this.firePressed && !this.bulletActive) {
      this.bulletActive = true;
      this.bulletX = this.playerHardwareX - 8;
      this.bulletY = this.playerHardwareY;
      this.sound?.fire();
    }
    this.firePressed = input.fire;
  }

  private updateBullet(): void {
    if (!this.bulletActive) return;
    this.bulletX -= 4;
    if (this.bulletX < 16) this.bulletActive = false; // IS_PLAYER_BULLET_DONE
  }

  private updateEnemyBullets(): void {
    for (const b of this.enemyBullets) {
      if (!b.active) continue;
      b.x = (b.x + b.dy) & 0xff;
      if (b.x > 248 || b.x < 8) b.active = false;
    }
  }

  /** Diving aliens drop shots at the player. */
  private fireEnemyBullet(fromX: number, fromY: number): void {
    const slot = this.enemyBullets.findIndex((b) => !b.active);
    if (slot < 0) return;
    const b = this.enemyBullets[slot]!;
    b.active = true;
    b.x = fromX;
    b.y = fromY;
    b.dy = 3;
  }

  private updateLaunches(): void {
    if (this.playerState !== PlayerState.Alive) return;
    if (--this.launchTimer > 0) return;

    // Higher difficulty sends aliens more often as well as more of them.
    const interval = Math.max(24, 140 - (this.inflight.difficultyBase + this.inflight.difficultyExtra) * 8);
    this.launchTimer = interval;

    if (this.inflight.inFlightCount < this.inflight.activeAttackerSlots + 3) {
      this.inflight.launchFromSwarm(this.swarm, this.rng);
    }

    // Attacking aliens shoot on their way down.
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.inflight.slots[i]!;
      if (alien.isActive && alien.stageOfLife === Stage.Attacking && this.rng() < 0.4) {
        this.fireEnemyBullet(alien.x + 8, alien.y);
      }
    }
  }

  private checkCollisions(): void {
    // Player shot against aliens in flight.
    if (this.bulletActive) {
      for (let i = 1; i < INFLIGHT_SLOTS; i++) {
        const alien = this.inflight.slots[i]!;
        if (!alien.isActive) continue;
        if (Math.abs(alien.x - this.bulletX) < 10 && Math.abs(((alien.y - this.bulletY + 128) & 0xff) - 128) < 10) {
          const isFlagship = alien.animFrameStartCode !== 0;
          alien.isActive = false;
          this.bulletActive = false;
          this.addScore(this.scoreForInflight(i));
          this.sound?.playSequence(isFlagship ? SFX_FLAGSHIP_DEATH : SFX_ALIEN_DEATH);
          break;
        }
      }
    }

    // Player shot against the formation.
    if (this.bulletActive) {
      const hit = this.swarmCellAt(this.bulletX, this.bulletY);
      if (hit) {
        this.swarm.remove(hit.row, hit.col);
        this.bulletActive = false;
        this.addScore(hit.kind === 'flagship' ? ALIEN_SCORES[7]! : ALIEN_SCORES[0]!);
        this.sound?.playSequence(
          hit.kind === 'flagship' ? SFX_FLAGSHIP_DEATH : SFX_ALIEN_DEATH,
        );
      }
    }

    if (this.playerState !== PlayerState.Alive) return;

    const px = this.playerHardwareX;
    const py = this.playerHardwareY;

    for (const b of this.enemyBullets) {
      if (!b.active) continue;
      if (Math.abs(b.x - px) < 10 && Math.abs(((b.y - py + 128) & 0xff) - 128) < 8) {
        b.active = false;
        this.killPlayer();
        return;
      }
    }

    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.inflight.slots[i]!;
      if (!alien.isActive) continue;
      if (Math.abs(alien.x - px) < 12 && Math.abs(((alien.y - py + 128) & 0xff) - 128) < 12) {
        alien.isActive = false;
        this.killPlayer();
        return;
      }
    }
  }

  /**
   * Diving aliens are worth more than ones sitting in the formation, and the
   * flagship is worth more again -- 800 when escorted, per ALIEN_SCORE_TABLE.
   */
  private scoreForInflight(slot: number): number {
    const alien = this.inflight.slots[slot]!;
    if (alien.animFrameStartCode !== 0) {
      // Flagship: the payout scales with how many escorts are still flying.
      const escorts = [2, 3].filter((s) => this.inflight.slots[s]!.isActive).length;
      return escorts === 2 ? ALIEN_SCORES[11]! : escorts === 1 ? ALIEN_SCORES[10]! : ALIEN_SCORES[9]!;
    }
    return ALIEN_SCORES[3]!;
  }

  /** Which formation cell, if any, occupies a hardware coordinate. */
  private swarmCellAt(x: number, y: number): { row: number; col: number; kind: string } | null {
    const scroll = this.swarm.scroll;
    for (const row of SWARM_LAYOUT) {
      const top = row.charCol * 8;
      if (x < top || x >= top + (row.wide ? 12 : 8)) continue;
      for (const col of row.columns) {
        if (!this.swarm.flags[swarmIndex(row.row, col)]) continue;
        const screenX = col * 16 - scroll - 16;
        const cellY = (224 - screenX) & 0xff;
        if (Math.abs(((cellY - y + 128) & 0xff) - 128) < 12) {
          return { row: row.row, col, kind: row.kind };
        }
      }
    }
    return null;
  }

  private killPlayer(): void {
    this.sound?.hit();
    this.playerState = PlayerState.Exploding;
    this.explosionCounter = 8;
    this.explosionFrame = 0;
    this.lives--;
    this.bulletActive = false;
  }

  private addScore(points: number): void {
    this.score += points;
    if (this.score > this.highScore) this.highScore = this.score;
    if (!this.bonusAwarded && this.score >= this.bonusThreshold) {
      this.bonusAwarded = true;
      this.lives++;
    }
    // DIFFICULTY_BASE_VALUE climbs during a stage, capped at 7.
    this.inflight.difficultyBase = Math.min(7, Math.floor(this.score / 1500));
  }

  private checkStageComplete(): void {
    if (this.swarm.aliveCount > 0 || this.inflight.inFlightCount > 0) return;
    this.stage++;
    this.swarm.reset();
    this.inflight.reset();
    // DIFFICULTY_EXTRA_VALUE climbs on stage completion, capped at 7.
    this.inflight.difficultyExtra = Math.min(7, this.inflight.difficultyExtra + 1);
  }

  // -------------------------------------------------------------------------
  // Rendering into hardware memory
  // -------------------------------------------------------------------------

  render(videoram: Uint8Array, objram: Uint8Array): void {
    videoram.fill(CHAR_SPACE);
    this.swarm.draw(videoram, objram);
    this.drawPlayer(videoram, objram);
    this.drawHud(videoram, objram);
    this.inflight.writeSprites(objram, SPRITE_BASE);
    this.drawBullets(objram);
  }

  private drawPlayer(videoram: Uint8Array, objram: Uint8Array): void {
    // The ship's own character columns carry its position as a scroll value.
    objram[SHIP_CHAR_COL * 2] = this.playerScroll & 0xff;
    objram[(SHIP_CHAR_COL + 1) * 2] = this.playerScroll & 0xff;
    objram[SHIP_CHAR_COL * 2 + 1] = 4; // player colour code
    objram[(SHIP_CHAR_COL + 1) * 2 + 1] = 4;

    if (this.playerState === PlayerState.Waiting) return;

    if (this.playerState === PlayerState.Exploding) {
      const base = PLAYER_EXPLOSION_ORDINALS[Math.min(this.explosionFrame, 3)]!;
      // The explosion is 4x4 cells; the ship's 2x2 sits in its lower right.
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const addr = (((SHIP_CHAR_ROW - 1 + cy) & 0x1f) << 5) | ((SHIP_CHAR_COL - 2 + cx) & 0x1f);
          videoram[addr] = base + cy * 4 + cx;
        }
      }
      return;
    }

    // PLOT_CHARACTERS_2_BY_2_ASCENDING at $51FC.
    videoram[SHIP_CHAR_ADDR] = PLAYER_SHIP_ORDINAL;
    videoram[SHIP_CHAR_ADDR + 1] = PLAYER_SHIP_ORDINAL + 1;
    videoram[SHIP_CHAR_ADDR + 32] = PLAYER_SHIP_ORDINAL + 2;
    videoram[SHIP_CHAR_ADDR + 33] = PLAYER_SHIP_ORDINAL + 3;
  }

  private drawBullets(objram: Uint8Array): void {
    objram.fill(0, BULLET_BASE, BULLET_BASE + 32);

    if (this.bulletActive) {
      const base = BULLET_BASE + PLAYER_BULLET_SLOT * 4;
      objram[base + 1] = (255 - this.hardwareToScanline(this.bulletY)) & 0xff;
      objram[base + 3] = (255 - this.bulletX) & 0xff;
    }
    this.enemyBullets.forEach((b, i) => {
      if (!b.active || i >= ENEMY_BULLET_SLOTS) return;
      const base = BULLET_BASE + i * 4;
      objram[base + 1] = (255 - this.hardwareToScanline(b.y)) & 0xff;
      objram[base + 3] = (255 - b.x) & 0xff;
    });
  }

  /** A bullet's hardware Y selects the scanline it appears on. */
  private hardwareToScanline(y: number): number {
    return (224 - y + 16) & 0xff;
  }

  /** Score, high score and remaining lives, written as characters. */
  private drawHud(videoram: Uint8Array, objram: Uint8Array): void {
    const write = (charRow: number, charCol: number, text: string, colorCode: number) => {
      for (let i = 0; i < text.length; i++) {
        const addr = (((charRow + i) & 0x1f) << 5) | (charCol & 0x1f);
        videoram[addr] = text[i] === ' ' ? CHAR_SPACE : charOrdinal(text[i]!);
      }
      objram[charCol * 2 + 1] = colorCode;
      objram[charCol * 2] = 0;
    };

    // Text runs along character rows, which is the player's horizontal axis.
    write(2, 0, '1UP', 6);
    write(12, 0, 'HIGH SCORE', 6);
    write(2, 1, this.score.toString().padStart(6, '0'), 6);
    write(12, 1, this.highScore.toString().padStart(6, '0'), 6);

    if (this.gameOver) write(8, 14, 'GAME OVER', 2);

    // Remaining lives as small ships along the bottom edge.
    for (let i = 0; i < Math.min(5, Math.max(0, this.lives - 1)); i++) {
      const charRow = 2 + i * 2;
      videoram[((charRow & 0x1f) << 5) | 30] = PLAYER_SHIP_ORDINAL;
      videoram[(((charRow + 1) & 0x1f) << 5) | 30] = PLAYER_SHIP_ORDINAL + 2;
    }
    objram[30 * 2 + 1] = 4;
    objram[30 * 2] = 0;
  }
}
