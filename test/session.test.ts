import { describe, it, expect } from 'vitest';
import { Session, BOOT_FRAMES } from '../src/game/session';
import type { InputState } from '../src/input';

const IDLE: InputState = {
  left: false,
  right: false,
  fire: false,
  start: false,
  start2: false,
  coin: false,
};

/** Reach into the session for white-box assertions. */
type Internals = {
  credits: number;
  players: { lives: number; gameOver: boolean; autoRespawn: boolean; playerIndex: number }[];
  active: number;
  twoPlayer: boolean;
  mode: number;
};
const peek = (s: Session) => s as unknown as Internals;

function coin(s: Session): void {
  // A coin needs a rising edge, so release between insertions.
  s.update({ ...IDLE, coin: true });
  s.update(IDLE);
}

/** A session past its power-on sequence, ready to take coins. */
function bootedSession(): Session {
  const s = new Session();
  for (let i = 0; i < BOOT_FRAMES; i++) s.update(IDLE);
  return s;
}

describe('power-on sequence', () => {
  it('shows the RAM-test pattern, ignores coins, then reaches attract', () => {
    const s = new Session();
    const videoram = new Uint8Array(0x400);
    const objram = new Uint8Array(0x100);

    // During the character-RAM test the four 256-byte pages carry the
    // seeded pattern ($1AC5: pass + $2F, one higher per page), the
    // attributes are zeroed and the stars are off.
    s.update({ ...IDLE, coin: true });
    s.render(videoram, objram);
    expect(videoram[0x000]).toBe(0x20 - 1 + 0x2f);
    expect(videoram[0x100]).toBe(0x20 - 1 + 0x30);
    expect(objram[1]).toBe(0);
    expect(s.starsEnabled).toBe(false);

    // Coins are ignored throughout the self test.
    for (let i = 0; i < BOOT_FRAMES; i++) s.update({ ...IDLE, coin: true });
    expect(s.credits).toBe(0);
    expect(s.starsEnabled).toBe(true);

    // Attract is up afterwards: the header's HIGH SCORE from the ROM table.
    s.render(videoram, objram);
    expect(videoram[0x280]).not.toBe(0x10);
  });
});

describe('cabinet session', () => {
  it('accrues one credit per coin press, not per held frame', () => {
    const s = bootedSession();
    expect(s.credits).toBe(0);
    // A single continuous hold is one coin, however long it lasts.
    for (let i = 0; i < 10; i++) s.update({ ...IDLE, coin: true });
    expect(s.credits).toBe(1);
    // Releasing and pressing again is a second coin.
    s.update(IDLE); // release
    coin(s);
    expect(s.credits).toBe(2);
  });

  it('will not start without enough credits', () => {
    const s = bootedSession();
    s.update({ ...IDLE, start: true });
    expect(peek(s).mode).toBe(0); // still attract
    coin(s);
    s.update({ ...IDLE, start: true });
    expect(peek(s).mode).not.toBe(0); // now playing
  });

  it('a one-player start costs one credit and auto-respawns', () => {
    const s = bootedSession();
    coin(s);
    coin(s);
    s.update({ ...IDLE, start: true });
    const i = peek(s);
    expect(s.credits).toBe(1);
    expect(i.twoPlayer).toBe(false);
    expect(i.players.length).toBe(1);
    expect(i.players[0]!.autoRespawn).toBe(true);
  });

  it('a two-player start costs two credits and sets up both players', () => {
    const s = bootedSession();
    coin(s);
    coin(s);
    s.update({ ...IDLE, start2: true });
    const i = peek(s);
    expect(s.credits).toBe(0);
    expect(i.twoPlayer).toBe(true);
    expect(i.players.length).toBe(2);
    // Two-player games hand off, so neither auto-respawns.
    expect(i.players.every((p) => !p.autoRespawn)).toBe(true);
    expect(i.players[0]!.playerIndex).toBe(0);
    expect(i.players[1]!.playerIndex).toBe(1);
  });

  it('hands control to the other player when the active one dies', () => {
    const s = bootedSession();
    coin(s);
    coin(s);
    s.update({ ...IDLE, start2: true });
    const i = peek(s);
    expect(i.active).toBe(0);

    // Force player 1 into a "died, lives remain, awaiting turn" state.
    const p1 = i.players[0]! as unknown as {
      lives: number;
      autoRespawn: boolean;
      pendingResume: boolean;
      resume(): void;
    };
    // Simulate the death handoff by driving the session while p1 reports pending.
    Object.defineProperty(p1, 'pendingResume', { get: () => true, configurable: true });

    s.update(IDLE);
    // Control should now be with player 2, showing the banner.
    expect(peek(s).active).toBe(1);
    expect(peek(s).mode).toBe(1); // Banner
  });
});
