/**
 * Figma transform matrix → Konva rotation prop.
 *
 * Spec: docs/specs/archive/web-render-fidelity-round3.spec.md §2
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
 *  - the matrix has skew (I-R3 — caller falls back to plain translation)
 *
 * Handles axis-aligned mirroring (`R(θ) ∘ diag(±1, ±1)`) by delegating to
 * `decomposeTransform`. Spec round 34: Figma stores hour-line variants
 * with `R(120°) ∘ scale(1, -1)` — the visually equivalent of a 120°
 * rotation around a Y-flipped baseline — which the previous strict
 * `isPureRotationLinear` check rejected, leaving the line un-rotated.
 */
export function rotationDegrees(transform: Transform | undefined): number | undefined {
  return decomposeTransform(transform).rotation;
}

/**
 * Decompose a Figma 2x3 affine matrix into rotation + axis-aligned scale.
 *
 * Spec: docs/specs/archive/web-render-fidelity-round3.spec.md §2
 * (extended in round 34 — `R ∘ diag(sx, sy)` for sx, sy ∈ {-1, +1}).
 *
 * Returns `{ rotation, scaleX, scaleY }` where each field is `undefined`
 * when it's at its identity value (no rotation, scale = 1). Returns all
 * `undefined`s for matrices with skew (non-axis-aligned scale) so the
 * caller falls back to translation-only rendering (the pre-round-3
 * behaviour for unsupported transforms).
 *
 * Math: any matrix `M = [m00 m01; m10 m11]` that's R(θ) followed by
 * axis-aligned scale `diag(sx, sy)` satisfies
 *
 *   m00 = sx·cos(θ)   m01 = -sy·sin(θ)
 *   m10 = sx·sin(θ)   m11 =  sy·cos(θ)
 *
 * det(M) = sx·sy. We pick `sx = sqrt(m00² + m10²)` (always non-negative)
 * and recover sy from det / sx, then check the residual against the
 * predicted m01/m11 — a mismatch larger than TOL means the matrix had
 * skew or non-uniform scale, and we punt.
 *
 * Mirror is folded into sy by convention (sx stays positive). For a
 * matrix that's actually `diag(-1, +1) ∘ R`, the equivalent
 * `R(θ+180°) ∘ diag(+1, -1)` is what comes out; visually the same.
 */
export function decomposeTransform(transform: Transform | undefined): {
  rotation: number | undefined;
  scaleX: number | undefined;
  scaleY: number | undefined;
} {
  if (!transform) return { rotation: undefined, scaleX: undefined, scaleY: undefined };
  const m00 = transform.m00 ?? 1;
  const m01 = transform.m01 ?? 0;
  const m10 = transform.m10 ?? 0;
  const m11 = transform.m11 ?? 1;

  // Identity linear part → no rotation, no scale to surface.
  if (
    Math.abs(m00 - 1) < TOL && Math.abs(m11 - 1) < TOL &&
    Math.abs(m01) < TOL && Math.abs(m10) < TOL
  ) {
    return { rotation: undefined, scaleX: undefined, scaleY: undefined };
  }

  const sx = Math.sqrt(m00 * m00 + m10 * m10);
  if (sx < TOL) {
    // Degenerate column (all-zero or pure-skew) — bail to translation-only.
    return { rotation: undefined, scaleX: undefined, scaleY: undefined };
  }
  const det = m00 * m11 - m01 * m10;
  const sy = det / sx;

  // Verify the remaining matrix entries match an axis-aligned
  // R ∘ diag(sx, sy) decomposition. Any deviation means the matrix had
  // skew or non-uniform scale that this v1 path can't represent.
  const cos = m00 / sx;
  const sin = m10 / sx;
  const expectM01 = -sin * sy;
  const expectM11 = cos * sy;
  if (Math.abs(m01 - expectM01) > TOL || Math.abs(m11 - expectM11) > TOL) {
    return { rotation: undefined, scaleX: undefined, scaleY: undefined };
  }

  const rad = Math.atan2(m10, m00);
  let deg = (rad * 180) / Math.PI;
  if (Math.abs(deg) < 0.01) deg = 0;

  return {
    rotation: deg !== 0 ? deg : undefined,
    scaleX: Math.abs(sx - 1) < TOL ? undefined : sx,
    scaleY: Math.abs(sy - 1) < TOL ? undefined : sy,
  };
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
