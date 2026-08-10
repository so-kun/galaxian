# Galaxian

A browser recreation of Namco's *Galaxian* (1979), built from the arcade
board's schematics and an annotated Z80 disassembly of the original ROM.

```
npm install
npm run dev      # play at http://127.0.0.1:5173
npm test         # 51 tests
npm run build    # static output in dist/
```

Arrow keys or A/D to move, Space or Z to fire. Touch: left third steers left,
right third steers right, middle fires.

No ROM images are needed or included. Galaxian's ROMs are still under copyright
and there is no legitimate free source for them, so the graphics and the colour
PROM contents here are authored rather than dumped — see
[docs/fidelity-checklist.md](docs/fidelity-checklist.md) for exactly what is
reproduced, what is modelled, and what is drawn by hand.

## What this is trying to be

Not "a Galaxian-like shooter" but the actual machine's behaviour, derived from
primary sources rather than from memory of playing it. Some of what that turned
up:

**The frame rate is 60.60606 Hz**, not 60. Everything divides down from one
18.432 MHz crystal: `HSYNC = XTAL/3/192/2 = 16 kHz`, `VSYNC = HSYNC/132/2`.

**One 17-bit LFSR drives both the starfield and the audio noise.** Not two
similar circuits — the same shift register, tapped twice.

**The starfield cannot be drawn one sample per pixel.** Its RNG is clocked by
(18 MHz AND 6 MHz), and the divide-by-3 that makes the pixel clock has a 2/3
duty cycle, so there are two RNG clocks per dot spaced 1-then-2. A star from the
first clock is a third of a dot wide; one from the second is two thirds.
Sampling once per dot gives the right density and the wrong pattern. The
framebuffer is 3× wider than the dot clock for this reason alone.

**The alien formation is not made of sprites.** It is drawn into character RAM
and swept sideways by writing per-column scroll registers. Only aliens that have
broken away become sprites — which is why at most *seven* can dive at once:
there are eight sprite slots and slot 0 is reserved as scratch for explosion
animation. The player's ship isn't a sprite either; it is a 2×2 block of
characters that moves by scrolling its own columns.

**The dive arc is a semicircle.** `INFLIGHT_ALIEN_ARC_TABLE` at `$1E00` is 103
bytes of delta pairs. Integrating them traces a circle of radius 16, walked in
51 steps, with no point straying more than 0.476 from it. The table also has
exact internal structure: its second half is the first quarter rotated 90°, an
exact 25-of-25 match. So this implementation generates the table from 25
quarter-circle steps instead of transcribing ROM bytes, and the test checks the
geometry rather than a byte array.

**Two things everybody says about the sound are wrong.** Galaxian has no Namco
WSG and no 54XX noise custom — the ROM set contains no waveform PROM, which a
WSG requires. The sound is discrete TTL and 555 timers. And within it,
`SOUND_CLOCK / (256 - pitch)` is the clock going *into* the 74393, not a note:
the audible output comes off the QA, QC and QD taps, so the pitch you hear is
that clock ÷2, ÷8 and ÷16.

## Sources

- MAME `src/mame/galaxian/` — clocks, raster timing, memory map, GFX formats,
  colour ladder, starfield, discrete audio netlist. Its comments are transcribed
  from the original schematics.
- [ScottTunstall/Galaxian](https://github.com/ScottTunstall/Galaxian) — an
  annotated Z80 disassembly, ~8,300 lines. MAME emulates the hardware and does
  not reimplement the game, so this is the only primary source for behaviour.
- [MiSTer Arcade-Galaxian](https://github.com/MiSTer-devel/Arcade-Galaxian_MiSTer)
  — HDL, used to cross-check where the C++ and the disassembly disagree.

[docs/hardware-spec.md](docs/hardware-spec.md) collects the specification with
citations.

## Layout

```
src/core/     clocks and the 17-bit LFSR
src/video/    palette, starfield, tilemap, sprites, bullets, rotation
src/game/     formation, in-flight aliens, dive arc, scoring
src/audio/    the discrete sound section, as an AudioWorklet
docs/         hardware specification and fidelity checklist
```
