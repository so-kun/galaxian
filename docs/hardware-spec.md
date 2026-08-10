# Galaxian (Namco, 1979) — hardware specification

Working reference for this recreation. Everything here is traced to a primary
source; where a claim could not be verified it says so.

## Sources

| Source | What it is authoritative for |
|---|---|
| MAME `src/mame/galaxian/galaxian.cpp`, `galaxian.h`, `galaxian_v.cpp`, `galaxian_a.cpp` | Clocks, raster timing, memory map, GFX formats, colour ladder, starfield LFSR, discrete audio netlist. Comments are transcribed from the original schematics. |
| [ScottTunstall/Galaxian](https://github.com/ScottTunstall/Galaxian) `galaxian.asm` (~8,300 lines, annotated Z80 disassembly) | Game logic: swarm management, dive slot allocation, flagship + escorts, difficulty. MAME emulates the hardware and does not reimplement the game, so this is the only primary source for behaviour. |
| [MiSTer-devel/Arcade-Galaxian_MiSTer](https://github.com/MiSTer-devel/Arcade-Galaxian_MiSTer) | HDL cross-check when the C++ and the disassembly disagree. |

Two premises that are commonly repeated and are **wrong**:

- **There is no Namco WSG in Galaxian.** The sound is discrete TTL and 555
  timers. The ROM set contains no waveform PROM, which a WSG requires.
- **There is no 54XX noise custom.** That part belongs to Galaga / Bosconian.

The same 17-bit LFSR generates *both* the video starfield and the audio noise.

## Clocks

Everything divides down from one 18.432 MHz crystal.

| Signal | Derivation | Value |
|---|---|---|
| Master (XTAL) | — | 18.432 MHz |
| Z80 | XTAL/6 | 3.072 MHz |
| Dot clock | XTAL/3 | 6.144 MHz |
| HSYNC | XTAL/3/192/2 | 16 kHz |
| VSYNC (frame rate) | HSYNC/132/2 | **60.60606 Hz** |
| VBLANK | 1/VSYNC × 20/132 | 2500 µs |
| Sound section | XTAL/6/2 | 1.536 MHz |
| Noise/star RNG | XTAL/3×2 | 12.288 MHz |

The frame rate is not 60 Hz. Over a minute that is a ~36 frame difference,
which changes the swarm's sweep period and the pitch of the background hum.

Raster: 384 dots × 264 lines total; visible 256 × 224. Watchdog trips after 8
frames without a kick at `$7800`.

## Orientation

The monitor is rotated 90°, so the disassembly's coordinates are swapped
relative to what the player sees:

- Hardware **Y** is the player's **horizontal** axis. Y++ moves an object **left**.
- Hardware **X** is the player's **vertical** axis. X++ moves an object **down**.

This is corroborated by the dimensions and by how MAME places sprites: sprite
byte 3 (the game's *X*) becomes the raster horizontal position, and sprite byte
0 (the game's *Y*) becomes the scanline. So:

```
hardware dot      (256 across a scanline) -> player's vertical axis   (256 tall)
hardware scanline (224 lines)             -> player's horizontal axis (224 wide)
```

The visible playfield is therefore 224 × 256 portrait.

## Memory map

Derived from the schematics; independently corroborated by the disassembly.

```
0000-3FFF   Program ROM (16 KB)
4000-47FF   Work RAM                    (decoded with a 0x400 mirror)
5000-57FF   Character RAM               <- the alien swarm lives here, as tiles
5800-583F   Screen attributes           even = per-column scroll, odd = colour
5840-585F   Sprites                     8 records x 4 bytes
5860-587F   Bullets                     8 records x 5 bytes

6000  R     IN0   coin1/coin2/p1 left/p1 right/p1 shoot/cabinet/test/service
6800  R     IN1   1p start/2p start/p2 left/p2 right/p2 shoot/-/dip1/dip2
7000  R     IN2   dip switches

6004-6007 W  background LFO frequency, one bit per port
6800-6807 W  sound control (FS1/FS2/FS3, HIT, FIRE, ...)
7001      W  NMI enable      <- NMI, not INT. MAME's handler is named irq_enable_w.
7004      W  starfield enable
7006/7007 W  horizontal / vertical flip
7800      W  sound FX base pitch (8 bit)
7800      R  watchdog reset
```

## Graphics

2 bits per pixel, planar. The 4 KB GFX region splits in half: the first half is
plane 0, the second is plane 1.

- 8×8 character: 8 bytes per plane, 16 bytes total. 256 possible codes.
- 16×16 sprite: 32 bytes per plane, 64 bytes total. 64 possible codes.

Both layouts read the *same* bytes; they are two interpretations of one region.

> MAME's `gfx_layout` trailing `8*8` / `16*16` is a **bit** count, not bytes.
> Reading it as bytes gives the wrong stride.

**Sprite record** (4 bytes, 8 slots at `$5840`):

| Byte | Meaning |
|---|---|
| 0 | Y (player horizontal) |
| 1 | bits 0-5 code, bit 6 X-flip, bit 7 Y-flip |
| 2 | bits 0-2 colour code |
| 3 | X (player vertical) |

Placement: `sy = 240 - (byte0 - (slot < 3 ? 1 : 0))` — the first three slots
match against y-1. `sx = byte3 + 1`. Slots are drawn 7→0 so that lower slot
numbers take priority.

**Bullet record** (5 bytes): `{ IsActive, X, YL, YH, YDelta }`. A bullet starts
displaying when the horizontal counter hits `$FC` and stops at `$00`, giving a
4-pixel streak. Slots 0-6 are "shells" and render white; slot 7 is the
"missile" and renders yellow.

**Attribute RAM** (`$5800-$583F`): even addresses hold a per-column scroll
offset, odd addresses hold that column's colour code. A hardware column is a
*row* on the player's screen, so these registers scroll screen rows sideways —
this is how the swarm sweeps.

## Colour

A 32-byte PROM at 6L feeds a resistor ladder:

```
bit 7 -- 220 ohm -- BLUE
      -- 470 ohm -- BLUE
      -- 220 ohm -- GREEN
      -- 470 ohm -- GREEN
      -- 1 kohm  -- GREEN
      -- 220 ohm -- RED
      -- 470 ohm -- RED
bit 0 -- 1 kohm  -- RED
```

Blue has only two resistors, so it is a 2-bit channel. Weights are normalised
with a single shared scale factor, so red/green reach 224 while blue tops out
at 195. Resulting lattice:

- Red, green: `0, 29, 62, 91, 133, 162, 195, 224`
- Blue: `0, 62, 133, 195`

The 224 ceiling exists to leave headroom: the star generator and the
shell/missile drivers sit in parallel with this ladder and can pull the output
higher, which is why stars and bullets read as brighter than any sprite.

Star colours use their own network — 150 Ω for each channel's LSB and 100 Ω for
its MSB — compressed into the 194..255 range, giving four levels per channel:
`0, 194, 214, 255`. The 6-bit star colour splits into three 2-bit fields.

> The 32 PROM bytes in `src/video/palette.ts` are a **reconstruction**, not a
> dump. No free dump of the original PROM is legitimately available. The values
> were chosen to sit on the lattice above and to match the colours the game is
> known to display, and can be replaced wholesale via `Palette.loadColorProm()`.

## Starfield

A 17-bit LFSR with feedback `bit12 XNOR bit0` shifted into bit 16:

```
shiftreg = (shiftreg >> 1) | ((((shiftreg >> 12) ^ ~shiftreg) & 1) << 16)
```

Maximal length, period 2¹⁷−1 = 131071. Because the feedback is an XNOR, the
lock-up state is all-ones, not all-zeros — starting from 0 (as the hardware
does at power-on) is safe.

- **Lit** when `(shiftreg & 0x1FE01) == 0x1FE00` — top 8 bits set, bit 0 clear.
- **Colour** is `(~shiftreg & 0x1F8) >> 3`, indexing a 64-entry table.
- **Gated** by V1 ⊕ H8: no star unless `(y ^ (x >> 3)) & 1`, where `y` is the
  *absolute* scanline (16..239, not a zero-based row).

Three details that a naive implementation gets wrong:

1. **The RNG clock is asymmetric.** It is the 18 MHz master ANDed with the
   6 MHz pixel clock, whose divide-by-3 has a 2/3 duty cycle. That yields two
   RNG clocks per dot, spaced 1-then-2. The first paints one third of a dot,
   the second paints two thirds. Sampling once per dot gives the right density
   and the wrong pattern, so the framebuffer must be 3× wider than the dot
   clock.
2. **Scrolling is an off-by-one, not a counter.** Each frame clocks the
   register 512×256 = 2¹⁷ times, one more than its period. Unflipped, a pair of
   D flip-flops at 6B delays this to 2¹⁷−2, one *less*. Either way the pattern
   walks one step per frame; that is the whole mechanism.
3. **Galaxian's stars do not blink.** `m_stars_blink_state` belongs to
   Scramble / Moon Cresta. Implementing it here is a bug.

## Sound

Three discrete sections, no sound CPU and no sound ROM.

1. **Tone.** A pitch latch at `$7800` reloads a two-stage down counter producing
   `SOUND_CLOCK / (256 - pitch)`, which clocks a 74393 4-bit counter. The
   audible output is taken from the **QA, QC and QD taps** — that is, ÷2, ÷8 and
   ÷16. Treating `SOUND_CLOCK/(256-pitch)` as the pitch directly is wrong by a
   factor of 2 to 16.
2. **Background / drone.** Three 555 astables with CV modulation, enabled
   individually by FS1/FS2/FS3, plus a fourth 555 in constant-current
   configuration whose frequency is set by a 4-bit DAC (1 MΩ / 470 kΩ / 220 kΩ /
   100 kΩ) written to `$6004-$6007`.
3. **Noise.** The same 17-bit LFSR as the starfield, split two ways: a filtered
   output gated by the HIT line, and a fixed-length pulse triggered by the FIRE
   line via another 555.

Sound effect data lives in ROM as pitch sequences terminated by `$E0`:
game start tune at `$1E68`, alien death at `$1EBD`, flagship death at `$1EDF`.

### Known limits

Exact sound is unsolved even in MAME, and has been since the 1990s. The
driver's own TODO still reads:

> Background humming is incorrect. It's faster on a real machine.
> Explosion sound is much softer. Filter involved?

The audio device notes additionally that CD4066 switch mixing — where the input
resistor impedance changes to >10 MΩ — cannot be reproduced by a discrete
netlist at all, and that the HIT sound is too quiet against recordings.
Copying MAME therefore does not produce the real machine's sound.

## Game logic

State the original keeps in work RAM, from the disassembly:

```
$4005        SCRIPT_NUMBER            $400A  SCRIPT_STAGE
$4100-$417F  ALIEN_SWARM_FLAGS        128-byte occupancy grid, 01 = present
                                      stored upside down AND mirrored horizontally
                                      $4170 flagships / $4160 red / $4150 purple / $4140 blue
$41F0-$41FF  ALIEN_IN_COLUMN_FLAGS    edge detection for the sweep turnaround
$420D        SWARM_DIRECTION          0 = left, 1 = right
$420E        SWARM_SCROLL_VALUE       16-bit
$422A        FLAGSHIP_ESCORT_COUNT    max 2
$42B0-$43AF  INFLIGHT_ALIENS          8 slots x 32 bytes
$0048        CALCULATE_TANGENT        A = distance, D = X -> facing / bullet delta
$1E00        INFLIGHT_ALIEN_ARC_TABLE
```

### Why at most 7 aliens can be in flight

Slot assignment is hardcoded, and there are only 8 hardware sprites:

| Slot | Use |
|---|---|
| 0 | scratch (explosion animation when a swarm alien is shot) |
| 1 | flagship |
| 2, 3 | flagship escorts |
| 4-7 | lone attackers |

How many of slots 4-7 are actually scanned is dynamic:
`clamp((DIFFICULTY_BASE_VALUE + DIFFICULTY_EXTRA_VALUE) / 2, max 3)` then
incremented, giving 1..4. Early stages dive with fewer aliens.

- `DIFFICULTY_BASE_VALUE` — incremented during a stage, max 7.
- `DIFFICULTY_EXTRA_VALUE` — incremented on stage completion, max 7.

### In-flight alien record (32 bytes)

```
00 IsActive        01 IsDying          02 StageOfLife     03 X
04 Y               05 AnimationFrame   06 ArcClockwise    07 IndexInSwarm
09 PivotYValue     (while attacking, this + $19 gives Y)
0F AnimFrameStartCode  10 TempCounter1  11 TempCounter2
12 DeathAnimCode   13 ArcTableLsb      16 Colour
17 SortieCount     18 Speed (0-3)      19 PivotYValueAdd
```

### The dive arc

`INFLIGHT_ALIEN_ARC_TABLE` at `$1E00` is 103 bytes: 51 pairs plus a trailing
byte. Each pair is `{ signed delta to add to X, magnitude to add to or subtract
from Y }`, the sign of the Y term depending on which way the alien was facing
when it broke formation. The comment calls it "the arc to perform a loop the
loop manoeuvre".

Integrating the deltas shows what it actually is: **a semicircle of radius 16**,
centred 16 units ahead, traversed in 51 steps (π×16 ≈ 50.3). Maximum deviation
of any point from that circle is 0.476.

The table has exact internal structure, verified numerically:

- The per-step deviation sequence is periodic with period 25 and is mirror
  symmetric within each period.
- The second quarter is the first quarter rotated 90°:
  `arc[25 + i] = { arc[i].dy, -arc[i].dx }` — an exact 25/25 match.
- Equivalently `arc[25 + i] = { -arc[24 - i].dx, arc[24 - i].dy }`, also exact.

So the whole 51-entry table is determined by 25 quarter-circle steps, and this
recreation generates it rather than transcribing ROM bytes.

## Open questions

- Horizontal blanking start is not pinned down. `galaxian.h` carries a
  commented-out `HBSTART = 264 * XSCALE` alternative; MAME crops to 256 dots to
  match 32 tiles.
- Whether the star LFSR is reset by nVSYNC or free-runs with a per-frame delta
  is disputed in the literature. This implementation follows MAME's free-run.
- `LS164` is MAME's name for the tone divider, which is odd engineering — a
  74LS164 has no parallel load. Worth checking against a real schematic.
