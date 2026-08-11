/**
 * Aliens in flight: the original's 16-stage state machine, ported from the
 * annotated disassembly and JOTD's 68k transcode of the same code.
 *
 * Slot assignment is hardcoded (eight sprites, one reserved):
 *
 *   slot 0     scratch (explosion when a swarm alien is shot)
 *   slot 1     the flagship
 *   slots 2,3  the flagship's escorts
 *   slots 4-7  lone attackers
 *
 * The signature move -- the wide S-weave of a diving alien -- is not a spline
 * or a table. UPDATE_INFLIGHT_ALIEN_YADD ($116B) is a fixed-point harmonic
 * oscillator: with H = PivotYValueAdd and L its velocity (plus two fraction
 * bytes), each iteration does H += 2L/256 and L -= 2H/256, run Speed+1 times
 * per frame. Y is then simply PivotYValue + PivotYValueAdd. The alien's
 * horizontal position literally oscillates about its pivot, with the amplitude
 * set once at the top of the dive from the player's relative position.
 *
 * Coordinates are the hardware's: X is the player's vertical axis (X++ is
 * down), Y is the player's horizontal axis (Y++ is left).
 */

import { ARC_TABLE, calculateTangent, spriteForHeading } from './arc';
import { ALIEN_EXPLOSION_SPRITE } from '../video/gfx';
import { COLOR_CODE_EXPLOSION, COLOR_CODE_TEXT_WHITE } from '../video/palette';
import type { Swarm } from './swarm';
import { SWARM_LAYOUT, swarmIndex, rowAnchorX, colAnchorY, rowByIndex } from './swarm';
import { INFLIGHT_FLAGSHIP_OFFSET } from '../video/gfx';

export const INFLIGHT_SLOTS = 8;
export const SLOT_SCRATCH = 0;
export const SLOT_FLAGSHIP = 1;
export const SLOT_ESCORT_FIRST = 2;
export const SLOT_ATTACKER_FIRST = 4;

/** StageOfLife values, in the order of the jump table at $0CD6. */
export enum Stage {
  PacksBags = 0,
  FliesInArc = 1,
  ReadyToAttack = 2,
  AttackingPlayer = 3,
  NearBottomOfScreen = 4,
  ReachedBottomOfScreen = 5,
  ReturningToSwarm = 6,
  ContinuingFromTop = 7,
  FullSpeedCharge = 8,
  AttackingAggressively = 9,
  LoopTheLoop = 10,
  CompleteLoop = 11,
  AfterLoop = 12,
}

/** One INFLIGHT_ALIEN record, with the disassembly's field names. */
export interface InflightAlien {
  isActive: boolean;
  isDying: boolean;
  stageOfLife: Stage;
  x: number;
  y: number;
  /** Signed heading byte driving the rotation frame. */
  animationFrame: number;
  arcClockwise: boolean;
  indexInSwarm: number;
  animFrameStartCode: number;
  tempCounter1: number;
  tempCounter2: number;
  dyingCounter: number;
  /** Dying frame index, animating the two explosion frames ($1E/$1F). */
  dyingAnimFrame: number;
  /**
   * Points sprite to show after a flagship's explosion ($20 + score factor),
   * or 0 for a plain alien that just vanishes.
   */
  pointSprite: number;
  arcTableLsb: number;
  colour: number;
  sortieCount: number;
  speed: number;
  /** The oscillator: H, L and their fraction bytes D, E. */
  pivotYValue: number;
  yaddH: number;
  yaddL: number;
  yaddD: number;
  yaddE: number;
}

function emptyAlien(): InflightAlien {
  return {
    isActive: false,
    isDying: false,
    stageOfLife: Stage.PacksBags,
    x: 0,
    y: 0,
    animationFrame: 0,
    arcClockwise: false,
    indexInSwarm: 0,
    animFrameStartCode: 0,
    tempCounter1: 0,
    tempCounter2: 0,
    dyingCounter: 0,
    dyingAnimFrame: 0,
    pointSprite: 0,
    arcTableLsb: 0,
    colour: 0,
    sortieCount: 0,
    speed: 1,
    pivotYValue: 0,
    yaddH: 0,
    yaddL: 0,
    yaddD: 0,
    yaddE: 0,
  };
}

const byte = (v: number) => v & 0xff;
/** Interpret a byte as signed. */
const signed = (v: number) => ((v & 0xff) ^ 0x80) - 0x80;

export interface InflightEvents {
  /** An alien has begun its dive (the attack scream starts). */
  onDiveStart?: () => void;
  /** An alien rejoined the swarm or escaped (the scream stops if last). */
  onDiveEnd?: () => void;
  /** A diving alien wants to drop a bomb. */
  onShoot?: (alien: InflightAlien) => void;
  /** A fleeing flagship escaped off the bottom with no escorts. */
  onFlagshipEscape?: () => void;
}

export class InflightAliens {
  readonly slots: InflightAlien[] = Array.from({ length: INFLIGHT_SLOTS }, emptyAlien);

  /** DIFFICULTY_BASE_VALUE ($421B) and DIFFICULTY_EXTRA_VALUE ($421A). */
  difficultyBase = 1;
  difficultyExtra = 0;

  /** HAVE_AGGRESSIVE_ALIENS ($4224). */
  aggressive = false;

  events: InflightEvents = {};

  /** INFLIGHT_ALIEN_SHOOT_EXACT_X / _RANGE_MUL ($4213/$4214). */
  private shootExactX = 0x9d;
  private shootRangeMul = 2;

  reset(): void {
    for (let i = 0; i < INFLIGHT_SLOTS; i++) this.slots[i] = emptyAlien();
    this.aggressive = false;
  }

  get inFlightCount(): number {
    let n = 0;
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      if (this.slots[i]!.isActive || this.slots[i]!.isDying) n++;
    }
    return n;
  }

  /**
   * HANDLE_CALC_INFLIGHT_ALIEN_SHOOTING_DISTANCE ($15F4): aliens can open fire
   * from higher up as pairs of formation rows empty out.
   */
  updateShootingDistance(swarm: Swarm): void {
    let mul = 2;
    const rows = SWARM_LAYOUT.slice().reverse(); // bottom row first
    for (let pair = 0; pair < 4; pair++) {
      const a = rows[pair * 2];
      const b = rows[pair * 2 + 1];
      const occupied = (r?: (typeof rows)[number]) =>
        !!r && r.columns.some((c) => swarm.flags[swarmIndex(r.row, c)]);
      if (occupied(a) || occupied(b)) break;
      mul++;
    }
    this.shootExactX = 0x9d;
    this.shootRangeMul = mul;
  }

  /**
   * HANDLE_SINGLE_ALIEN_ATTACK ($134C): how many of the four attacker slots
   * are scanned -- `min(3, (base + extra)/2) + 1`.
   */
  get activeAttackerSlots(): number {
    return Math.min(3, (this.difficultyBase + this.difficultyExtra) >> 1) + 1;
  }

  /**
   * Launch a lone attacker (blue/purple, or red when no flagship is up).
   * TRY_INIT_INFLIGHT_ALIEN scans slots 7 down to the difficulty limit.
   */
  launchAttacker(swarm: Swarm, fromRightFlank: boolean): boolean {
    const lowest = INFLIGHT_SLOTS - this.activeAttackerSlots;
    let slot = -1;
    for (let i = INFLIGHT_SLOTS - 1; i >= lowest; i--) {
      if (!this.slots[i]!.isActive && !this.slots[i]!.isDying) {
        slot = i;
        break;
      }
    }
    if (slot < 0) return false;

    // Pick the outermost alien on the chosen flank, scanning the blue and
    // purple rows bottom-up the way the original's flank scan does.
    const candidate = this.findFlankAlien(swarm, fromRightFlank);
    if (!candidate) return false;

    this.initInflight(slot, swarm, candidate.row, candidate.col, fromRightFlank);
    return true;
  }

  /**
   * HANDLE_FLAGSHIP_ATTACK ($140C): a flagship from the chosen flank with up
   * to two red escorts; failing a flagship, a single red alien.
   */
  launchFlagshipOrRed(swarm: Swarm, fromRightFlank: boolean): boolean {
    const slotBusy = this.slots[SLOT_FLAGSHIP]!.isActive || this.slots[SLOT_FLAGSHIP]!.isDying;
    if (slotBusy) return false;

    const flagRow = SWARM_LAYOUT[0]!;
    const cols = fromRightFlank ? [...flagRow.columns].reverse() : flagRow.columns;
    for (const col of cols) {
      if (!swarm.flags[swarmIndex(7, col)]) continue;
      this.initInflight(SLOT_FLAGSHIP, swarm, 7, col, fromRightFlank);
      this.launchEscorts(swarm, col, fromRightFlank);
      return true;
    }

    // No flagship: send one red alien from the flank instead.
    const redRow = SWARM_LAYOUT[1]!;
    const redCols = fromRightFlank ? [...redRow.columns].reverse() : redRow.columns;
    for (const col of redCols.slice(0, 4)) {
      if (!swarm.flags[swarmIndex(6, col)]) continue;
      return this.launchLoneRed(swarm, col, fromRightFlank);
    }
    return false;
  }

  private launchLoneRed(swarm: Swarm, col: number, clockwise: boolean): boolean {
    const lowest = INFLIGHT_SLOTS - this.activeAttackerSlots;
    for (let i = INFLIGHT_SLOTS - 1; i >= lowest; i--) {
      if (!this.slots[i]!.isActive && !this.slots[i]!.isDying) {
        this.initInflight(i, swarm, 6, col, clockwise);
        return true;
      }
    }
    return false;
  }

  /** "We only want 2 red aliens as an escort" ($1483). */
  private launchEscorts(swarm: Swarm, flagCol: number, clockwise: boolean): void {
    const redRow = SWARM_LAYOUT[1]!;
    // Prefer the red aliens closest to the flagship's column.
    const nearby = [...redRow.columns].sort(
      (a, b) => Math.abs(a - flagCol) - Math.abs(b - flagCol),
    );
    let placed = 0;
    for (const col of nearby) {
      if (placed >= 2) break;
      if (!swarm.flags[swarmIndex(6, col)]) continue;
      const slot = SLOT_ESCORT_FIRST + placed;
      if (this.slots[slot]!.isActive || this.slots[slot]!.isDying) break;
      this.initInflight(slot, swarm, 6, col, clockwise);
      placed++;
    }
  }

  private findFlankAlien(
    swarm: Swarm,
    fromRight: boolean,
  ): { row: number; col: number } | null {
    // Scan the four lower rows (blue and purple), bottom-up, outermost column
    // of the chosen flank first.
    for (const row of [2, 3, 4, 5]) {
      const def = rowByIndex.get(row)!;
      const cols = fromRight ? [...def.columns].reverse() : def.columns;
      for (const col of cols) {
        if (swarm.flags[swarmIndex(row, col)]) return { row, col };
      }
    }
    return null;
  }

  /** INIT_INFLIGHT_ALIEN ($145C) + INFLIGHT_ALIEN_PACKS_BAGS ($0D22). */
  private initInflight(
    slot: number,
    swarm: Swarm,
    row: number,
    col: number,
    clockwise: boolean,
  ): void {
    swarm.remove(row, col);
    const def = rowByIndex.get(row)!;

    const alien = this.slots[slot]!;
    Object.assign(alien, emptyAlien());
    alien.isActive = true;
    alien.indexInSwarm = swarmIndex(row, col);
    alien.arcClockwise = clockwise;
    alien.colour = def.colorCode;
    alien.speed = def.speed;

    // SET_INFLIGHT_ALIEN_START_POSITION ($1147).
    alien.x = byte(rowAnchorX(row));
    alien.y = colAnchorY(col, swarm.scroll);

    alien.animFrameStartCode = row === 7 ? INFLIGHT_FLAGSHIP_OFFSET : 0;
    alien.tempCounter1 = 3;
    alien.tempCounter2 = 0x0c;
    alien.arcTableLsb = 0;
    alien.stageOfLife = Stage.FliesInArc;
    // Facing straight up: +12 anticlockwise, -12 ($F4) clockwise.
    alien.animationFrame = clockwise ? -0x0c : 0x0c;

    this.events.onDiveStart?.();
  }

  /** Advance every slot by one frame. */
  update(frame: number, playerY: number, playerSpawned: boolean, flagshipHit: boolean, swarm: Swarm): void {
    this.updateShootingDistance(swarm);
    // Slot 0 is the scratch explosion for a shot swarm alien ($0B52); it
    // runs the same dying countdown but never was a dive, so no dive-end.
    const scratch = this.slots[0]!;
    if (scratch.isDying) {
      if (--scratch.dyingCounter > 0) {
        scratch.dyingAnimFrame = scratch.dyingCounter < 8 ? 1 : 0;
      } else {
        scratch.isDying = false;
      }
    }
    for (let i = 1; i < INFLIGHT_SLOTS; i++) {
      const alien = this.slots[i]!;
      if (alien.isDying) {
        this.updateDying(alien);
        continue;
      }
      if (!alien.isActive) continue;
      switch (alien.stageOfLife) {
        case Stage.FliesInArc:
        case Stage.CompleteLoop:
          this.fliesInArc(alien);
          break;
        case Stage.ReadyToAttack:
          this.readyToAttack(alien, playerY);
          break;
        case Stage.AttackingPlayer:
          this.attacking(alien, frame, playerY, playerSpawned, flagshipHit, false);
          break;
        case Stage.NearBottomOfScreen:
          this.nearBottom(alien, frame);
          break;
        case Stage.ReachedBottomOfScreen:
          this.reachedBottom(alien, playerSpawned, swarm);
          break;
        case Stage.ReturningToSwarm:
          this.returning(alien, swarm);
          break;
        case Stage.ContinuingFromTop:
          this.continuingFromTop(alien, playerY);
          break;
        case Stage.FullSpeedCharge:
          this.fullSpeedCharge(alien, playerY);
          break;
        case Stage.AttackingAggressively:
          this.attacking(alien, frame, playerY, playerSpawned, flagshipHit, true);
          break;
        case Stage.LoopTheLoop:
          this.loopTheLoop(alien);
          break;
        case Stage.AfterLoop:
          this.readyToAttack(alien, playerY);
          break;
        default:
          alien.isActive = false;
          break;
      }
    }
  }

  /**
   * Kill an in-flight alien: it plays the two-frame explosion, then (for a
   * flagship) freezes as its points-value sprite for a while.
   *
   * @param pointSprite $20-$23 (the "150".."800" sprites) to show after the
   *   explosion, or 0 for a rank-and-file alien that simply vanishes.
   */
  kill(slot: number, pointSprite = 0): void {
    const alien = this.slots[slot]!;
    alien.isActive = false;
    alien.isDying = true;
    // Explosion: two frames, 8 game-frames each (TempCounter1 = 4 at 60 Hz).
    alien.dyingCounter = 16;
    alien.dyingAnimFrame = 0;
    alien.pointSprite = pointSprite;
  }

  private updateDying(alien: InflightAlien): void {
    if (--alien.dyingCounter > 0) {
      // Advance the explosion animation across its two frames.
      if (alien.pointSprite === 0) {
        alien.dyingAnimFrame = alien.dyingCounter < 8 ? 1 : 0;
      }
      return;
    }
    // Explosion finished. A flagship now shows its points value ($112D:
    // DISPLAY_FLAGSHIP_POINTS_VALUE holds it for $32 = 50 frames).
    if (alien.pointSprite !== 0 && alien.dyingAnimFrame !== 2) {
      alien.dyingAnimFrame = 2; // 2 marks "showing points"
      alien.dyingCounter = 50;
      return;
    }
    alien.isDying = false;
    alien.pointSprite = 0;
    this.events.onDiveEnd?.();
  }

  /**
   * INFLIGHT_ALIEN_FLIES_IN_ARC ($0D71). Consumes two table bytes per frame;
   * the rotation frame steps every fourth frame, twelve times.
   */
  private fliesInArc(alien: InflightAlien): void {
    const step = ARC_TABLE[alien.arcTableLsb >> 1];
    if (step) {
      alien.x = byte(alien.x + step.dx);
      alien.y = byte(alien.y + (alien.arcClockwise ? -step.dy : step.dy));

      // $0D8B: wandered off the side -- come back from the top instead.
      if (byte(alien.y + 7) < 0x0e) {
        alien.stageOfLife = Stage.ReachedBottomOfScreen;
        return;
      }
      alien.arcTableLsb = byte(alien.arcTableLsb + 2);
    }

    if (--alien.tempCounter1 > 0) return;
    alien.tempCounter1 = 4;
    alien.animationFrame = signed(alien.animationFrame + (alien.arcClockwise ? 1 : -1));
    if (--alien.tempCounter2 > 0) return;
    alien.stageOfLife =
      alien.stageOfLife === Stage.CompleteLoop ? Stage.AfterLoop : Stage.ReadyToAttack;
  }

  /**
   * INFLIGHT_ALIEN_READY_TO_ATTACK ($0DD1) / DEFINE_FLIGHTPATH ($0DDD).
   *
   * The dive amplitude is set here, once: half the horizontal distance to the
   * player plus a bias, clamped to 48..112 pixels, signed toward the player.
   * Escorted reds copy the flagship's amplitude so the convoy weaves together.
   */
  private readyToAttack(alien: InflightAlien, playerY: number): void {
    alien.x = byte(alien.x + 1);

    const row = alien.indexInSwarm & 0x70;
    const flagship = this.slots[SLOT_FLAGSHIP]!;
    if (row === 0x60 && flagship.isActive) {
      alien.yaddH = flagship.yaddH;
    } else {
      const diff = signed(alien.y - playerY);
      let addl: number;
      if (diff >= 0) {
        addl = Math.min(0x70, Math.max(0x30, (diff >> 1) + 0x10));
      } else {
        addl = Math.max(-0x70, Math.min(-0x30, ((diff / 2) | 0) - 0x10));
      }
      alien.yaddH = addl & 0xff;
    }
    alien.pivotYValue = byte(alien.y - alien.yaddH);
    alien.yaddL = 0;
    alien.yaddD = 0;
    alien.yaddE = 0;
    alien.stageOfLife =
      alien.stageOfLife === Stage.AfterLoop ? Stage.AttackingAggressively : Stage.AttackingPlayer;
  }

  /**
   * UPDATE_INFLIGHT_ALIEN_YADD ($116B): the oscillator, byte-exact.
   *
   * H += 2L/256 and L -= 2H/256 with carry propagation through the fraction
   * bytes, iterated Speed+1 times. The $80 comparisons stop either byte from
   * flipping sign by overflow.
   */
  private updateYadd(alien: InflightAlien): void {
    let h = alien.yaddH & 0xff;
    let l = alien.yaddL & 0xff;
    let d = alien.yaddD & 0xff;
    let e = alien.yaddE & 0xff;
    const iterations = (alien.speed & 3) + 1;

    for (let i = 0; i < iterations; i++) {
      // Part 1: H += (2L + D) carry, sign-extended.
      let c = h;
      let a = l;
      const carryAA = (a & 0x80) !== 0;
      a = byte(a << 1);
      if (carryAA) h = byte(h - 1);
      const sum = a + d;
      d = byte(sum);
      let hNew = byte((sum > 0xff ? 1 : 0) + h);
      if (hNew === 0x80) hNew = c;
      h = hNew;

      // Part 2: L += (2*(-H) + E) carry, sign-extended.
      c = l;
      a = byte(-h);
      const carryAA2 = (a & 0x80) !== 0;
      a = byte(a << 1);
      if (carryAA2) l = byte(l - 1);
      const sum2 = a + e;
      e = byte(sum2);
      let lNew = byte((sum2 > 0xff ? 1 : 0) + l);
      if (lNew === 0x80) lNew = c;
      l = lNew;
    }

    alien.yaddH = h;
    alien.yaddL = l;
    alien.yaddD = d;
    alien.yaddE = e;
  }

  /**
   * INFLIGHT_ALIEN_ATTACKING_PLAYER ($0E29) and
   * INFLIGHT_ALIEN_ATTACKING_PLAYER_AGGRESSIVELY ($0FB2).
   */
  private attacking(
    alien: InflightAlien,
    frame: number,
    playerY: number,
    playerSpawned: boolean,
    flagshipHit: boolean,
    aggressive: boolean,
  ): void {
    alien.x = byte(alien.x + 1);
    this.updateYadd(alien);

    if (aggressive && alien.sortieCount >= 4) {
      // $100B: after four sorties the alien hugs the player's column.
      if (alien.sortieCount > 4 || (frame & 1) !== 0) {
        alien.pivotYValue = byte(playerY - alien.yaddH);
      }
    }

    alien.y = byte(alien.pivotYValue + alien.yaddH);

    // Off the side of the screen?
    if (byte(alien.y + 7) < 0x0e) {
      alien.stageOfLife = Stage.ReachedBottomOfScreen;
      return;
    }
    // Nearing the bottom? ($0E3E: X + $48 carries; aggressive: X + $40)
    if (alien.x + (aggressive ? 0x40 : 0x48) > 0xff) {
      alien.stageOfLife = Stage.NearBottomOfScreen;
      return;
    }

    if (aggressive) {
      if (--alien.tempCounter1 === 0) {
        alien.stageOfLife = Stage.FullSpeedCharge;
        return;
      }
    }

    if (!playerSpawned) return;
    this.lookAtPlayer(alien, playerY);
    if (flagshipHit) return;
    this.maybeShoot(alien);
  }

  /**
   * CALCULATE_INFLIGHT_ALIEN_LOOKAT_ANIM_FRAME ($11B0): heading from the
   * binary-division tangent of (distance to player's row, horizontal offset).
   */
  private lookAtPlayer(alien: InflightAlien, playerY: number): void {
    const distance = byte(0xf0 - alien.x);
    const diff = signed(playerY - alien.y);
    const t = calculateTangent(Math.abs(diff), distance);
    const frameMag = t >= 0x80 ? 4 : (t >> 5) & 7;
    alien.animationFrame = diff >= 0 ? frameMag : -frameMag;
  }

  /**
   * The firing gate at $0E54: an alien may only drop a bomb at fixed
   * altitudes -- X = EXACT - $19*k for k < RANGE_MUL. More formation rows
   * empty means more altitudes, so the survivors shoot more.
   */
  private maybeShoot(alien: InflightAlien): void {
    let x = alien.x;
    for (let k = 0; k < this.shootRangeMul; k++) {
      if (x === this.shootExactX) {
        this.events.onShoot?.(alien);
        return;
      }
      x = byte(x + 0x19);
    }
  }

  /** INFLIGHT_ALIEN_NEAR_BOTTOM_OF_SCREEN ($0E6B): 1 or 2 pixels per frame. */
  private nearBottom(alien: InflightAlien, frame: number): void {
    alien.x = byte(alien.x + (frame & 1) + 1);
    if (byte(alien.x - 6) < 3) {
      alien.stageOfLife = Stage.ReachedBottomOfScreen;
      return;
    }
    this.updateYadd(alien);
    const y = byte(alien.pivotYValue + alien.yaddH);
    // Going off the side also ends the pass.
    if (byte(y + 7) < 0x0e) {
      alien.stageOfLife = Stage.ReachedBottomOfScreen;
      return;
    }
    alien.y = y;
  }

  /** INFLIGHT_ALIEN_REACHED_BOTTOM_OF_SCREEN ($0E9D). */
  private reachedBottom(alien: InflightAlien, playerSpawned: boolean, swarm: Swarm): void {
    alien.x = 0x08;
    alien.sortieCount++;
    alien.animationFrame = 0;

    const row = alien.indexInSwarm & 0x70;
    if (row === 0x70) {
      // Flagship: no escorts left means it escapes the stage entirely.
      const escorts =
        (this.slots[2]!.isActive ? 1 : 0) + (this.slots[3]!.isActive ? 1 : 0);
      if (escorts === 0) {
        alien.isActive = false;
        this.events.onDiveEnd?.();
        this.events.onFlagshipEscape?.();
        return;
      }
    }

    if (!playerSpawned) {
      alien.stageOfLife = Stage.ReturningToSwarm;
      return;
    }
    if (this.aggressive || !swarm.hasBlueOrPurple) {
      // $0EBF: reappear somewhere unpredictable and keep attacking.
      alien.y = byte((alien.y >> 1) + Math.floor(Math.random() * 32) + 0x20);
      alien.tempCounter1 = 0x28;
      alien.stageOfLife = Stage.ContinuingFromTop;
    } else {
      alien.stageOfLife = Stage.ReturningToSwarm;
    }
  }

  /** INFLIGHT_ALIEN_RETURNING_TO_SWARM ($0F07). */
  private returning(alien: InflightAlien, swarm: Swarm): void {
    const targetX = byte(rowAnchorX((alien.indexInSwarm >> 4) & 7));
    const targetY = colAnchorY(alien.indexInSwarm & 0x0f, swarm.scroll);

    alien.x = byte(alien.x + 1);
    alien.y = targetY; // slides with the swarm as it sweeps

    const dist = byte(targetX - alien.x);
    if (dist === 0) {
      // INFLIGHT_ALIEN_BACK_IN_SWARM: become tiles again.
      alien.isActive = false;
      swarm.add((alien.indexInSwarm >> 4) & 7, alien.indexInSwarm & 0x0f);
      this.events.onDiveEnd?.();
      return;
    }
    if (dist < 0x19 && (dist & 1) === 0) {
      // Rotate back to the bat-hang orientation on the way in.
      alien.animationFrame = signed(alien.animationFrame + (alien.arcClockwise ? -1 : 1));
    }
  }

  /**
   * INFLIGHT_ALIEN_CONTINUING_ATTACK_RUN_FROM_TOP_OF_SCREEN ($0F32): the
   * pivot slides toward the player at twice the offset per frame, in 16-bit
   * fixed point with Y as the high byte.
   */
  private continuingFromTop(alien: InflightAlien, playerY: number): void {
    alien.x = byte(alien.x + 1);
    const diff = signed(playerY - alien.y);
    let hl = ((alien.y << 8) | alien.pivotYValue) - 2 * -diff;
    hl &= 0xffff;
    alien.pivotYValue = hl & 0xff;
    alien.y = (hl >> 8) & 0xff;
    if (--alien.tempCounter1 === 0) {
      alien.stageOfLife = Stage.FullSpeedCharge;
    }
  }

  /** INFLIGHT_ALIEN_FULL_SPEED_CHARGE ($0F5F). */
  private fullSpeedCharge(alien: InflightAlien, playerY: number): void {
    alien.x = byte(alien.x + 1);

    const centreX = byte(alien.x - 0x60) < 0x40;
    const centreY = byte(alien.y - 0x60) < 0x40;
    if (centreX && centreY) {
      // Loop the loop to taunt the player ($0F87).
      alien.stageOfLife = Stage.LoopTheLoop;
      alien.tempCounter1 = 3;
      alien.tempCounter2 = 0x0c;
      alien.animationFrame = 0;
      alien.arcTableLsb = 0;
      alien.arcClockwise = signed(playerY - alien.y) < 0;
      return;
    }

    // Otherwise veer at the player, at full speed ($0F7B).
    const diff = signed(alien.y - playerY);
    let addl: number;
    if (diff >= 0) {
      addl = Math.min(0x70, Math.max(0x30, (diff >> 1) + 0x10));
    } else {
      addl = Math.max(-0x70, Math.min(-0x30, ((diff / 2) | 0) - 0x10));
    }
    alien.yaddH = addl & 0xff;
    alien.pivotYValue = byte(alien.y - alien.yaddH);
    alien.yaddL = 0;
    alien.yaddD = 0;
    alien.yaddE = 0;
    alien.speed = 3;
    alien.tempCounter1 = 0x64;
    alien.stageOfLife = Stage.AttackingAggressively;
  }

  /**
   * Write the slots into the hardware sprite records at $5840.
   *
   * The Y register byte is the *complement* of the coordinate ($0C38 does
   * `cpl; sub c` before storing), which is what makes a sprite land on the
   * same scanlines as a tile at the same game coordinate.
   */
  writeSprites(objram: Uint8Array, spriteBase: number): void {
    for (let slot = 0; slot < INFLIGHT_SLOTS; slot++) {
      const alien = this.slots[slot]!;
      const base = spriteBase + slot * 4;
      if (alien.isDying) {
        // dyingAnimFrame 0/1 = the two explosion frames; 2 = points value.
        const showingPoints = alien.dyingAnimFrame === 2;
        objram[base] = byte(~alien.y - 8);
        objram[base + 1] = showingPoints
          ? alien.pointSprite
          : ALIEN_EXPLOSION_SPRITE + (alien.dyingAnimFrame & 1);
        objram[base + 2] = showingPoints ? COLOR_CODE_TEXT_WHITE : COLOR_CODE_EXPLOSION;
        objram[base + 3] = byte(alien.x - 8);
        continue;
      }
      if (!alien.isActive) {
        objram[base] = 0;
        objram[base + 1] = 0;
        objram[base + 2] = 0;
        objram[base + 3] = 0;
        continue;
      }
      const { code, flipX, flipY } = spriteForHeading(
        alien.animationFrame,
        alien.animFrameStartCode,
      );
      objram[base] = byte(~alien.y - 8);
      objram[base + 1] = (code & 0x3f) | (flipX ? 0x40 : 0) | (flipY ? 0x80 : 0);
      objram[base + 2] = alien.colour & 7;
      objram[base + 3] = byte(alien.x - 8);
    }
  }

  /** INFLIGHT_ALIEN_LOOP_THE_LOOP ($101F): the arc with the X delta negated. */
  private loopTheLoop(alien: InflightAlien): void {
    const step = ARC_TABLE[alien.arcTableLsb >> 1];
    if (step) {
      alien.x = byte(alien.x - step.dx);
      alien.y = byte(alien.y + (alien.arcClockwise ? step.dy : -step.dy));
      alien.arcTableLsb = byte(alien.arcTableLsb + 2);
    }

    if (--alien.tempCounter1 > 0) return;
    alien.tempCounter1 = 4;
    alien.animationFrame = signed(alien.animationFrame + (alien.arcClockwise ? 1 : -1));
    if (--alien.tempCounter2 > 0) return;

    // $104C: hand the last quarter back to the arc routine.
    alien.stageOfLife = Stage.CompleteLoop;
    alien.tempCounter1 = 3;
    alien.tempCounter2 = 0x0c;
    alien.animationFrame = 0x0c;
    alien.arcTableLsb = 0;
  }
}
