import { describe, it, expect } from 'vitest';
import { InflightAliens } from '../src/game/inflight';
import { FLAGSHIP_SCORES, FLAGSHIP_POINT_SPRITE_BASE } from '../src/game/game';

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
