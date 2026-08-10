/**
 * The dive arc.
 *
 * `INFLIGHT_ALIEN_ARC_TABLE` at $1E00 is 103 bytes: 51 delta pairs plus a
 * trailing byte. Each pair is `{ signed delta added to X, magnitude added to or
 * subtracted from Y }`, the sign of the Y term depending on which way the alien
 * was facing when it broke formation. The disassembly calls it "the arc to
 * perform a loop the loop manoeuvre".
 *
 * Integrating the deltas shows what it really is: a **semicircle of radius 16**,
 * walked in 51 steps (a semicircle's circumference is pi*16 = 50.3). No point
 * on the path is further than 0.476 from that circle.
 *
 * The table also has exact internal structure, verified numerically against the
 * original bytes:
 *
 *   - the per-step deviation from the circle is periodic with period 25, and is
 *     mirror-symmetric within each period;
 *   - the second quarter is the first rotated 90 degrees:
 *     `arc[25 + i] = { arc[i].dy, -arc[i].dx }`, an exact 25-of-25 match.
 *
 * So the whole table is determined by 25 quarter-circle steps, which is what we
 * store. `test/arc.test.ts` checks the generated table against the geometry it
 * is supposed to describe.
 */

export interface ArcStep {
  /** Signed delta applied to the alien's X (the player's vertical axis). */
  dx: number;
  /** Magnitude applied to the alien's Y; the caller chooses the sign. */
  dy: number;
}

/**
 * The first quarter: 25 unit steps from the top of a radius-16 circle round to
 * its leftmost point.
 */
const QUARTER: readonly (readonly [number, number])[] = [
  [-1, 0], [-1, 0], [-1, 0], [-1, 1], [-1, 0],
  [-1, 0], [-1, 1], [-1, 0], [-1, 1], [-1, 0],
  [0, 1], [-1, 0], [-1, 1], [0, 1], [-1, 0],
  [0, 1], [-1, 1], [0, 1], [-1, 1], [0, 1],
  [0, 1], [-1, 1], [0, 1], [0, 1], [0, 1],
];

/** Radius of the circle the arc traces. */
export const ARC_RADIUS = 16;

/** Number of delta pairs in the table. */
export const ARC_STEPS = 51;

/** Build the full 51-step arc from the quarter and its 90 degree rotation. */
export function buildArcTable(): ArcStep[] {
  const arc: ArcStep[] = QUARTER.map(([dx, dy]) => ({ dx, dy }));
  for (const [dx, dy] of QUARTER) {
    // Rotate the step 90 degrees: (dx, dy) -> (dy, -dx).
    arc.push({ dx: dy, dy: -dx });
  }
  arc.push({ dx: 1, dy: 0 });
  return arc;
}

export const ARC_TABLE = buildArcTable();

/**
 * Byte offset into the table, matching `INFLIGHT_ALIEN.ArcTableLsb`.
 *
 * The original advances the pointer by one byte after reading the X delta and
 * again after the Y delta, so the field counts bytes, not steps.
 */
export function arcStepAt(lsb: number): ArcStep | undefined {
  return ARC_TABLE[lsb >> 1];
}

/**
 * CALCULATE_TANGENT ($0048): "Used by the aliens to determine what way to face
 * when flying down, and what delta enemy bullets take. Expects: A = distance,
 * D = X coordinate."
 *
 * The original approximates the ratio by repeated shifting and comparison. We
 * compute the same quantity directly and quantise it to the 24 headings the
 * game tracks, which is what the sprite-code arithmetic at $0C3D consumes.
 */
export function calculateTangent(distance: number, dx: number): number {
  if (distance === 0) return 0;
  const angle = Math.atan2(dx, distance); // radians from straight ahead
  const heading = Math.round((angle / (2 * Math.PI)) * 24);
  return Math.max(-12, Math.min(11, heading));
}

/**
 * Sprite code and flip bits for a heading, ported from $0C3D.
 *
 * Thirteen base frames cover a quarter turn each way; the hardware's X and Y
 * flip bits supply the other three quadrants. Headings outside -12..11 wrap by
 * a full 24 before being classified.
 */
export function spriteForHeading(
  animationFrame: number,
  startCode: number,
): { code: number; flipX: boolean; flipY: boolean } {
  // AnimationFrame is a signed byte in the original ($0C40 tests bit 7).
  let a = ((animationFrame & 0xff) ^ 0x80) - 0x80;
  // The original folds out-of-range headings by +/- $18 and retries.
  while (a >= 0x0c) a -= 0x18;
  while (a < -0x0c) a += 0x18;

  if (a >= 0 && a < 6) {
    // 180-270 degrees as the player sees it
    return { code: (a + 0x11 + startCode) & 0x3f, flipX: true, flipY: true };
  }
  if (a >= 6) {
    // 270-360 degrees
    return { code: (0x1d - a + startCode) & 0x3f, flipX: false, flipY: true };
  }
  if (a >= -6) {
    // 0-90 degrees
    return { code: (0x1d + a + startCode) & 0x3f, flipX: false, flipY: false };
  }
  // 90-180 degrees
  return { code: (0x11 - a + startCode) & 0x3f, flipX: true, flipY: false };
}
