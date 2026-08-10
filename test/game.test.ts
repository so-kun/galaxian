import { describe, it, expect } from 'vitest';
import { buildArcTable, ARC_RADIUS, ARC_STEPS, spriteForHeading, calculateTangent } from '../src/game/arc';
import { InflightAliens, Stage, INFLIGHT_SLOTS, SLOT_SCRATCH, SLOT_FLAGSHIP } from '../src/game/inflight';
import { Swarm } from '../src/game/swarm';
import { Game } from '../src/game/game';
import type { InputState } from '../src/input';

const IDLE: InputState = { left: false, right: false, fire: false, start: false, start2: false, coin: false };

describe('dive arc table', () => {
  const arc = buildArcTable();

  it('has the 51 steps the original table holds', () => {
    expect(arc.length).toBe(ARC_STEPS);
  });

  it('traces a semicircle of radius 16', () => {
    let x = 0;
    let y = 0;
    let maxDeviation = 0;
    for (const step of arc) {
      x += step.dx;
      y += step.dy;
      const deviation = Math.abs(Math.hypot(x, y - ARC_RADIUS) - ARC_RADIUS);
      maxDeviation = Math.max(maxDeviation, deviation);
    }
    expect(maxDeviation).toBeLessThan(0.5);
    expect(y).toBe(2 * ARC_RADIUS);
    expect(Math.abs(x)).toBeLessThanOrEqual(1);
  });

  it('builds its second half by rotating the first quarter 90 degrees', () => {
    for (let i = 0; i < 25; i++) {
      expect(arc[25 + i]).toEqual({ dx: arc[i]!.dy, dy: -arc[i]!.dx });
    }
  });
});

describe('CALCULATE_TANGENT', () => {
  it('is the restoring binary division of the original', () => {
    // Dividing zero: only the trailing d=0 rounds emit a bit, exactly as the
    // original's restoring division does.
    expect(calculateTangent(0, 100)).toBe(1);
    // equal inputs saturate the leading bits
    expect(calculateTangent(100, 100)).toBeGreaterThanOrEqual(0x80);
    // a small offset over a large distance stays small
    expect(calculateTangent(10, 200)).toBeLessThan(0x20);
  });
});

describe('heading to sprite code', () => {
  it('covers all 24 headings using 7 frames plus the flip bits', () => {
    const codes = new Set<number>();
    const combos = new Set<string>();
    for (let h = -12; h < 12; h++) {
      const s = spriteForHeading(h, 0);
      codes.add(s.code);
      combos.add(`${s.code}:${s.flipX}:${s.flipY}`);
      // The rotation frames live at $11-$17; nothing else may be selected.
      expect(s.code).toBeGreaterThanOrEqual(0x11);
      expect(s.code).toBeLessThanOrEqual(0x17);
    }
    expect(codes.size).toBe(7);
    expect(combos.size).toBe(24);
  });

  it('offsets the flagship by AnimFrameStartCode', () => {
    for (let h = -12; h < 12; h++) {
      expect(spriteForHeading(h, 0x18).code).toBe(spriteForHeading(h, 0).code + 0x18);
    }
  });

  it('wraps headings outside the -12..11 range', () => {
    expect(spriteForHeading(12, 0)).toEqual(spriteForHeading(-12, 0));
    expect(spriteForHeading(-13, 0)).toEqual(spriteForHeading(11, 0));
  });
});

describe('the YADD oscillator', () => {
  it('makes a diving alien weave: Y oscillates about the pivot', () => {
    const inflight = new InflightAliens();
    const swarm = new Swarm();
    swarm.reset();
    inflight.launchFlagshipOrRed(swarm, false);
    const alien = inflight.slots[SLOT_FLAGSHIP]!;
    expect(alien.isActive).toBe(true);

    // Fly the arc, then dive for a while, tracking the weave.
    const ys: number[] = [];
    for (let frame = 0; frame < 900; frame++) {
      inflight.update(frame, 0x80, true, false, swarm);
      if (alien.stageOfLife === Stage.AttackingPlayer) ys.push(((alien.y & 0xff) ^ 0x80) - 0x80);
      if (!alien.isActive) break;
    }
    expect(ys.length).toBeGreaterThan(60);
    // The weave must actually change direction, not drift monotonically.
    let turns = 0;
    for (let i = 2; i < ys.length; i++) {
      const d1 = ys[i - 1]! - ys[i - 2]!;
      const d2 = ys[i]! - ys[i - 1]!;
      if (d1 !== 0 && d2 !== 0 && Math.sign(d1) !== Math.sign(d2)) turns++;
    }
    expect(turns).toBeGreaterThan(0);
  });
});

describe('slot allocation', () => {
  it('scales lone attackers from 1 to 4 with difficulty', () => {
    const inflight = new InflightAliens();
    const seen = new Set<number>();
    for (let base = 0; base <= 7; base++) {
      for (let extra = 0; extra <= 7; extra++) {
        inflight.difficultyBase = base;
        inflight.difficultyExtra = extra;
        seen.add(inflight.activeAttackerSlots);
      }
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('never launches into the scratch slot, so at most 7 fly', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    inflight.difficultyBase = 7;
    inflight.difficultyExtra = 7;
    for (let i = 0; i < 40; i++) {
      inflight.launchAttacker(swarm, i % 2 === 0);
      inflight.launchFlagshipOrRed(swarm, i % 2 === 0);
    }
    expect(inflight.slots[SLOT_SCRATCH]!.isActive).toBe(false);
    expect(inflight.inFlightCount).toBeLessThanOrEqual(INFLIGHT_SLOTS - 1);
  });

  it('sends at most two escorts with the flagship', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    inflight.launchFlagshipOrRed(swarm, false);
    expect(inflight.slots[SLOT_FLAGSHIP]!.isActive).toBe(true);
    const escorts = [2, 3].filter((s) => inflight.slots[s]!.isActive);
    expect(escorts.length).toBe(2);
    // Escorts come from the red row.
    for (const s of escorts) {
      expect((inflight.slots[s]!.indexInSwarm & 0x70)).toBe(0x60);
    }
  });

  it('starts a dive facing straight up, from the formation anchor', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    inflight.launchAttacker(swarm, false);
    const alien = inflight.slots.find((a) => a.isActive)!;
    expect(Math.abs(alien.animationFrame)).toBe(12);
    expect(alien.stageOfLife).toBe(Stage.FliesInArc);
    // Blue rows have colour code 4 and speed 1 or 2 (ALIEN_PARAMS_TABLE).
    expect(alien.colour).toBe(4);
    expect([1, 2]).toContain(alien.speed);
  });
});

describe('a running game', () => {
  it('launches aliens that fly the arc and then attack', () => {
    const game = new Game();
    const stages = new Set<Stage>();
    let sawInFlight = false;
    for (let frame = 0; frame < 5000; frame++) {
      game.step(IDLE);
      for (let s = 1; s < INFLIGHT_SLOTS; s++) {
        const alien = game.inflight.slots[s]!;
        if (alien.isActive) {
          sawInFlight = true;
          stages.add(alien.stageOfLife);
        }
      }
    }
    expect(sawInFlight).toBe(true);
    expect(stages.has(Stage.FliesInArc)).toBe(true);
    expect(stages.has(Stage.AttackingPlayer)).toBe(true);
  });

  it('moves the player within the PLAYER_Y limits', () => {
    // Short bursts, before any enemy fire can reach the ship.
    const game = new Game();
    for (let i = 0; i < 130; i++) game.step({ ...IDLE, left: true });
    expect(game.playerY).toBe(0xe9);
    const game2 = new Game();
    for (let i = 0; i < 130; i++) game2.step({ ...IDLE, right: true });
    expect(game2.playerY).toBe(0x17);
  });

  it('fires one shot at a time, needing a button release between shots', () => {
    const game = new Game();
    const objram = new Uint8Array(0x100);
    const videoram = new Uint8Array(0x400);
    let framesWithShot = 0;
    for (let i = 0; i < 200; i++) {
      game.step({ ...IDLE, fire: true });
      game.render(videoram, objram);
      if (objram[0x60 + 7 * 4 + 1] !== 0) framesWithShot++;
    }
    expect(framesWithShot).toBeGreaterThan(0);
    expect(framesWithShot).toBeLessThan(200);
  });

  it('scores when the sweep carries aliens into the line of fire', () => {
    const game = new Game();
    for (let frame = 0; frame < 60000 && game.score === 0; frame++) {
      game.step({ ...IDLE, fire: frame % 2 === 0, left: frame % 256 < 128, right: frame % 256 >= 128 });
    }
    expect(game.score).toBeGreaterThan(0);
  });

  it('survives a long unattended session without leaving the byte domain', () => {
    const game = new Game();
    for (let frame = 0; frame < 20000; frame++) {
      game.step(IDLE);
      for (let s = 0; s < INFLIGHT_SLOTS; s++) {
        const a = game.inflight.slots[s]!;
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x).toBeLessThanOrEqual(255);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('difficulty progression', () => {
  it('raises DIFFICULTY_BASE by one per stage, capped at 7', () => {
    const game = new Game();
    expect(game.inflight.difficultyBase).toBe(1);
    // Clear stages by wiping the swarm directly and letting checkStageComplete fire.
    for (let stage = 1; stage <= 10; stage++) {
      game.swarm.flags.fill(0);
      game.inflight.reset();
      game.step(IDLE);
    }
    expect(game.inflight.difficultyBase).toBe(7);
  });

  it('resets DIFFICULTY_EXTRA to 0 at the start of each stage', () => {
    const game = new Game();
    // Let some stage time pass so extra climbs.
    for (let f = 0; f < 0x3c * 0x14 + 5; f++) game.step(IDLE);
    expect(game.inflight.difficultyExtra).toBeGreaterThanOrEqual(1);
    game.swarm.flags.fill(0);
    game.inflight.reset();
    game.step(IDLE);
    expect(game.inflight.difficultyExtra).toBe(0);
  });
})
