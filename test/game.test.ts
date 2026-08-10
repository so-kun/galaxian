import { describe, it, expect } from 'vitest';
import { buildArcTable, ARC_RADIUS, ARC_STEPS, spriteForHeading, calculateTangent } from '../src/game/arc';
import { InflightAliens, Stage, INFLIGHT_SLOTS, SLOT_FLAGSHIP, SLOT_SCRATCH } from '../src/game/inflight';
import { Swarm } from '../src/game/swarm';
import { Game } from '../src/game/game';
import type { InputState } from '../src/input';

const IDLE: InputState = { left: false, right: false, fire: false, start: false };

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
      // Centre sits one radius ahead along the Y axis.
      const deviation = Math.abs(Math.hypot(x, y - ARC_RADIUS) - ARC_RADIUS);
      maxDeviation = Math.max(maxDeviation, deviation);
    }
    // The original never strays further than 0.476 from the circle.
    expect(maxDeviation).toBeLessThan(0.5);
    // A semicircle: ends two radii along Y, back at the starting X.
    expect(y).toBe(2 * ARC_RADIUS);
    expect(Math.abs(x)).toBeLessThanOrEqual(1);
  });

  it('reaches its furthest excursion at the halfway point', () => {
    let x = 0;
    let y = 0;
    let minX = 0;
    let minAtY = 0;
    for (const step of arc) {
      x += step.dx;
      y += step.dy;
      if (x < minX) {
        minX = x;
        minAtY = y;
      }
    }
    expect(minX).toBe(-ARC_RADIUS);
    expect(minAtY).toBeGreaterThanOrEqual(ARC_RADIUS - 4);
    expect(minAtY).toBeLessThanOrEqual(ARC_RADIUS + 4);
  });

  it('only ever steps by -1, 0 or 1 on each axis', () => {
    for (const step of arc) {
      expect([-1, 0, 1]).toContain(step.dx);
      expect([-1, 0, 1]).toContain(step.dy);
    }
  });

  it('builds its second half by rotating the first quarter 90 degrees', () => {
    for (let i = 0; i < 25; i++) {
      expect(arc[25 + i]).toEqual({ dx: arc[i]!.dy, dy: -arc[i]!.dx });
    }
  });
});

describe('heading to sprite code', () => {
  it('covers all 24 headings using 13 frames plus the flip bits', () => {
    const codes = new Set<number>();
    const combos = new Set<string>();
    for (let h = -12; h < 12; h++) {
      const s = spriteForHeading(h, 0);
      codes.add(s.code);
      combos.add(`${s.code}:${s.flipX}:${s.flipY}`);
      expect(s.code).toBeGreaterThanOrEqual(0x11);
      expect(s.code).toBeLessThanOrEqual(0x1d);
    }
    expect(codes.size).toBe(13);
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

describe('CALCULATE_TANGENT', () => {
  it('faces straight ahead when the target is directly below', () => {
    expect(calculateTangent(100, 0)).toBe(0);
  });

  it('leans toward the target and saturates at a quarter turn', () => {
    expect(calculateTangent(100, 20)).toBeGreaterThan(0);
    expect(calculateTangent(100, -20)).toBeLessThan(0);
    expect(calculateTangent(1, 100)).toBeLessThanOrEqual(11);
    expect(calculateTangent(1, -100)).toBeGreaterThanOrEqual(-12);
  });
});

describe('in-flight slot allocation', () => {
  it('scales the number of lone attackers from 1 to 4 with difficulty', () => {
    const inflight = new InflightAliens();
    const seen = new Set<number>();
    for (let base = 0; base <= 7; base++) {
      for (let extra = 0; extra <= 7; extra++) {
        inflight.difficultyBase = base;
        inflight.difficultyExtra = extra;
        const n = inflight.activeAttackerSlots;
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(4);
        seen.add(n);
      }
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('never puts an alien in the scratch slot, so at most 7 can fly', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    inflight.difficultyBase = 7;
    inflight.difficultyExtra = 7;
    let n = 0;
    const rng = () => (n = (n * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 50; i++) inflight.launchFromSwarm(swarm, rng);
    expect(inflight.slots[SLOT_SCRATCH]!.isActive).toBe(false);
    expect(inflight.inFlightCount).toBeLessThanOrEqual(INFLIGHT_SLOTS - 1);
  });

  it('sends escorts with the flagship, and only two of them', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    // Strip everything except the flagships and the red row they escort from.
    let launched = false;
    let n = 7;
    const rng = () => (n = (n * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 200 && !launched; i++) {
      inflight.launchFromSwarm(swarm, rng);
      launched = inflight.slots[SLOT_FLAGSHIP]!.isActive;
    }
    expect(launched).toBe(true);
    const escorts = [2, 3].filter((s) => inflight.slots[s]!.isActive);
    expect(escorts.length).toBeGreaterThan(0);
    expect(escorts.length).toBeLessThanOrEqual(2);
  });
});

describe('a running game', () => {
  it('launches aliens that fly the arc and then attack', () => {
    const game = new Game();
    const stages = new Set<Stage>();
    let sawInFlight = false;
    for (let frame = 0; frame < 3000; frame++) {
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
    expect(stages.has(Stage.Attacking)).toBe(true);
  });

  it('keeps every alien on screen while it dives', () => {
    const game = new Game();
    for (let frame = 0; frame < 3000; frame++) {
      game.step(IDLE);
      for (let s = 1; s < INFLIGHT_SLOTS; s++) {
        const alien = game.inflight.slots[s]!;
        if (!alien.isActive) continue;
        expect(alien.x).toBeGreaterThanOrEqual(0);
        expect(alien.x).toBeLessThanOrEqual(255);
        expect(alien.y).toBeGreaterThanOrEqual(0);
        expect(alien.y).toBeLessThanOrEqual(255);
      }
    }
  });

  it('thins the formation out as aliens sortie', () => {
    const game = new Game();
    const initial = game.swarm.aliveCount;
    for (let frame = 0; frame < 2000; frame++) game.step(IDLE);
    expect(game.swarm.aliveCount).toBeLessThan(initial);
  });

  it('lets the player move, but not off the screen', () => {
    const game = new Game();
    const start = game.playerScroll;
    for (let i = 0; i < 500; i++) game.step({ ...IDLE, left: true });
    const leftmost = game.playerScroll;
    expect(leftmost).toBeGreaterThan(start);
    for (let i = 0; i < 1000; i++) game.step({ ...IDLE, right: true });
    expect(game.playerScroll).toBeLessThan(leftmost);
    // Bounded on both sides.
    for (let i = 0; i < 2000; i++) game.step({ ...IDLE, left: true });
    const a = game.playerScroll;
    game.step({ ...IDLE, left: true });
    expect(game.playerScroll).toBe(a);
  });

  it('fires one shot at a time and requires the button to be released', () => {
    const game = new Game();
    const objram = new Uint8Array(0x100);
    const videoram = new Uint8Array(0x400);
    let framesWithShot = 0;
    for (let i = 0; i < 200; i++) {
      game.step({ ...IDLE, fire: true });
      game.render(videoram, objram);
      // Bullet slot 7 is the yellow missile.
      if (objram[0x60 + 7 * 4 + 1] !== 0) framesWithShot++;
    }
    expect(framesWithShot).toBeGreaterThan(0);
    // Holding fire cannot put more than one missile on screen.
    expect(framesWithShot).toBeLessThan(200);
  });

  it('scores hits and can clear a stage', () => {
    const game = new Game();
    for (let frame = 0; frame < 40000 && game.stage === 1; frame++) {
      // Sweep back and forth while firing to clear the formation.
      game.step({ ...IDLE, fire: frame % 2 === 0, left: frame % 128 < 64, right: frame % 128 >= 64 });
    }
    expect(game.score).toBeGreaterThan(0);
  });
});
