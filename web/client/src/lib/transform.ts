/**
 * Figma transform matrix → Konva rotation prop.
 *
 * Spec: docs/specs/web-render-fidelity-round3.spec.md §2
 *
 * Figma stores a 2x3 affine matrix in `node.transform`:
 *   [m00 m01 m02]    [scaleX*cos(θ)  -scaleY*sin(θ)  tx]
 *   [m10 m11 m12]  = [scaleX*sin(θ)   scaleY*cos(θ)  ty]
 *
 * For pure rotation around the parent origin, the linear part has
 * |m00|=|m11|, m01=-m10, and the rotation angle is atan2(m10, m00).
 * Skew or non-uniform scale break this — for those cases we leave
 * rotation off so the node renders translation-only (the v1 behavior).
 */

interface Transform {
  m00?: number;
  m01?: number;
  m02?: number;
  m10?: number;
  m11?: number;
  m12?: number;
}

const TOL = 1e-3;

/**
 * Returns the rotation in degrees, or undefined when:
 *  - transform is missing
 *  - the matrix is identity (no rotation)
 *  - the matrix has skew or non-uniform scale (I-R3 — caller falls
 *    back to plain translation)
 */
export function rotationDegrees(transform: Transform | undefined): number | undefined {
  if (!transform) return undefined;
  const m00 = transform.m00 ?? 1;
  const m01 = transform.m01 ?? 0;
  const m10 = transform.m10 ?? 0;
  const m11 = transform.m11 ?? 1;

  // Identity → no rotation.
  if (Math.abs(m00 - 1) < TOL && Math.abs(m11 - 1) < TOL && Math.abs(m01) < TOL && Math.abs(m10) < TOL) {
    return undefined;
  }

  if (!isPureRotationLinear(m00, m01, m10, m11)) return undefined;

  const rad = Math.atan2(m10, m00);
  const deg = (rad * 180) / Math.PI;
  // Clamp ±0.01° noise to 0 so identity-with-rounding-error doesn't
  // sneak through here.
  return Math.abs(deg) < 0.01 ? undefined : deg;
}

/**
 * Is the linear part a pure rotation (uniform scale, no skew)?
 *
 * Pure rotation matrix: m00 = m11 = scale * cos(θ), m01 = -m10 = -scale * sin(θ).
 * Equivalently |m00| ≈ |m11| AND m01 ≈ -m10.
 */
export function isPureRotation(transform: Transform | undefined): boolean {
  if (!transform) return true; // missing transform = identity = pure
  const m00 = transform.m00 ?? 1;
  const m01 = transform.m01 ?? 0;
  const m10 = transform.m10 ?? 0;
  const m11 = transform.m11 ?? 1;
  return isPureRotationLinear(m00, m01, m10, m11);
}

function isPureRotationLinear(m00: number, m01: number, m10: number, m11: number): boolean {
  // Allow negative scale (mirroring) — det = ±(m00*m11 - m01*m10).
  if (Math.abs(m00 - m11) > TOL) return false;
  if (Math.abs(m01 + m10) > TOL) return false;
  return true;
}
