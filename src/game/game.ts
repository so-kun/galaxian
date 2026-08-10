/**
 * The game, following the original's control flow (HANDLE_MAIN_GAME_LOGIC and
 * friends, via the annotated disassembly and JOTD's 68k transcode).
 *
 * Structural facts that shape everything here:
 *
 *  - The player ship is a 2x2 block of characters at $51FC. It moves by
 *    writing `~PLAYER_Y + $80` into the scroll registers of its own character
 *    columns (SET_PLAYER_SHIP_SCROLL_OFFSET, $0865). PLAYER_Y runs $17..$E9;
 *    left is Y++.
 *  - Attack cadence is a bank of 16 down-counters (ALIEN_ATTACK_COUNTERS,
 *    $424A). A master counter expires every 5 frames and then decrements
 *    between 1 and 16 secondary counters depending on difficulty; any of them
 *    reaching zero releases one attacker. Flagship sorties run on their own
 *    pair of counters (~every 6-9 seconds, sooner at higher difficulty).
 *  - There are 14 logical enemy bullets ($4260), multiplexed two-per-slot onto
 *    the 7 hardware shell slots on alternating frames.
 *  - When a flagship is shot, the swarm goes into shock: nothing launches and
 *    nobody fires until the shock counter runs out.
 */

import { Swarm, SWARM_LAYOUT, swarmIndex, rowAnchorX, colAnchorY } from './swarm';
import { InflightAliens, INFLIGHT_SLOTS, SLOT_FLAGSHIP, type InflightAlien } from './inflight';
import { calculateTangent } from './arc';
import {
  CHAR_SPACE,
  PLAYER_SHIP_ORDINAL,
  PLAYER_EXPLOSION_ORDINALS,
  charOrdinal,
} from '../video/gfx';
import {
  COLOR_CODE_TEXT_WHITE,
  COLOR_CODE_TEXT_RED,
  COLOR_CODE_PLAYER,
  COLOR_CODE_EXPLOSION,
} from '../video/palette';
import { SPRITE_BASE, BULLET_BASE } from '../video/hardware';
import type { InputState } from '../input';

/** Sound interface, named for what the board's sound lines actually do. */
export interface SoundSink {
  playerShoot(): void;
  alienDeath(): void;
  flagshipDeath(): void;
  playerDeath(): void;
  gameStart(): void;
  extraLife(): void;
  diveStart(): void;
  /** Background swarm loop; rate rises the longer the stage runs. */
  setSwarmLoop(playing: boolean, rate: number): void;
}

/** ALIEN_SCORE_TABLE ($22D0), BCD in ROM, decoded. */
export const ALIEN_SCORES = [30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 300, 800] as const;

/** Bonus thresholds from the DIP switch table at $1F52. */
export const BONUS_THRESHOLDS = [7000, 10000, 12000, 20000] as const;

/** Flagship payout by FLAGSHIP_SCORE_FACTOR (0..3): alone, +1, +2 escorts, full convoy. */
export const FLAGSHIP_SCORES = [150, 200, 300, 800] as const;
/** Sprite code of the "150" points value; +factor selects 200/300/800 ($20-$23). */
export const FLAGSHIP_POINT_SPRITE_BASE = 0x20;

/**
 * Frames between DIFFICULTY_EXTRA_VALUE steps: DIFFICULTY_COUNTER_1 ($3C = 60)
 * times DIFFICULTY_COUNTER_2 ($14 = 20).
 */
const DIFFICULTY_EXTRA_PERIOD = 0x3c * 0x14;

/** ALIEN_ATTACK_COUNTER_DEFAULT_VALUES ($15E3). */
const ATTACK_COUNTER_DEFAULTS = [
  0x05, 0x2f, 0x43, 0x77, 0x71, 0x6d, 0x67, 0x65, 0x4f, 0x49, 0x43, 0x3d, 0x3b, 0x35, 0x2b, 0x29,
] as const;

/** PLAYER_Y limits from HANDLE_PLAYER_MOVE: right edge $17, left edge $E9. */
const PLAYER_Y_MIN = 0x17;
const PLAYER_Y_MAX = 0xe9;
const PLAYER_SPAWN_Y = 0x80;

/** The ship's characters sit at column 28; its centre line is X ~ $F0. */
const SHIP_CHAR_COL = 28;
const PLAYER_X = 0xf0;

const ENEMY_BULLET_COUNT = 14;

interface EnemyBullet {
  active: boolean;
  x: number;
  yl: number;
  yh: number;
  yDelta: number;
}

const byte = (v: number) => v & 0xff;
const signed = (v: number) => ((v & 0xff) ^ 0x80) - 0x80;

const enum PlayerState {
  Alive,
  Exploding,
  Waiting,
}

export class Game {
  readonly swarm = new Swarm();
  readonly inflight = new InflightAliens();

  /** PLAYER_Y ($4202): the ship's position along the player's horizontal. */
  playerY = PLAYER_SPAWN_Y;
  private playerState = PlayerState.Alive;
  private explosionFrame = 0;
  private explosionCounter = 0;
  private respawnDelay = 0;

  /** The one player shot ($4208-$420B). */
  private bulletActive = false;
  private bulletX = 0;
  private bulletY = 0;
  private firePressed = false;

  private enemyBullets: EnemyBullet[] = Array.from({ length: ENEMY_BULLET_COUNT }, () => ({
    active: false,
    x: 0,
    yl: 0,
    yh: 0,
    yDelta: 0,
  }));

  score = 0;
  highScore = 0;
  lives = 3;
  stage = 1;
  bonusThreshold: number = BONUS_THRESHOLDS[0];
  private bonusAwarded = false;
  gameOver = false;
  /** Frames elapsed on the game-over screen without the player pressing start. */
  idleFrames = 0;

  /** TIMING_VARIABLE ($425F); the original decrements, direction is irrelevant. */
  private frame = 0;

  /** ALIEN_ATTACK_COUNTERS ($424A): master plus 15 secondaries. */
  private attackCounters = [...ATTACK_COUNTER_DEFAULTS];
  /** FLAGSHIP_ATTACK_MASTER_COUNTER_1/2 ($4245/$4246). */
  private flagshipCounter1 = 0x3c;
  private flagshipCounter2 = 8;
  /** ALIENS_ATTACK_FROM_RIGHT_FLANK ($4215). */
  private attackFromRight = false;
  /** IS_FLAGSHIP_HIT ($422B) and ALIENS_IN_SHOCK_COUNTER ($422C). */
  private flagshipHit = false;
  private shockCounter = 0;
  /** Escorts killed before the flagship, for the convoy bonus. */
  private escortsKilledBeforeFlagship = 0;

  /** Free-running stage timer, used only for the swarm-loop tempo. */
  private stageTimer = 0;
  /** Countdown to the next DIFFICULTY_EXTRA_VALUE step ($3C x $14 frames). */
  private difficultyExtraCounter = DIFFICULTY_EXTRA_PERIOD;

  sound: SoundSink | null = null;
  private divesActive = 0;

  constructor() {
    this.inflight.events = {
      onDiveStart: () => {
        this.divesActive++;
        this.sound?.diveStart();
      },
      onDiveEnd: () => {
        this.divesActive = Math.max(0, this.divesActive - 1);
      },
      onShoot: (alien) => this.spawnEnemyBullet(alien),
      onFlagshipEscape: () => {
        // A fleeing flagship is carried over; the original allows up to 2.
      },
    };
    this.reset();
  }

  reset(): void {
    // DIFFICULTY_BASE_VALUE ($421B) is the player level, 1 at the start; it
    // climbs one per stage and is never reset until a new game.
    this.inflight.difficultyBase = 1;
    this.startStage(1);
    this.score = 0;
    this.lives = 3;
    this.bonusAwarded = false;
    this.gameOver = false;
    this.idleFrames = 0;
    this.playerState = PlayerState.Alive;
    this.playerY = PLAYER_SPAWN_Y;
    this.sound?.gameStart();
  }

  private startStage(stage: number): void {
    this.stage = stage;
    this.swarm.reset();
    this.inflight.reset();
    // DIFFICULTY_EXTRA_VALUE ($421A) resets to 0 at the start of each stage.
    this.inflight.difficultyExtra = 0;
    this.difficultyExtraCounter = DIFFICULTY_EXTRA_PERIOD;
    this.bulletActive = false;
    for (const b of this.enemyBullets) b.active = false;
    this.attackCounters = [...ATTACK_COUNTER_DEFAULTS];
    this.flagshipCounter1 = 0x3c;
    this.flagshipCounter2 = 8;
    this.flagshipHit = false;
    this.shockCounter = 0;
    this.stageTimer = 0;
    this.divesActive = 0;
  }

  get playerSpawned(): boolean {
    return this.playerState === PlayerState.Alive && !this.gameOver;
  }

  step(input: InputState): void {
    this.frame++;

    if (this.gameOver) {
      this.sound?.setSwarmLoop(false, 1);
      if (input.start) {
        this.reset();
        return;
      }
      this.idleFrames++;
      this.swarm.update(this.frame, null);
      return;
    }

    this.stageTimer++;
    // DIFFICULTY_EXTRA_VALUE climbs the longer the stage runs -- COUNTER_1
    // ($3C) x COUNTER_2 ($14) = 1200 frames per step, capped at 7 ($14FF).
    if (--this.difficultyExtraCounter <= 0) {
      this.difficultyExtraCounter = DIFFICULTY_EXTRA_PERIOD;
      this.inflight.difficultyExtra = Math.min(7, this.inflight.difficultyExtra + 1);
    }
    // HAVE_AGGRESSIVE_ALIENS ($4224, set at $16E7): the survivors turn
    // extremely aggressive once three or fewer aliens remain in the swarm.
    this.inflight.aggressive = this.swarm.aliveCount <= 3;

    this.updateSwarmSound();
    this.swarm.update(
      this.frame,
      this.bulletActive ? { x: this.bulletX, y: this.bulletY } : null,
    );
    this.updatePlayer(input);
    this.updatePlayerBullet();
    this.updateEnemyBullets();
    this.inflight.update(this.frame, this.playerY, this.playerSpawned, this.flagshipHit, this.swarm);
    this.updateShock();
    this.updateAttackDirectors();
    this.checkCollisions();
    this.checkStageComplete();
  }

  /**
   * "The longer the level takes to complete, the faster and angrier the swarm
   * is" -- the loop's tempo rises with the stage timer and thins with the
   * swarm.
   */
  private updateSwarmSound(): void {
    const shouldPlay = this.playerSpawned && this.swarm.aliveCount > 0;
    const rate = 1 + Math.min(0.7, this.stageTimer / 7200) + (46 - this.swarm.aliveCount) / 150;
    this.sound?.setSwarmLoop(shouldPlay, rate);
  }

  private updatePlayer(input: InputState): void {
    if (this.playerState === PlayerState.Exploding) {
      if (--this.explosionCounter <= 0) {
        this.explosionCounter = 10;
        if (++this.explosionFrame >= PLAYER_EXPLOSION_ORDINALS.length) {
          this.playerState = PlayerState.Waiting;
          this.respawnDelay = 80;
        }
      }
      return;
    }
    if (this.playerState === PlayerState.Waiting) {
      if (--this.respawnDelay <= 0) {
        if (this.lives <= 0) {
          this.gameOver = true;
        } else {
          this.playerState = PlayerState.Alive;
          this.playerY = PLAYER_SPAWN_Y;
        }
      }
      return;
    }

    // HANDLE_PLAYER_MOVE: right is Y--, left is Y++, one pixel per frame.
    if (input.right && this.playerY > PLAYER_Y_MIN) this.playerY--;
    if (input.left && this.playerY < PLAYER_Y_MAX) this.playerY++;

    // One shot at a time; the button must be released between shots.
    if (input.fire && !this.firePressed && !this.bulletActive) {
      this.bulletActive = true;
      this.bulletX = PLAYER_X - 0x14;
      this.bulletY = this.playerY;
      this.sound?.playerShoot();
    }
    this.firePressed = input.fire;
  }

  /** POSITION_PLAYER_BULLET ($08BC): four pixels per frame, expires high. */
  private updatePlayerBullet(): void {
    if (!this.bulletActive) return;
    this.bulletX = byte(this.bulletX - 4);
    if (this.bulletX < 0x12) this.bulletActive = false;
  }

  /**
   * SPAWN_ENEMY_BULLET ($1200): aimed with CALCULATE_TANGENT plus a random
   * spread, then integrated in 16-bit fixed point as it falls.
   */
  private spawnEnemyBullet(alien: InflightAlien): void {
    const slot = this.enemyBullets.find((b) => !b.active);
    if (!slot) return;
    slot.active = true;
    slot.x = alien.x;
    slot.yh = alien.y;
    slot.yl = 0;

    const distance = byte(0xf0 - alien.x);
    const diff = signed(this.playerY - alien.y);
    const t = calculateTangent(Math.abs(diff), distance);
    let delta = t + Math.floor(Math.random() * 32) + 6;
    if (delta > 0x7f) delta = 0x7f;
    slot.yDelta = diff >= 0 ? delta : byte(-delta);
  }

  /** HANDLE_ENEMY_BULLETS ($0A80): two pixels down, YDelta*2/256 sideways. */
  private updateEnemyBullets(): void {
    for (const b of this.enemyBullets) {
      if (!b.active) continue;
      b.x = byte(b.x + 2);
      if (b.x + 4 > 0xff) {
        b.active = false;
        continue;
      }
      const d = signed(b.yDelta) * 2;
      let y16 = ((b.yh << 8) | b.yl) + d;
      y16 &= 0xffff;
      b.yl = y16 & 0xff;
      b.yh = (y16 >> 8) & 0xff;
      // Off either side?
      if (byte(b.yh + 0x10) < 0x20) b.active = false;
    }
  }

  private updateShock(): void {
    if (!this.flagshipHit) return;
    if (--this.shockCounter <= 0) {
      this.flagshipHit = false;
    }
  }

  /**
   * The two attack directors: HANDLE_ALIEN_ATTACK's counter bank for lone
   * attackers, and UPDATE_ATTACK_COUNTERS' timer pair for flagship sorties.
   */
  /**
   * ALIENS_ATTACK_FROM_RIGHT_FLANK ($4215), from $13F0.
   *
   * The swarm's signed scroll ($420E) is compared against its current extents
   * ($4210). Within $1C of the near extent, aliens attack from that flank;
   * beyond it, the flank is a coin toss.
   */
  private chooseAttackFlank(): void {
    const scroll = this.swarm.scroll16;
    if (scroll < 0) {
      // Swept toward the left extent.
      if (byte(scroll - this.swarm.leftLimit) >= 0x1c) this.attackFromRight = Math.random() < 0.5;
      else this.attackFromRight = false;
    } else {
      // Swept toward the right extent.
      if (byte(this.swarm.rightLimit - scroll) >= 0x1c) this.attackFromRight = Math.random() < 0.5;
      else this.attackFromRight = true;
    }
  }

  private updateAttackDirectors(): void {
    if (!this.playerSpawned || this.flagshipHit) return;
    if (this.swarm.aliveCount === 0) return;

    // Choose a flank ($13F0): when the swarm has swept close to one of its
    // scroll extents, aliens peel off from that side; otherwise pick at random.
    if ((this.frame & 0x1f) === 0) this.chooseAttackFlank();

    // Lone attacker cadence.
    const decrements = Math.min(
      16,
      (this.inflight.difficultyBase >= 2 ? this.inflight.difficultyBase : 0) +
        this.inflight.difficultyExtra +
        1,
    );
    if (--this.attackCounters[0]! <= 0) {
      this.attackCounters[0] = ATTACK_COUNTER_DEFAULTS[0];
      let released = false;
      for (let i = 1; i <= decrements && i < 16; i++) {
        if (--this.attackCounters[i]! <= 0) {
          this.attackCounters[i] = ATTACK_COUNTER_DEFAULTS[i]!;
          released = true;
        }
      }
      if (released) {
        this.inflight.launchAttacker(this.swarm, this.attackFromRight);
      }
    }

    // Flagship sortie cadence, only while flagships remain.
    if (this.swarm.hasFlagships || this.slotsFlagshipActive()) {
      if (--this.flagshipCounter1 <= 0) {
        this.flagshipCounter1 = 0x3c;
        if (--this.flagshipCounter2 <= 0) {
          const d = this.inflight.difficultyBase + this.inflight.difficultyExtra;
          this.flagshipCounter2 = Math.max(3, 10 - (((d >> 2) & 3) + 1));
          this.inflight.launchFlagshipOrRed(this.swarm, this.attackFromRight);
        }
      }
    }
  }

  private slotsFlagshipActive(): boolean {
    return this.inflight.slots[SLOT_FLAGSHIP]!.isActive;
  }

  private checkCollisions(): void {
    this.playerBulletVsInflight();
    if (this.bulletActive) this.playerBulletVsSwarm();
    if (this.playerState === PlayerState.Alive) {
      this.enemyBulletsVsPlayer();
      this.inflightVsPlayer();
    }
  }

  /**
   * TEST_IF_PLAYER_BULLET_HIT_INFLIGHT_ALIEN ($123F): the original's exact
   * window -- X within [-2,+4), Y within [-5,+7).
   */
  private playerBulletVsInflight(): void {
    if (!this.bulletActive) return;
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.inflight.slots[i]!;
      if (!alien.isActive) continue;
      if (byte(alien.x - this.bulletX + 2) >= 6) continue;
      if (byte(alien.y - this.bulletY + 5) >= 0x0c) continue;

      this.bulletActive = false;
      const row = alien.indexInSwarm & 0x70;

      if (row === 0x70) {
        // Flagship: the swarm is stunned and the payout depends on the convoy.
        this.flagshipHit = true;
        this.shockCounter = 0xf0; // ALIENS_IN_SHOCK_COUNTER ($422C)

        // FLAGSHIP_SCORE_FACTOR ($422D): the escort count, promoted to 3 only
        // when two escorts flew and both were shot before the flagship ($1292).
        const escortsAlive =
          (this.inflight.slots[2]!.isActive ? 1 : 0) +
          (this.inflight.slots[3]!.isActive ? 1 : 0);
        const escortCount = this.escortsKilledBeforeFlagship + escortsAlive;
        const factor = escortCount === 2 && escortsAlive === 0 ? 3 : escortCount;
        this.escortsKilledBeforeFlagship = 0;

        // Point sprite $20..$23 hovers at the kill site for 50 frames.
        this.inflight.kill(i, FLAGSHIP_POINT_SPRITE_BASE + factor);
        this.addScore(FLAGSHIP_SCORES[factor]!);
        this.sound?.flagshipDeath();
      } else {
        // $125E: parameter 4 for blue, +1 per rank above.
        if (i === 2 || i === 3) this.escortsKilledBeforeFlagship++;
        this.inflight.kill(i);
        const scoreId = row <= 0x40 ? 4 : row === 0x50 ? 5 : 6;
        this.addScore(ALIEN_SCORES[scoreId]!);
        this.sound?.alienDeath();
      }
      return;
    }
  }

  /** Player shot against the formation tiles. */
  private playerBulletVsSwarm(): void {
    const scroll = this.swarm.scroll;
    for (const row of SWARM_LAYOUT) {
      const anchorX = rowAnchorX(row.row);
      const halfH = row.wide ? 8 : 5;
      if (Math.abs(signed(this.bulletX - anchorX)) > halfH) continue;
      for (const col of row.columns) {
        if (!this.swarm.flags[swarmIndex(row.row, col)]) continue;
        const centerY = byte(colAnchorY(col, scroll) + 1);
        if (Math.abs(signed(this.bulletY - centerY)) > 7) continue;

        this.swarm.remove(row.row, col);
        this.bulletActive = false;
        this.spawnSwarmExplosion(anchorX, centerY);
        // In-formation scores: blue 30, purple 40, red 50, flagship 60.
        const scoreId = row.kind === 'blue' ? 0 : row.kind === 'purple' ? 1 : row.kind === 'red' ? 2 : 3;
        this.addScore(ALIEN_SCORES[scoreId]!);
        this.sound?.alienDeath();
        return;
      }
    }
  }

  /** $0B52: the scratch slot shows the explosion for a shot swarm alien. */
  private spawnSwarmExplosion(x: number, y: number): void {
    const scratch = this.inflight.slots[0]!;
    scratch.isDying = true;
    scratch.dyingCounter = 16;
    scratch.x = x;
    scratch.y = y;
  }

  /**
   * TEST_IF_ENEMY_BULLET_HIT_PLAYER ($0B8D), byte-exact.
   *
   * The ship is 32 pixels tall along the hardware X (vertical) axis, and its
   * fixed vertical position is baked into the +$1F constant. Two Y windows: a
   * wide one over the ship's body ($0B) and a narrow one at the near edge ($5).
   */
  private enemyBulletsVsPlayer(): void {
    for (const b of this.enemyBullets) {
      if (!b.active) continue;
      let d0 = byte(b.x + 0x1f);
      const nearEdge = d0 < 5; // borrow from `sub 5`
      d0 = byte(d0 - 5);
      let hit: boolean;
      if (nearEdge) {
        hit = byte(this.playerY - b.yh + 2) < 5;
      } else {
        if (d0 >= 9) continue; // no borrow from `sub 9` -> miss
        hit = byte(this.playerY - b.yh + 5) < 0x0b;
      }
      if (!hit) continue;
      b.active = false;
      this.killPlayer();
      return;
    }
  }

  /**
   * TEST_IF_INFLIGHT_ALIEN_HIT_PLAYER ($12B6), byte-exact.
   *
   * "The player ship is not rectangular. There are 2 widths depending on the
   * part of the ship": the wide body window is $0F, the narrow nose is $15.
   */
  private inflightVsPlayer(): void {
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.inflight.slots[i]!;
      if (!alien.isActive) continue;
      let d0 = byte(alien.x + 0x21);
      const bodyBand = d0 < 5; // borrow from `sub 5`
      d0 = byte(d0 - 5);
      let hit: boolean;
      if (bodyBand) {
        hit = byte(this.playerY - alien.y + 7) < 0x0f;
      } else {
        if (d0 >= 0x0c) continue; // no borrow from `sub $0C` -> miss
        hit = byte(this.playerY - alien.y + 0x0a) < 0x15;
      }
      if (!hit) continue;
      this.inflight.kill(i);
      this.killPlayer();
      return;
    }
  }

  private killPlayer(): void {
    this.playerState = PlayerState.Exploding;
    this.explosionFrame = 0;
    this.explosionCounter = 10;
    this.lives--;
    this.bulletActive = false;
    this.sound?.playerDeath();
    this.sound?.setSwarmLoop(false, 1);
    // HANDLE_PLAYER_HIT: dying reduces the difficulty slightly.
    if (this.inflight.difficultyExtra > 0) this.inflight.difficultyExtra--;
  }

  private addScore(points: number): void {
    this.score += points;
    if (this.score > this.highScore) this.highScore = this.score;
    if (!this.bonusAwarded && this.score >= this.bonusThreshold) {
      this.bonusAwarded = true;
      this.lives++;
      this.sound?.extraLife();
    }
  }

  private checkStageComplete(): void {
    if (this.swarm.aliveCount > 0 || this.inflight.inFlightCount > 0) return;
    // On completing a stage ($1655): the player level and DIFFICULTY_BASE_VALUE
    // both climb by one (capped at 7), and DIFFICULTY_EXTRA_VALUE resets in
    // startStage.
    this.inflight.difficultyBase = Math.min(7, this.inflight.difficultyBase + 1);
    this.startStage(this.stage + 1);
  }

  // -------------------------------------------------------------------------
  // Rendering into hardware memory
  // -------------------------------------------------------------------------

  render(videoram: Uint8Array, objram: Uint8Array): void {
    videoram.fill(CHAR_SPACE);
    this.swarm.draw(videoram, objram, this.frame);
    this.drawPlayer(videoram, objram);
    this.drawHud(videoram, objram);
    this.inflight.writeSprites(objram, SPRITE_BASE);
    this.writeBullets(objram);
  }

  /**
   * The ship: characters at $51FC, positioned by writing `~PLAYER_Y + $80`
   * into the scroll registers of columns 26-29 (four columns, because the
   * explosion is 4x4).
   */
  private drawPlayer(videoram: Uint8Array, objram: Uint8Array): void {
    const scroll = byte(~this.playerY + 0x80);
    const color =
      this.playerState === PlayerState.Exploding ? COLOR_CODE_EXPLOSION : COLOR_CODE_PLAYER;
    for (let col = SHIP_CHAR_COL - 2; col <= SHIP_CHAR_COL + 1; col++) {
      objram[col * 2] = scroll;
      objram[col * 2 + 1] = color;
    }

    if (this.playerState === PlayerState.Waiting) return;

    if (this.playerState === PlayerState.Exploding) {
      const base = PLAYER_EXPLOSION_ORDINALS[Math.min(this.explosionFrame, 3)]!;
      // 4x4 characters centred on the ship cell.
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const addr = (((14 + cy) & 0x1f) << 5) | ((SHIP_CHAR_COL - 2 + cx) & 0x1f);
          videoram[addr] = base + cy * 4 + cx;
        }
      }
      return;
    }

    // PLOT_CHARACTERS_2_BY_2_ASCENDING at $51FC (row 15, cols 28-29).
    videoram[0x1fc] = PLAYER_SHIP_ORDINAL;
    videoram[0x1fd] = PLAYER_SHIP_ORDINAL + 1;
    videoram[0x1fc + 32] = PLAYER_SHIP_ORDINAL + 2;
    videoram[0x1fd + 32] = PLAYER_SHIP_ORDINAL + 3;
  }

  /**
   * Bullets. The player's missile is hardware slot 7; the 14 logical enemy
   * bullets multiplex onto shell slots 0-6, two per slot on alternate frames.
   * Registers hold complements: Y = ~coordinate, X = ~coordinate - offset.
   */
  private writeBullets(objram: Uint8Array): void {
    objram.fill(0, BULLET_BASE, BULLET_BASE + 32);

    if (this.bulletActive) {
      const base = BULLET_BASE + 7 * 4;
      objram[base + 1] = byte(~this.bulletY);
      objram[base + 3] = byte(~this.bulletX - 4);
    }

    const parity = this.frame & 1;
    for (let slot = 0; slot < 7; slot++) {
      const b = this.enemyBullets[slot * 2 + parity];
      if (!b || !b.active) continue;
      const base = BULLET_BASE + slot * 4;
      objram[base + 1] = byte(~b.yh);
      objram[base + 3] = byte(~b.x - 1);
    }
  }

  /**
   * The HUD, laid out like the original: red header and white scores along
   * the top, lives bottom-left and stage flags bottom-right.
   *
   * Text helper: the scanline axis is inverted on screen, so successive
   * characters of left-to-right text go to *decreasing* character rows.
   */
  private drawHud(videoram: Uint8Array, objram: Uint8Array): void {
    const write = (charRow: number, charCol: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        const addr = (((charRow - i) & 0x1f) << 5) | (charCol & 0x1f);
        videoram[addr] = text[i] === ' ' ? CHAR_SPACE : charOrdinal(text[i]!);
      }
    };

    // Column colour attributes for the HUD areas.
    objram[0 * 2 + 1] = COLOR_CODE_TEXT_RED;
    objram[0 * 2] = 0;
    objram[1 * 2 + 1] = COLOR_CODE_TEXT_WHITE;
    objram[1 * 2] = 0;
    objram[30 * 2 + 1] = COLOR_CODE_PLAYER;
    objram[30 * 2] = 0;
    objram[31 * 2 + 1] = COLOR_CODE_TEXT_WHITE;
    objram[31 * 2] = 0;

    // Header (charCol 0 = top row) and scores below it.
    write(26, 0, '1UP');
    write(19, 0, 'HIGH SCORE');
    write(25, 1, this.score.toString().padStart(6, '0').replace(/^00/, '  '));
    write(17, 1, this.highScore.toString().padStart(6, '0').replace(/^00/, '  '));

    if (this.gameOver) {
      objram[15 * 2 + 1] = COLOR_CODE_TEXT_RED;
      objram[15 * 2] = 0;
      write(16, 15, 'GAME OVER');
    }

    // A 2x2 block, PLOT_CHARACTERS_2_BY_2_ASCENDING order: base and base+1 on
    // one character row, base+2 and base+3 on the next.
    const plot2x2 = (row: number, col: number, base: number) => {
      videoram[((row & 0x1f) << 5) | (col & 0x1f)] = base;
      videoram[((row & 0x1f) << 5) | ((col + 1) & 0x1f)] = base + 1;
      videoram[(((row + 1) & 0x1f) << 5) | (col & 0x1f)] = base + 2;
      videoram[(((row + 1) & 0x1f) << 5) | ((col + 1) & 0x1f)] = base + 3;
    };

    // Lives as ship glyphs, bottom-left (high char rows on columns 30-31).
    for (let i = 0; i < Math.min(4, Math.max(0, this.lives - 1)); i++) {
      plot2x2(26 - i * 2, 30, PLAYER_SHIP_ORDINAL);
    }

    // Stage flags, bottom-right, from DISPLAY_LEVEL_FLAGS ($2521): a "10"
    // flag (2x2, ordinal $68) per ten stages and a small flag (1x2, ordinal
    // $6C) per unit, drawn from character row 3 leftward.
    let flagRow = 3;
    const tens = Math.floor(Math.min(48, this.stage) / 10);
    const units = Math.min(48, this.stage) % 10;
    for (let i = 0; i < tens; i++) {
      plot2x2(flagRow, 30, 0x68);
      flagRow += 2;
    }
    for (let i = 0; i < units; i++) {
      videoram[((flagRow & 0x1f) << 5) | 30] = 0x6c;
      videoram[((flagRow & 0x1f) << 5) | 31] = 0x6d;
      flagRow += 1;
    }
  }
}
