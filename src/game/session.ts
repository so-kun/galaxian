/**
 * The cabinet session: credits, one- and two-player games, and the alternation
 * between two players, wrapped around the attract cycle.
 *
 * This follows HANDLE_START_BUTTONS ($04E1): a 1P start costs one credit and
 * plays a single game; a 2P start costs two credits and alternates the two
 * players a life at a time, each keeping its own score, lives and swarm. When
 * a player dies with lives left in a two-player game, control passes to the
 * other player (if they are still in) after a short "PLAYER N" banner, exactly
 * as the board hands off between PLAYER_ONE_STATE and PLAYER_TWO_STATE.
 */

import { Game } from './game';
import { Attract } from './attract';
import type { SoundSink } from './game';
import { charOrdinal, CHAR_SPACE } from '../video/gfx';
import { COLOR_CODE_TEXT_RED, COLOR_CODE_TEXT_WHITE } from '../video/palette';
import { printText, textCol, TEXT_PLAYER_ONE, TEXT_PLAYER_TWO } from './romtext';
import { DEFAULT_DIP, type DipSettings } from './dip';
import type { InputState } from '../input';

const MAX_CREDITS = 99;
/** Frames the "PLAYER N" hand-off banner stays up before play resumes. */
const BANNER_FRAMES = 130;
/** Idle frames on a game-over screen before dropping back to attract. */
const ATTRACT_IDLE = 240;

const enum Mode {
  Attract,
  Banner,
  Playing,
}

export class Session {
  credits = 0;
  sound: SoundSink | null = null;
  dip: DipSettings = { ...DEFAULT_DIP };

  private mode = Mode.Attract;
  private readonly attract = new Attract();
  private players: Game[] = [];
  private active = 0;
  private twoPlayer = false;
  private bannerTimer = 0;
  private highScore = 0;
  /** Previous coin-key state, so a held key adds only one credit. */
  private prevCoin = false;

  /** A coin was inserted. */
  addCredit(): void {
    if (this.credits < MAX_CREDITS) this.credits++;
    this.sound?.coin?.();
  }

  private newGame(index: number): Game {
    const g = new Game();
    g.sound = index === this.active ? this.sound : null;
    g.autoRespawn = false;
    g.playerIndex = index;
    g.highScore = this.highScore;
    // Apply the DIP options: starting Galaxips and the bonus threshold.
    g.lives = this.dip.lives;
    g.bonusThreshold = this.dip.bonusThreshold;
    return g;
  }

  private startGame(twoPlayer: boolean): void {
    this.twoPlayer = twoPlayer;
    if (!this.dip.freePlay) this.credits -= twoPlayer ? 2 : 1;
    this.active = 0;
    this.players = twoPlayer ? [this.newGame(0), this.newGame(1)] : [this.newGame(0)];
    // A single-player game respawns on its own; a two-player game hands off.
    if (!twoPlayer) this.players[0]!.autoRespawn = true;
    this.players[0]!.sound = this.sound;
    this.sound?.gameStart();
    this.mode = Mode.Playing;
  }

  private get activeGame(): Game {
    return this.players[this.active]!;
  }

  /** Advance one frame. */
  update(input: InputState): void {
    if (input.coin && !this.prevCoin) this.addCredit();
    this.prevCoin = input.coin;

    switch (this.mode) {
      case Mode.Attract:
        this.updateAttract(input);
        break;
      case Mode.Banner:
        if (--this.bannerTimer <= 0) {
          this.activeGame.resume();
          this.mode = Mode.Playing;
        }
        break;
      case Mode.Playing:
        this.updatePlaying(input);
        break;
    }
  }

  private updateAttract(input: InputState): void {
    // Start buttons need credits (unless free play).
    const free = this.dip.freePlay;
    if (input.start2 && (free || this.credits >= 2)) {
      this.startGame(true);
      return;
    }
    if (input.start && (free || this.credits >= 1)) {
      this.startGame(false);
      return;
    }
    this.attract.credits = this.credits;
    this.attract.freePlay = free;
    this.attract.bonusThreshold = this.dip.bonusThreshold;
    this.attract.update({ ...input, start: false, start2: false });
  }

  private updatePlaying(input: InputState): void {
    const game = this.activeGame;
    game.step(input);

    // Hand-off point: the active player just died with lives remaining.
    if (game.pendingResume) {
      if (this.twoPlayer && this.otherPlayerInPlay()) {
        this.swapPlayer();
        return;
      }
      // Single player, or the other player is out: this player carries on.
      game.resume();
      return;
    }

    // This player is finished (out of lives).
    if (game.gameOver) {
      if (this.twoPlayer && this.otherPlayerInPlay()) {
        this.swapPlayer();
        return;
      }
      // Both players done: linger on game over, then return to attract.
      this.highScore = Math.max(this.highScore, ...this.players.map((p) => p.highScore));
      if (game.idleFrames > ATTRACT_IDLE || input.start) {
        this.attract.highScore = this.highScore;
        this.attract.reset();
        this.mode = Mode.Attract;
      }
    }
  }

  private otherPlayerInPlay(): boolean {
    if (!this.twoPlayer) return false;
    const other = this.players[this.active ^ 1]!;
    return other.lives > 0 && !other.gameOver;
  }

  private swapPlayer(): void {
    this.players[this.active]!.sound = null;
    this.active ^= 1;
    this.activeGame.sound = this.sound;
    this.bannerTimer = BANNER_FRAMES;
    this.mode = Mode.Banner;
    this.sound?.gameStart();
  }

  /** Draw the current frame into hardware memory. */
  render(videoram: Uint8Array, objram: Uint8Array): void {
    if (this.mode === Mode.Attract) {
      this.attract.render(videoram, objram);
      return;
    }

    // Both play modes render the active game underneath.
    this.activeGame.render(videoram, objram);
    if (this.twoPlayer) this.drawTwoPlayerHud(videoram, objram);

    if (this.mode === Mode.Banner) {
      this.drawBanner(videoram, objram);
    }
  }

  /** In a two-player game, show 1UP and 2UP scores with the active one lit. */
  private drawTwoPlayerHud(videoram: Uint8Array, objram: Uint8Array): void {
    const p1 = this.players[0]!;
    const p2 = this.players[1]!;
    // 2UP label and score on the header's far side.
    this.text(videoram, objram, 8, 0, '2UP', this.active === 1 ? COLOR_CODE_TEXT_RED : COLOR_CODE_TEXT_WHITE);
    this.text(videoram, objram, 7, 1, p2.score.toString().padStart(6, '0').replace(/^00/, '  '), COLOR_CODE_TEXT_WHITE);
    // Dim the inactive 1UP by leaving the game's own red header; nothing to do
    // beyond ensuring player 2's score is shown. Player 1's score is already
    // drawn by the active game when active === 0; when active === 1 we draw it.
    if (this.active === 1) {
      this.text(videoram, objram, 26, 0, '1UP', COLOR_CODE_TEXT_WHITE);
      this.text(videoram, objram, 25, 1, p1.score.toString().padStart(6, '0').replace(/^00/, '  '), COLOR_CODE_TEXT_WHITE);
    }
  }

  private drawBanner(videoram: Uint8Array, objram: Uint8Array): void {
    // The ROM's own PLAYER 0NE / PLAYER TWO strings at $5294, blinking.
    if ((this.bannerTimer >> 4) & 1) {
      const text = this.active === 0 ? TEXT_PLAYER_ONE : TEXT_PLAYER_TWO;
      const col = textCol(text);
      objram[col * 2 + 1] = COLOR_CODE_TEXT_RED;
      objram[col * 2] = 0;
      printText(videoram, text);
    }
  }

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
