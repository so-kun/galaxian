/**
 * The video hardware: tilemap, sprites and bullets, composited over the stars.
 *
 * This layer works directly on the memory the original writes to, so the game
 * code below it pokes the same addresses the Z80 did:
 *
 *   videoram  $5000-$53FF   32x32 characters
 *   objram    $5800-$58FF   attributes, sprites, bullets
 *
 * Draw order is the board's: stars, tilemap, sprites, bullets. The tilemap
 * treats pen 0 as transparent, which is what lets the starfield show through
 * the empty parts of the screen.
 */

import { SCREEN_W, SCREEN_H, XSCALE, VBEND } from '../core/clock';
import type { Palette } from './palette';
import type { GfxSet } from './gfx';
import { CHAR_SIZE, SPRITE_SIZE, CHAR_SPACE } from './gfx';
import type { Starfield } from './starfield';
import { FB_WIDTH } from './renderer';

/** Offsets within objram ($5800). */
export const ATTR_BASE = 0x00; // 32 x (scroll, colour)
export const SPRITE_BASE = 0x40; // 8 x 4 bytes
export const BULLET_BASE = 0x60; // 8 x 4 bytes

export const SPRITE_SLOTS = 8;
export const BULLET_SLOTS = 8;

/** Bullets are a 4-pixel streak: they start displaying at $FC and stop at $00. */
const BULLET_LENGTH = 4;

export class VideoHardware {
  /** Character RAM, $5000-$53FF. */
  readonly videoram = new Uint8Array(0x400);
  /** Object RAM, $5800-$58FF. */
  readonly objram = new Uint8Array(0x100);

  /** $7006 / $7007. */
  flipScreenX = false;
  flipScreenY = false;

  constructor(
    private readonly palette: Palette,
    private readonly gfx: GfxSet,
    private readonly stars: Starfield,
  ) {
    this.clearScreen();
  }

  /** Fill character RAM with the blank character, as the game's init does. */
  clearScreen(): void {
    this.videoram.fill(CHAR_SPACE);
  }

  /** Park every sprite and bullet off screen. */
  clearObjects(): void {
    this.objram.fill(0, SPRITE_BASE, SPRITE_BASE + SPRITE_SLOTS * 4);
    this.objram.fill(0, BULLET_BASE, BULLET_BASE + BULLET_SLOTS * 4);
  }

  /** $7004: gate the starfield. */
  set starsEnabled(on: boolean) {
    this.stars.enabled = on;
  }

  draw(frame: Uint32Array): void {
    frame.fill(0xff000000);
    this.stars.flipScreenX = this.flipScreenX;
    this.stars.draw(frame, VBEND, SCREEN_H);
    this.drawTilemap(frame);
    this.drawSprites(frame);
    this.drawBullets(frame);
  }

  /**
   * 32x32 characters with per-column vertical scroll.
   *
   * A hardware column is a *row* on the player's screen, so these scroll
   * registers slide screen rows sideways -- that is how the alien formation
   * sweeps back and forth.
   */
  private drawTilemap(frame: Uint32Array): void {
    const { chars } = this.gfx;
    const pens = this.palette.pens;

    for (let row = 0; row < SCREEN_H; row++) {
      const y = VBEND + row;
      const rowBase = row * FB_WIDTH;

      for (let col = 0; col < 32; col++) {
        const scroll = this.objram[ATTR_BASE + col * 2]!;
        const colorCode = this.objram[ATTR_BASE + col * 2 + 1]! & 7;
        const penBase = colorCode << 2;

        // Scrolled position within the 256-pixel-tall tile plane.
        const ty = (y + scroll) & 0xff;
        const tileIndex = ((ty >> 3) << 5) | col;
        const glyph = chars[this.videoram[tileIndex]!]!;
        const glyphRow = (ty & 7) * CHAR_SIZE;

        const dotBase = col * CHAR_SIZE;
        for (let i = 0; i < CHAR_SIZE; i++) {
          const pixel = glyph[glyphRow + i]!;
          if (pixel === 0) continue; // transparent pen: stars show through
          const color = pens[penBase | pixel]!;
          const o = rowBase + (dotBase + i) * XSCALE;
          frame[o] = color;
          frame[o + 1] = color;
          frame[o + 2] = color;
        }
      }
    }
  }

  /**
   * Eight 16x16 sprites.
   *
   * Drawn from slot 7 down to 0: the line buffer is only written where it still
   * holds zero, so lower slot numbers win. The first three slots are placed one
   * scanline higher than the rest -- a quirk of the comparator wiring, not a
   * rounding artefact.
   */
  private drawSprites(frame: Uint32Array): void {
    const { sprites } = this.gfx;
    const pens = this.palette.pens;

    for (let slot = SPRITE_SLOTS - 1; slot >= 0; slot--) {
      const base = SPRITE_BASE + slot * 4;
      const b0 = this.objram[base]!;
      const b1 = this.objram[base + 1]!;
      const b2 = this.objram[base + 2]!;
      const b3 = this.objram[base + 3]!;

      let sy = (240 - (b0 - (slot < 3 ? 1 : 0))) & 0xff;
      let sx = (b3 + 1) & 0xff;
      let flipx = (b1 & 0x40) !== 0;
      let flipy = (b1 & 0x80) !== 0;
      const code = b1 & 0x3f;
      const penBase = (b2 & 7) << 2;

      if (this.flipScreenX) {
        sx = (240 - sx) & 0xff;
        flipx = !flipx;
      }
      if (this.flipScreenY) {
        sy = (240 - sy) & 0xff;
        flipy = !flipy;
      }

      const bmp = sprites[code]!;
      for (let py = 0; py < SPRITE_SIZE; py++) {
        const row = sy + py - VBEND;
        if (row < 0 || row >= SCREEN_H) continue;
        const srcRow = (flipy ? SPRITE_SIZE - 1 - py : py) * SPRITE_SIZE;
        const rowBase = row * FB_WIDTH;

        for (let px = 0; px < SPRITE_SIZE; px++) {
          const dot = sx + px;
          if (dot < 0 || dot >= SCREEN_W) continue;
          const pixel = bmp[srcRow + (flipx ? SPRITE_SIZE - 1 - px : px)]!;
          if (pixel === 0) continue;
          const color = pens[penBase | pixel]!;
          const o = rowBase + dot * XSCALE;
          frame[o] = color;
          frame[o + 1] = color;
          frame[o + 2] = color;
        }
      }
    }
  }

  /**
   * Bullets, resolved per scanline.
   *
   * The hardware can show at most one shell and one missile on any given
   * scanline -- there is a single comparator for each -- so a scanline with
   * several bullets on it shows the highest-numbered match, not all of them.
   * Slot 7 is the player's missile and renders yellow; slots 0-6 are shells and
   * render white. The first three slots match against y-1.
   */
  private drawBullets(frame: Uint32Array): void {
    const colors = this.palette.bulletColors;

    for (let row = 0; row < SCREEN_H; row++) {
      const y = VBEND + row;
      let shell = -1;
      let missile = -1;

      const effyEarly = (this.flipScreenY ? (y - 1) ^ 0xff : y - 1) & 0xff;
      for (let which = 0; which < 3; which++) {
        if (((this.objram[BULLET_BASE + which * 4 + 1]! + effyEarly) & 0xff) === 0xff) shell = which;
      }
      const effy = (this.flipScreenY ? y ^ 0xff : y) & 0xff;
      for (let which = 3; which < BULLET_SLOTS; which++) {
        if (((this.objram[BULLET_BASE + which * 4 + 1]! + effy) & 0xff) === 0xff) {
          if (which !== 7) shell = which;
          else missile = which;
        }
      }

      if (shell >= 0) {
        this.drawBullet(frame, row, 255 - this.objram[BULLET_BASE + shell * 4 + 3]!, colors[shell]!);
      }
      if (missile >= 0) {
        const x = 255 - this.objram[BULLET_BASE + missile * 4 + 3]!;
        this.drawBullet(frame, row, x, colors[missile]!);
      }
    }
  }

  private drawBullet(frame: Uint32Array, row: number, endX: number, color: number): void {
    const rowBase = row * FB_WIDTH;
    for (let i = 0; i < BULLET_LENGTH; i++) {
      const dot = endX - BULLET_LENGTH + i;
      if (dot < 0 || dot >= SCREEN_W) continue;
      const o = rowBase + dot * XSCALE;
      frame[o] = color;
      frame[o + 1] = color;
      frame[o + 2] = color;
    }
  }
}
