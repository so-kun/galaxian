/**
 * Aliens in flight.
 *
 * `INFLIGHT_ALIENS` at $42B0 is eight 32-byte records, and the slot each kind of
 * alien may use is hardcoded:
 *
 *   slot 0     scratch -- the free sprite used for the explosion when a swarm
 *              alien is shot ($0B52)
 *   slot 1     the flagship
 *   slots 2,3  the flagship's escorts
 *   slots 4-7  lone attackers
 *
 * Eight slots minus the scratch one is why at most seven aliens can ever be in
 * flight. How many of slots 4-7 are actually scanned is decided by difficulty
 * ($1352): `(DIFFICULTY_BASE_VALUE + DIFFICULTY_EXTRA_VALUE) / 2`, clamped to 3
 * and then incremented, so early stages send one attacker and late ones four.
 *
 * Coordinates are the hardware's, not the screen's: X is the player's vertical
 * axis (X++ moves down) and Y is the player's horizontal axis (Y++ moves left).
 */

import { ARC_TABLE, calculateTangent, spriteForHeading } from './arc';
import type { Swarm } from './swarm';
import { SWARM_LAYOUT, swarmIndex } from './swarm';
import { INFLIGHT_FLAGSHIP_OFFSET } from '../video/gfx';

export const INFLIGHT_SLOTS = 8;
export const SLOT_SCRATCH = 0;
export const SLOT_FLAGSHIP = 1;
export const SLOT_ESCORT_FIRST = 2;
export const SLOT_ATTACKER_FIRST = 4;

/** `INFLIGHT_ALIEN.StageOfLife`. */
export enum Stage {
  Idle = 0,
  /** Peeling out of the formation along the arc. */
  FliesInArc,
  ReadyToAttack,
  /** Descending on the player, steering with CALCULATE_TANGENT. */
  Attacking,
  /** The 270 degree part of a 360 degree taunt. */
  LoopTheLoop,
  /** The remaining 90 degrees, handed back to the arc routine. */
  CompleteLoop,
  /** Flew off the bottom; re-enters from the top. */
  Returning,
  Dying,
}

/** One record of `INFLIGHT_ALIENS`, with the disassembly's field names. */
export interface InflightAlien {
  isActive: boolean;
  isDying: boolean;
  stageOfLife: Stage;
  /** Player's vertical axis; increases downward. */
  x: number;
  /** Player's horizontal axis; increases leftward. */
  y: number;
  /** Signed heading, -12..11, driving the sprite's rotation frame. */
  animationFrame: number;
  arcClockwise: boolean;
  indexInSwarm: number;
  animFrameStartCode: number;
  tempCounter1: number;
  tempCounter2: number;
  deathAnimCode: number;
  /** Byte offset into the arc table: two bytes are consumed per frame. */
  arcTableLsb: number;
  colour: number;
  sortieCount: number;
  speed: number;
  pivotYValue: number;
  pivotYValueAdd: number;
}

function emptyAlien(): InflightAlien {
  return {
    isActive: false,
    isDying: false,
    stageOfLife: Stage.Idle,
    x: 0,
    y: 0,
    animationFrame: 0,
    arcClockwise: false,
    indexInSwarm: 0,
    animFrameStartCode: 0,
    tempCounter1: 0,
    tempCounter2: 0,
    deathAnimCode: 0,
    arcTableLsb: 0,
    colour: 0,
    sortieCount: 0,
    speed: 1,
    pivotYValue: 0,
    pivotYValueAdd: 0,
  };
}

/** Frames between rotation-frame changes while flying the arc ($0D99). */
const ARC_ANIM_DELAY = 4;
/** Rotation frames to work through before the alien is ready to attack. */
const ARC_ANIM_FRAMES = 6;

/** X beyond which an alien has left the bottom of the screen. */
const OFF_BOTTOM = 250;

export class InflightAliens {
  readonly slots: InflightAlien[] = Array.from({ length: INFLIGHT_SLOTS }, emptyAlien);

  /** DIFFICULTY_BASE_VALUE: bumped during a stage, capped at 7. */
  difficultyBase = 0;
  /** DIFFICULTY_EXTRA_VALUE: bumped on stage completion, capped at 7. */
  difficultyExtra = 0;

  reset(): void {
    for (let i = 0; i < INFLIGHT_SLOTS; i++) this.slots[i] = emptyAlien();
  }

  /**
   * How many of the four lone-attacker slots are live, from $1352.
   *
   * The original computes `(base + extra) / 2`, clamps to 3, then increments,
   * giving 1 through 4.
   */
  get activeAttackerSlots(): number {
    return Math.min(3, (this.difficultyBase + this.difficultyExtra) >> 1) + 1;
  }

  get inFlightCount(): number {
    let n = 0;
    for (let i = 1; i < INFLIGHT_SLOTS; i++) if (this.slots[i]!.isActive) n++;
    return n;
  }

  /** First free lone-attacker slot, scanned 7 down to 4 as TRY_INIT does. */
  private freeAttackerSlot(): number {
    const lowest = SLOT_ATTACKER_FIRST + (4 - this.activeAttackerSlots);
    for (let i = INFLIGHT_SLOTS - 1; i >= lowest; i--) {
      if (!this.slots[i]!.isActive) return i;
    }
    return -1;
  }

  /**
   * Launch an alien out of the formation.
   *
   * Aliens leave from the edges of the swarm, arcing up and away before turning
   * on the player. `arcClockwise` decides which way they peel off, which the
   * arc routine uses to pick the sign of the Y delta.
   */
  launchFromSwarm(swarm: Swarm, rng: () => number): boolean {
    const candidates: { row: number; col: number; colorCode: number; flagship: boolean }[] = [];
    for (const row of SWARM_LAYOUT) {
      for (const col of row.columns) {
        if (swarm.flags[swarmIndex(row.row, col)]) {
          candidates.push({
            row: row.row,
            col,
            colorCode: row.colorCode,
            flagship: row.kind === 'flagship',
          });
        }
      }
    }
    if (candidates.length === 0) return false;

    const pick = candidates[Math.floor(rng() * candidates.length)]!;
    const slot = pick.flagship ? this.tryFlagshipSlot() : this.freeAttackerSlot();
    if (slot < 0) return false;

    swarm.remove(pick.row, pick.col);
    const rowDef = SWARM_LAYOUT.find((r) => r.row === pick.row)!;

    const alien = this.slots[slot]!;
    Object.assign(alien, emptyAlien());
    alien.isActive = true;
    alien.stageOfLife = Stage.FliesInArc;
    alien.indexInSwarm = swarmIndex(pick.row, pick.col);
    alien.colour = pick.colorCode;
    alien.animFrameStartCode = pick.flagship ? INFLIGHT_FLAGSHIP_OFFSET : 0;
    alien.speed = 1 + (this.difficultyExtra >> 2);
    alien.tempCounter1 = ARC_ANIM_DELAY;
    alien.tempCounter2 = ARC_ANIM_FRAMES;
    alien.arcTableLsb = 0;

    // Formation position, in hardware coordinates.
    alien.x = rowDef.charCol * 8 + 4;
    alien.y = (224 - (pick.col * 16 - swarm.scroll - 16)) & 0xff;

    // Aliens on the left of the formation peel left, those on the right peel
    // right, so they arc away from the swarm rather than through it.
    alien.arcClockwise = pick.col < 8;
    alien.animationFrame = alien.arcClockwise ? -1 : 1;

    if (pick.flagship) this.launchEscorts(swarm, alien);
    return true;
  }

  private tryFlagshipSlot(): number {
    return this.slots[SLOT_FLAGSHIP]!.isActive ? -1 : SLOT_FLAGSHIP;
  }

  /**
   * "We only want 2 red aliens as an escort" ($1483). Escorts are pulled from
   * the red row and fly in formation beside the flagship.
   */
  private launchEscorts(swarm: Swarm, flagship: InflightAlien): void {
    const redRow = SWARM_LAYOUT.find((r) => r.kind === 'red')!;
    let placed = 0;
    for (const col of redRow.columns) {
      if (placed >= 2) break;
      if (!swarm.flags[swarmIndex(redRow.row, col)]) continue;
      const slot = SLOT_ESCORT_FIRST + placed;
      if (this.slots[slot]!.isActive) continue;
      swarm.remove(redRow.row, col);

      const escort = this.slots[slot]!;
      Object.assign(escort, emptyAlien());
      escort.isActive = true;
      escort.stageOfLife = Stage.FliesInArc;
      escort.indexInSwarm = swarmIndex(redRow.row, col);
      escort.colour = redRow.colorCode;
      escort.arcClockwise = flagship.arcClockwise;
      escort.animationFrame = flagship.animationFrame;
      escort.speed = flagship.speed;
      escort.tempCounter1 = ARC_ANIM_DELAY;
      escort.tempCounter2 = ARC_ANIM_FRAMES;
      escort.x = flagship.x;
      // Sit one alien-width either side of the flagship.
      escort.y = (flagship.y + (placed === 0 ? 16 : -16)) & 0xff;
      placed++;
    }
  }

  /** Advance every live alien by one frame. */
  update(playerX: number, playerY: number): void {
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.slots[i]!;
      if (!alien.isActive) continue;
      switch (alien.stageOfLife) {
        case Stage.FliesInArc:
        case Stage.CompleteLoop:
          this.fliesInArc(alien);
          break;
        case Stage.ReadyToAttack:
          alien.stageOfLife = Stage.Attacking;
          break;
        case Stage.Attacking:
          this.attacks(alien, playerX, playerY);
          break;
        case Stage.LoopTheLoop:
          this.loopTheLoop(alien);
          break;
        case Stage.Returning:
          this.returns(alien);
          break;
        default:
          break;
      }
    }
  }

  /**
   * INFLIGHT_ALIEN_FLIES_IN_ARC ($0D71).
   *
   * Two table bytes are consumed per frame: the X delta unconditionally, then
   * the Y delta added or subtracted depending on which way the alien is facing.
   * The rotation frame ticks down every fourth frame; when the frame budget is
   * exhausted the alien is ready to attack.
   */
  private fliesInArc(alien: InflightAlien): void {
    const step = ARC_TABLE[alien.arcTableLsb >> 1];
    if (!step) {
      alien.stageOfLife = Stage.ReadyToAttack;
      return;
    }

    alien.x = (alien.x + step.dx) & 0xff;
    alien.y = (alien.y + (alien.arcClockwise ? -step.dy : step.dy)) & 0xff;

    // Off the right-hand edge: re-enter from the top ($0D8B).
    if (((alien.y + 7) & 0xff) < 0x0e) {
      alien.stageOfLife = Stage.Returning;
      return;
    }

    alien.arcTableLsb = (alien.arcTableLsb + 2) & 0xff;

    if (--alien.tempCounter1 > 0) return;
    alien.tempCounter1 = ARC_ANIM_DELAY;
    alien.animationFrame += alien.arcClockwise ? 1 : -1;
    if (--alien.tempCounter2 > 0) return;
    alien.stageOfLife = Stage.ReadyToAttack;
  }

  /**
   * The dive proper: descend and steer toward the player.
   *
   * CALCULATE_TANGENT turns the distance and horizontal offset into a heading,
   * which both aims the alien and picks its rotation frame.
   */
  private attacks(alien: InflightAlien, playerX: number, playerY: number): void {
    const speed = 1 + alien.speed;
    alien.x = (alien.x + speed) & 0xff;

    const distance = (playerX - alien.x) & 0xff;
    const offset = ((playerY - alien.y + 128) & 0xff) - 128;
    const heading = calculateTangent(Math.max(1, distance), offset);
    alien.animationFrame = heading;
    alien.y = (alien.y + Math.sign(offset) * Math.min(2, Math.abs(offset))) & 0xff;

    if (alien.x >= OFF_BOTTOM || alien.x < 8) {
      alien.stageOfLife = Stage.Returning;
      alien.x = 0;
    }
  }

  /**
   * INFLIGHT_ALIEN_LOOP_THE_LOOP ($101F). The X delta is *subtracted* here,
   * which is what turns the same table into a loop rather than a peel-off.
   */
  private loopTheLoop(alien: InflightAlien): void {
    const step = ARC_TABLE[alien.arcTableLsb >> 1];
    if (!step) {
      alien.stageOfLife = Stage.CompleteLoop;
      return;
    }
    alien.x = (alien.x - step.dx) & 0xff;
    alien.y = (alien.y + (alien.arcClockwise ? step.dy : -step.dy)) & 0xff;
    alien.arcTableLsb = (alien.arcTableLsb + 2) & 0xff;

    if (--alien.tempCounter1 > 0) return;
    alien.tempCounter1 = ARC_ANIM_DELAY;
    alien.animationFrame += alien.arcClockwise ? 1 : -1;
    if (--alien.tempCounter2 > 0) return;

    // Hand the last 90 degrees back to the arc routine ($104C).
    alien.stageOfLife = Stage.CompleteLoop;
    alien.tempCounter1 = 3;
    alien.tempCounter2 = 0x0c;
    alien.animationFrame = 0x0c;
    alien.arcTableLsb = 0;
  }

  /** Re-enter from the top of the screen and rejoin the formation. */
  private returns(alien: InflightAlien): void {
    alien.x = (alien.x + 2) & 0xff;
    alien.animationFrame = 0;
    if (alien.x > 40) {
      alien.isActive = false;
      alien.stageOfLife = Stage.Idle;
    }
  }

  /** Write the live aliens into the hardware sprite records at $5840. */
  writeSprites(objram: Uint8Array, spriteBase: number): void {
    for (let slot = 0; slot < INFLIGHT_SLOTS; slot++) {
      const alien = this.slots[slot]!;
      const base = spriteBase + slot * 4;
      if (!alien.isActive) {
        objram[base] = 0;
        objram[base + 1] = 0;
        objram[base + 2] = 0;
        objram[base + 3] = 0;
        continue;
      }
      const { code, flipX, flipY } = spriteForHeading(alien.animationFrame, alien.animFrameStartCode);
      objram[base] = alien.y & 0xff;
      objram[base + 1] = (code & 0x3f) | (flipX ? 0x40 : 0) | (flipY ? 0x80 : 0);
      objram[base + 2] = alien.colour & 7;
      objram[base + 3] = alien.x & 0xff;
    }
  }
}
