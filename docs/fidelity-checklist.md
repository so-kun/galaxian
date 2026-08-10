# Fidelity checklist

What is reproduced exactly, what is modelled, and what is approximated. Kept
honest so nobody has to reverse-engineer this project to find out.

## Sources

- **MAME** `src/mame/galaxian/` — hardware: clocks, raster, memory map, GFX
  formats, colour ladder, starfield, sprite/bullet hardware behaviour.
- **ScottTunstall/Galaxian** — annotated Z80 disassembly of the game ROM.
- **jotd666/galaxian500** — JOTD's line-by-line 68k transcode of the same ROM
  (the behaviour reference used for porting), plus the decoded graphics ROMs,
  the decoded 6L colour PROM, and sound recordings of the original board's
  audio. The tile/sprite pixel data and palette in `src/video/gfx-data.ts`
  and the WAVs in `public/sounds/` come from there.

## Exact — ported from the original code or data

| Item | Source | Where |
|---|---|---|
| All clocks divided from the 18.432 MHz crystal; 60.60606 Hz frame rate | MAME | `src/core/clock.ts` |
| 17-bit LFSR (bit12 XNOR bit0), period 131071 | MAME | `src/core/lfsr.ts` |
| Starfield: enable/colour taps, asymmetric 2-clocks-per-dot, V1^H8 gate, ±1 origin walk | MAME | `src/video/starfield.ts` |
| **Tile and sprite pixel data: the actual ROM graphics** | galaxian500 | `src/video/gfx-data.ts` |
| **Colour PROM contents decoded to RGB** | galaxian500 | `src/video/gfx-data.ts` |
| Star colour levels 0/194/214/255; bullet colours | MAME / PROM | `src/video/palette.ts` |
| Sprite hardware: complemented Y register, slots 0-2 at y-1, priority 7→0 | MAME + $0C38 | `src/video/hardware.ts`, `inflight.ts` |
| Screen orientation: screen_x = 223 − scanline (Y++ is left) | derived, verified against $5340/"1UP" | `src/video/renderer.ts` |
| Formation row → char column map; anchors X=124−12·row, Y=col·16+7+scroll | $20E1, $1147 | `src/game/swarm.ts` |
| 1x2 aliens plot base and base+2 ($25A9); 2x2 plot base..base+3 | $25A9/$2585 | `src/game/swarm.ts` |
| Swarm sweep: 1 px per 4 frames; extents $22/−$20 widening $10 per empty edge column | $093E, $09CE | `src/game/swarm.ts` |
| **The swarm halts the column your shot is about to hit** | $0910 | `src/game/swarm.ts` |
| Dive arc = radius-16 semicircle, 51 steps, quarter rotated 90° | $1E00, verified | `src/game/arc.ts` |
| CALCULATE_TANGENT: 8-round restoring binary division, byte-exact | $0048 | `src/game/arc.ts` |
| Sprite code from heading: 7 frames $11-$17 + flip bits, fold by $18 | $0C3D | `src/game/arc.ts` |
| **The dive weave: fixed-point harmonic oscillator (H += 2L/256, L −= 2H/256), byte-exact with the $80 overflow guards** | $116B | `src/game/inflight.ts` |
| Dive amplitude: clamp(±(offset/2+16), 48..112); escorts copy the flagship's | $0DDD | `src/game/inflight.ts` |
| The 16-stage StageOfLife machine incl. near-bottom speed-up, sortie counting, aggressive re-entry, loop-the-loop and its handoff | $0CD6 table | `src/game/inflight.ts` |
| Flagship escape/carry-over rules; escort counting | $0EDA | `src/game/inflight.ts` |
| Slot allocation (scratch/flagship/2 escorts/4 attackers); attacker count min(3,(base+extra)/2)+1 | $42B0, $1352 | `src/game/inflight.ts` |
| Firing gate: fixed altitudes X = $9D − $19k, more as row pairs empty | $0E54, $15F4 | `src/game/inflight.ts` |
| Enemy bullets: 14 slots, 2 px/frame fall, tangent+rand aim in 16-bit fixed point, 2-per-shell multiplexing | $0A80, $1200 | `src/game/game.ts` |
| Player: PLAYER_Y $17..$E9, scroll = ~Y+$80 into own columns; ship is characters | $0865 | `src/game/game.ts` |
| Player bullet: 4 px/frame, expiry, one on screen | $08BC | `src/game/game.ts` |
| Hit window vs in-flight aliens: X∈[−2,+4), Y∈[−5,+7) | $123F | `src/game/game.ts` |
| Attack cadence: counter bank with the $15E3 defaults; flagship sortie timer pair | $151E, $155F | `src/game/game.ts` |
| Flagship shock: swarm freezes when a flagship is hit | $1690 | `src/game/game.ts` |
| Scores: ALIEN_SCORE_TABLE incl. convoy 150/200/300/800 by escorts-killed-first | $22D0, $1273 | `src/game/game.ts` |
| Flagship points sprite ($20-$23) held at the kill site for 50 frames after the explosion | $112D, $039A | `src/game/inflight.ts`, `game.ts` |
| Dying reduces DIFFICULTY_EXTRA by one | $1300 | `src/game/game.ts` |
| Colour codes and speeds per row (ALIEN_PARAMS_TABLE) | $1DD1 | `src/game/swarm.ts` |
| HUD: red header/white scores, lives bottom-left, stage flags ($68 tens / $6C units) bottom-right | $2521, $214E | `src/game/game.ts` |
| Attract cycle: score screen, SCORE ADVANCE TABLE (convoy charger + ranks), demo game; start begins play | SCRIPT_ONE $03D2 | `src/game/attract.ts` |
| Player collision windows: enemy-bullet ($5/$B Y bands) and in-flight alien (narrow nose $15 / wide body $0F) | $0B8D, $12B6 | `src/game/game.ts` |
| Attack flank from swarm scroll vs extents (within $1C), else random | $13F0 | `src/game/game.ts` |
| HAVE_AGGRESSIVE_ALIENS set when 3 or fewer aliens remain | $16E7 | `src/game/game.ts` |
| DIFFICULTY_BASE = player level (+1 per stage, cap 7); DIFFICULTY_EXTRA +1 per 1200 frames, reset per stage, -1 on death | $1655, $14E8, $1300 | `src/game/game.ts` |
| Credits, 1P/2P start (1 vs 2 credits), two-player alternation a life at a time with a PLAYER N hand-off | $04E1, HANDLE_PLAYER_ONE_KILLED | `src/game/session.ts` |

## Recorded — real audio, not synthesis

The WAVs in `public/sounds/` are recordings of the board's discrete sound
section (captured via emulation, from galaxian500). Exact Galaxian audio is
unsolved even in MAME — its driver TODO still says the background hum runs
slow and the explosion is too hard, and CD4066 switch mixing cannot be
reproduced by a discrete netlist — so recordings are the highest-fidelity
option available. The swarm loop's rising tempo is reproduced by ramping
playback rate with stage time.

## Approximated — structure right, constants tuned

- **Attract mode** reproduces the visible cycle (score screen, score-advance
  table, demo game) but not the full 19-stage SCRIPT_ONE choreography: the
  "WE ARE THE GALAXIANS" scroll-in, the NAMCO logo page, and the exact
  convoy-charger blink/scroll are simplified, and the demo is driven by a
  simple threat-tracking AI rather than the ROM's scripted fake controller.
- The DIP switch service menu is not implemented; the bonus-life threshold
  uses the default DIP (7000) and is settable via `Game.bonusThreshold`, and
  the free-play / lives DIP options are not surfaced. Two-player alternation
  keeps each player's full state (score, lives, swarm) but does not reproduce
  the ROM's exact packed-swarm save/restore format -- it swaps whole game
  instances instead.

## Known gaps

- The swarm redraw happens wholesale per frame; the original repaints
  incrementally through a command queue (visible as slight tearing on real
  hardware, absent here).
- The arc table's 25-step quarter is stored, not derived; a greedy circle walk
  reproduces only 16/25 steps, so the original generator remains unknown.
- Star LFSR reset-vs-free-run at VSYNC is disputed; we follow MAME's free-run.
