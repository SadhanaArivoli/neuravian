/**
 * Pure, testable helpers for Pipeline Comparison Studio candidate discovery.
 *
 * Three-tier eligibility model:
 *   verified   – both runs share a non-null source_run_id (same ancestor)
 *                OR one run is a direct ancestor of the other.
 *   unverified – same dataset_id but no lineage to verify (fallback with warning).
 *   ineligible – different datasets; should not be compared.
 */

import type { RunSummary } from "../api/client";

// ── Eligibility classification ─────────────────────────────────────────────────

export type EligibilityTier = "verified" | "unverified" | "ineligible";

export interface EligibilityResult {
  tier: EligibilityTier;
  reason: string;
}

/**
 * Classify whether `candidate` is comparable to `ref`.
 * Does not inspect artifact types — the caller is responsible for that filter.
 */
export function classifyEligibility(
  ref: RunSummary,
  candidate: RunSummary
): EligibilityResult {
  if (ref.id === candidate.id) {
    return { tier: "ineligible", reason: "Same run" };
  }

  // Tier A: verified siblings — both trace to the same non-null ancestor
  if (
    ref.source_run_id !== null &&
    ref.source_run_id !== undefined &&
    candidate.source_run_id !== null &&
    candidate.source_run_id !== undefined &&
    ref.source_run_id === candidate.source_run_id
  ) {
    return {
      tier: "verified",
      reason: `Comparable: both derived from run #${ref.source_run_id}.`,
    };
  }

  // Tier A: direct parent-child — candidate was derived from ref
  if (
    candidate.source_run_id !== null &&
    candidate.source_run_id !== undefined &&
    candidate.source_run_id === ref.id
  ) {
    return {
      tier: "verified",
      reason: `Comparable: run #${candidate.id} was derived from this run.`,
    };
  }

  // Tier A: direct parent-child — ref was derived from candidate
  if (
    ref.source_run_id !== null &&
    ref.source_run_id !== undefined &&
    ref.source_run_id === candidate.id
  ) {
    return {
      tier: "verified",
      reason: `Comparable: this run was derived from run #${candidate.id}.`,
    };
  }

  // Tier B: same dataset, no lineage information — unverified fallback
  if (ref.dataset_id === candidate.dataset_id) {
    return {
      tier: "unverified",
      reason:
        "Same dataset — lineage unverified. Confirm inputs match before drawing conclusions.",
    };
  }

  return { tier: "ineligible", reason: "Different datasets" };
}

/**
 * Sort run options by eligibility (verified first), filtering out ineligible runs.
 * Preserves original order within each tier.
 */
export function sortByEligibility<T extends { run: RunSummary }>(
  ref: RunSummary,
  options: T[]
): Array<T & { eligibility: EligibilityResult }> {
  const TIER_ORDER: Record<EligibilityTier, number> = {
    verified: 0,
    unverified: 1,
    ineligible: 2,
  };
  return options
    .map((o) => ({ ...o, eligibility: classifyEligibility(ref, o.run) }))
    .filter((o) => o.eligibility.tier !== "ineligible")
    .sort((a, b) => TIER_ORDER[a.eligibility.tier] - TIER_ORDER[b.eligibility.tier]);
}

/**
 * Find exactly one verified sibling of `ref` among `candidates`.
 * Returns null if there are zero or more than one verified siblings
 * (ambiguous — caller should show generic "Compare" rather than naming one).
 * Only considers runs from a different pipeline.
 */
export function findVerifiedSibling(
  ref: RunSummary,
  candidates: RunSummary[]
): RunSummary | null {
  const verified = candidates.filter((c) => {
    if (c.pipeline_manifest_id === ref.pipeline_manifest_id) return false;
    const r = classifyEligibility(ref, c);
    return r.tier === "verified";
  });
  return verified.length === 1 ? verified[0] : null;
}

// ── Dice coefficient (pure, voxel-array level) ─────────────────────────────────

export interface DiceStats {
  dice: number;
  intersection: number;
  aOnly: number;
  bOnly: number;
  totalForeground: number;
}

/**
 * Compute Dice similarity coefficient and mask statistics from two binary
 * voxel arrays. Values > 0 are foreground; 0 is background.
 * Throws if the arrays have different lengths.
 */
export function computeDice(
  a: Uint8Array | Int16Array | Float32Array,
  b: Uint8Array | Int16Array | Float32Array
): DiceStats {
  if (a.length !== b.length) {
    throw new Error(`Array length mismatch: ${a.length} vs ${b.length}`);
  }
  let intersection = 0;
  let aOnly = 0;
  let bOnly = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] > 0;
    const inB = b[i] > 0;
    if (inA && inB) intersection++;
    else if (inA) aOnly++;
    else if (inB) bOnly++;
  }
  const totalForeground = intersection + aOnly + bOnly;
  const dice =
    totalForeground === 0
      ? 0
      : (2 * intersection) / (2 * intersection + aOnly + bOnly);
  return { dice, intersection, aOnly, bOnly, totalForeground };
}

// ── NIfTI geometry compatibility ───────────────────────────────────────────────

export interface NiftiGeometry {
  /** Spatial dimensions [nx, ny, nz] */
  dims: [number, number, number];
  /** Voxel sizes in mm [dx, dy, dz] */
  pixdim: [number, number, number];
  /** NIfTI datatype code */
  datatype: number;
  /** qform code */
  qformCode: number;
  /** sform code */
  sformCode: number;
}

/**
 * Return true when two NIfTI volumes have the same spatial dimensions and
 * voxel spacing (within floating-point tolerance). When false, voxel-wise
 * operations (Dice, true difference map) are invalid.
 */
export function geometriesCompatible(a: NiftiGeometry, b: NiftiGeometry): boolean {
  return (
    a.dims[0] === b.dims[0] &&
    a.dims[1] === b.dims[1] &&
    a.dims[2] === b.dims[2] &&
    Math.abs(a.pixdim[0] - b.pixdim[0]) < 0.001 &&
    Math.abs(a.pixdim[1] - b.pixdim[1]) < 0.001 &&
    Math.abs(a.pixdim[2] - b.pixdim[2]) < 0.001
  );
}
