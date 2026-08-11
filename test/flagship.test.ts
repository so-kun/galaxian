import { describe, it, expect } from 'vitest';
import { InflightAliens, SLOT_FLAGSHIP, SLOT_ESCORT_FIRST } from '../src/game/inflight';
import { Swarm } from '../src/game/swarm';
import { Game, FLAGSHIP_SCORES, FLAGSHIP_POINT_SPRITE_BASE } from '../src/game/game';

/**
 * Fly a flagship convoy, optionally shooting the escorts down first, then
 * shoot the flagship and report what the kill was worth.
 */
function convoyKill(killEscorts: number): { score: number; sprite: number } {
  const game = new Game();
  const inflight = game.inflight;
  inflight.launchFlagshipOrRed(game.swarm, false);
  const flag = inflight.slots[SLOT_FLAGSHIP]!;
  expect(flag.isActive).toBe(true);

  for (let i = 0; i < killEscorts; i++) {
    const escort = inflight.slots[SLOT_ESCORT_FIRST + i]!;
    escort.isActive = false;
    escort.isDying = false;
  }

  // Park the player's bullet right on the flagship and let the game resolve it.
  const g = game as unknown as {
    bulletActive: boolean;
    bulletX: number;
    bulletY: number;
    playerBulletVsInflight(): void;
  };
  g.bulletActive = true;
  g.bulletX = flag.x;
  g.bulletY = flag.y;
  g.playerBulletVsInflight();

  return { score: game.score, sprite: flag.pointSprite };
}

describe('flagship points sprite', () => {
  it('plays explosion then freezes as the points value for 50 frames', () => {
    const inflight = new InflightAliens();
    const flag = inflight.slots[1]!;
    flag.isActive = true;
    // Kill it with the "800" points sprite ($23).
    inflight.kill(1, FLAGSHIP_POINT_SPRITE_BASE + 3);
    expect(flag.isDying).toBe(true);

    const objram = new Uint8Array(0x100);
    const codesSeen: number[] = [];
    for (let f = 0; f < 80 && flag.isDying; f++) {
      // drive the dying state machine
      inflight.update(f, 0x80, true, false, { flags: new Uint8Array(128) } as never);
      inflight.writeSprites(objram, 0x40);
      codesSeen.push(objram[0x40 + 1 * 4 + 1]!);
    }

    // The explosion sprites ($1E/$1F) appear first...
    expect(codesSeen.some((c) => c === 0x1e || c === 0x1f)).toBe(true);
    // ...then the "800" points sprite ($23) is held.
    const pointFrames = codesSeen.filter((c) => c === 0x23).length;
    expect(pointFrames).toBeGreaterThanOrEqual(40);
    // Eventually the slot frees up.
    expect(flag.isDying).toBe(false);
  });

  it('maps the four score factors to the right values and sprites', () => {
    expect(FLAGSHIP_SCORES).toEqual([150, 200, 300, 800]);
    // sprite $20 = 150, $21 = 200, $22 = 300, $23 = 800
    for (let factor = 0; factor < 4; factor++) {
      expect(FLAGSHIP_POINT_SPRITE_BASE + factor).toBe(0x20 + factor);
    }
  });
});

describe('convoy payout', () => {
  it('pays 300 for a two-escort convoy and 800 once both escorts are gone', () => {
    // Escorts still flying: FLAGSHIP_SCORE_FACTOR stays at the escort count.
    expect(convoyKill(0)).toEqual({ score: 300, sprite: 0x22 });
    // One escort left: still 300, not the full convoy bonus.
    expect(convoyKill(1)).toEqual({ score: 300, sprite: 0x22 });
    // Both escorts shot before the flagship: the $1292 promotion to 3.
    expect(convoyKill(2)).toEqual({ score: 800, sprite: 0x23 });
  });

  it('stays in range across repeated convoy sorties', () => {
    const game = new Game();
    const inflight = game.inflight;
    const g = game as unknown as {
      bulletActive: boolean;
      bulletX: number;
      bulletY: number;
      playerBulletVsInflight(): void;
    };

    // Three sorties, each with both escorts shot down first. The score factor
    // must never run past 3 -- it used to accumulate across sorties, indexing
    // off the end of FLAGSHIP_SCORES and poisoning the score with NaN.
    for (let sortie = 0; sortie < 3; sortie++) {
      inflight.reset();
      game.swarm.reset();
      inflight.launchFlagshipOrRed(game.swarm, false);
      inflight.slots[SLOT_ESCORT_FIRST]!.isActive = false;
      inflight.slots[SLOT_ESCORT_FIRST + 1]!.isActive = false;

      const flag = inflight.slots[SLOT_FLAGSHIP]!;
      g.bulletActive = true;
      g.bulletX = flag.x;
      g.bulletY = flag.y;
      g.playerBulletVsInflight();

      expect(flag.pointSprite).toBe(0x23);
      expect(Number.isFinite(game.score)).toBe(true);
    }
    expect(game.score).toBe(2400);
  });

  it('drops the payout after the flagship laps the screen without escorts', () => {
    const swarm = new Swarm();
    swarm.reset();
    const inflight = new InflightAliens();
    inflight.launchFlagshipOrRed(swarm, false);
    expect(inflight.flagshipEscortCount).toBe(2);

    // Both escorts die, then the flagship reaches the bottom: $0EF2 recounts
    // the live escorts, so the convoy bonus is spent.
    inflight.slots[SLOT_ESCORT_FIRST]!.isActive = false;
    inflight.slots[SLOT_ESCORT_FIRST + 1]!.isActive = false;
    const flag = inflight.slots[SLOT_FLAGSHIP]!;
    flag.stageOfLife = 5; // ReachedBottomOfScreen
    inflight.update(0, 0x80, true, false, swarm);
    expect(inflight.flagshipEscortCount).toBe(0);
    // It came round again rather than fleeing, because it still had escorts
    // on the books when it reached the bottom.
    expect(flag.isActive).toBe(true);

    // Next lap with a zero count, it flees the stage instead.
    flag.stageOfLife = 5;
    inflight.update(1, 0x80, true, false, swarm);
    expect(flag.isActive).toBe(false);
  });
});
