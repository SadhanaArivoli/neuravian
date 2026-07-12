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

// ── Comparison family detection ────────────────────────────────────────────────

export type ComparisonFamily = "anatomical" | "connectivity" | "group_connectivity" | "alff_falff" | "reho" | "nifti_inspector" | "roi_extraction" | "graph_analysis" | "mixed" | "none";

const ANATOMICAL_TYPES = new Set(["brain_mask", "skull_stripped_t1", "nifti_raw"]);

function hasConnectivity(types: string[]): boolean {
  return types.some((t) => t.startsWith("connectivity_"));
}
function hasSeedConnectivity(types: string[]): boolean {
  return types.some((t) => t.startsWith("seed_connectivity_"));
}
function hasGroupConnectivity(types: string[]): boolean {
  return types.some((t) => t.startsWith("group_"));
}
function hasNiftiInspector(types: string[]): boolean {
  return types.some((t) => t.startsWith("nifti_inspector_") || t === "nifti_inspector_json");
}
function hasRoiExtraction(types: string[]): boolean {
  return types.some((t) => t.startsWith("roi_extraction_"));
}
function hasGraphAnalysis(types: string[]): boolean {
  return types.some((t) => t.startsWith("graph_"));
}
function hasAnatomical(types: string[]): boolean {
  return types.some((t) => ANATOMICAL_TYPES.has(t));
}
function hasAlffFalff(types: string[]): boolean {
  return types.some((t) => ["alff_map_nii", "falff_map_nii", "alff_normalized_map_nii", "falff_normalized_map_nii"].includes(t));
}
function hasReho(types: string[]): boolean {
  return types.some((t) => t === "reho_map_nii" || t === "reho_normalized_map_nii");
}

/**
 * Determine which comparison family applies to a pair of runs, based on their
 * produced artifact types.  "mixed" means one run is anatomical and the other
 * is connectivity — these cannot be meaningfully compared.
 */
export function detectComparisonFamily(
  producedTypesA: string[],
  producedTypesB: string[],
): ComparisonFamily {
  const connA = hasConnectivity(producedTypesA);
  const connB = hasConnectivity(producedTypesB);
  const seedA = hasSeedConnectivity(producedTypesA);
  const seedB = hasSeedConnectivity(producedTypesB);
  const groupA = hasGroupConnectivity(producedTypesA);
  const groupB = hasGroupConnectivity(producedTypesB);
  const inspA = hasNiftiInspector(producedTypesA);
  const inspB = hasNiftiInspector(producedTypesB);
  const roiA = hasRoiExtraction(producedTypesA);
  const roiB = hasRoiExtraction(producedTypesB);
  const graphA = hasGraphAnalysis(producedTypesA);
  const graphB = hasGraphAnalysis(producedTypesB);
  const anatA = hasAnatomical(producedTypesA);
  const anatB = hasAnatomical(producedTypesB);
  const alffA = hasAlffFalff(producedTypesA);
  const alffB = hasAlffFalff(producedTypesB);
  const rehoA = hasReho(producedTypesA);
  const rehoB = hasReho(producedTypesB);
  if (rehoA && rehoB) return "reho";
  if (rehoA || rehoB) return "mixed";
  if (alffA && alffB) return "alff_falff";
  if (alffA || alffB) return "mixed";
  // graph_analysis pairs with itself only
  if (graphA && graphB) return "graph_analysis";
  if (graphA || graphB) return "mixed";
  // roi_extraction pairs with itself only
  if (roiA && roiB) return "roi_extraction";
  if (roiA || roiB) return "mixed";
  // nifti_inspector pairs with itself only
  if (inspA && inspB) return "nifti_inspector";
  if (inspA || inspB) return "mixed";
  if ((connA || connB || groupA || groupB) && (anatA || anatB)) return "mixed";
  if ((seedA || seedB) && (anatA || anatB)) return "mixed";
  // Seed, FC, and group cannot be compared with each other
  if ((seedA || seedB) && (connA || connB)) return "mixed";
  if ((groupA || groupB) && (connA || connB || seedA || seedB)) return "mixed";
  if (groupA || groupB) return "group_connectivity";
  if (seedA || seedB) return "connectivity";
  if (connA || connB) return "connectivity";
  if (anatA || anatB) return "anatomical";
  return "none";
}

/**
 * Detect the family for a single run's output types.
 */
export function detectRunFamily(
  producedTypes: string[],
): "connectivity" | "seed_connectivity" | "group_connectivity" | "alff_falff" | "reho" | "nifti_inspector" | "roi_extraction" | "graph_analysis" | "anatomical" | "other" {
  if (hasReho(producedTypes)) return "reho";
  if (hasAlffFalff(producedTypes)) return "alff_falff";
  if (hasGraphAnalysis(producedTypes)) return "graph_analysis";
  if (hasRoiExtraction(producedTypes)) return "roi_extraction";
  if (hasNiftiInspector(producedTypes)) return "nifti_inspector";
  if (hasGroupConnectivity(producedTypes)) return "group_connectivity";
  if (hasSeedConnectivity(producedTypes)) return "seed_connectivity";
  if (hasConnectivity(producedTypes)) return "connectivity";
  if (hasAnatomical(producedTypes)) return "anatomical";
  return "other";
}

export interface AlffCompatibilityMetadata {
  tr: number;
  frequency_band: [number, number];
  confound_strategy: string;
  normalization: string;
  detrending: string;
  mask_voxel_count: number;
}

export interface AlffCompatibilityResult {
  compatible: boolean;
  differences: string[];
}

export function checkAlffCompatibility(a: AlffCompatibilityMetadata, b: AlffCompatibilityMetadata): AlffCompatibilityResult {
  const differences: string[] = [];
  if (Math.abs(a.tr - b.tr) > 1e-9) differences.push("TR");
  if (Math.abs(a.frequency_band[0] - b.frequency_band[0]) > 1e-9 || Math.abs(a.frequency_band[1] - b.frequency_band[1]) > 1e-9) differences.push("frequency band");
  if (a.confound_strategy !== b.confound_strategy) differences.push("confound strategy");
  if (a.normalization !== b.normalization) differences.push("normalization");
  if (a.detrending !== b.detrending) differences.push("detrending");
  if (a.mask_voxel_count !== b.mask_voxel_count) differences.push("mask voxel count");
  return { compatible: differences.length === 0, differences };
}

export interface RehoCompatibilityMetadata {
  tr: number;
  neighborhood: number;
  confound_strategy: string;
  detrending: string;
  z_normalize: boolean;
  mask_voxel_count: number;
}

export interface RehoCompatibilityResult {
  compatible: boolean;
  differences: string[];
}

export function checkRehoCompatibility(a: RehoCompatibilityMetadata, b: RehoCompatibilityMetadata): RehoCompatibilityResult {
  const differences: string[] = [];
  if (Math.abs(a.tr - b.tr) > 1e-9) differences.push("TR");
  if (a.neighborhood !== b.neighborhood) differences.push("neighborhood size");
  if (a.confound_strategy !== b.confound_strategy) differences.push("confound strategy");
  if (a.detrending !== b.detrending) differences.push("detrending");
  if (a.z_normalize !== b.z_normalize) differences.push("z-normalization");
  if (a.mask_voxel_count !== b.mask_voxel_count) differences.push("mask voxel count");
  return { compatible: differences.length === 0, differences };
}

export function computeMapDifferenceStats(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) throw new Error("Map voxel counts differ");
  let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0, abs = 0, sq = 0, max = 0, count = 0;
  const difference = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const d = b[i] - a[i]; difference[i] = d; abs += Math.abs(d); sq += d*d; max = Math.max(max, Math.abs(d));
    sumA += a[i]; sumB += b[i]; sumAA += a[i]*a[i]; sumBB += b[i]*b[i]; sumAB += a[i]*b[i]; count++;
  }
  const numerator = count * sumAB - sumA * sumB;
  const denominator = Math.sqrt((count * sumAA - sumA*sumA) * (count * sumBB - sumB*sumB));
  return { correlation: denominator > 0 ? numerator / denominator : null, meanAbsoluteDifference: count ? abs/count : 0, rmse: count ? Math.sqrt(sq/count) : 0, maximumAbsoluteDifference: max, voxelCount: count, difference };
}

/**
 * Find a compatible connectivity sibling among `candidates`.
 * Priority: same source_run_id (same import) → same dataset_id.
 * All candidates are assumed to already produce connectivity matrices.
 * Returns null if none found.
 */
export function findCompatibleConnectivityRun(
  ref: RunSummary,
  candidates: RunSummary[],
): RunSummary | null {
  // Prefer same-source (shared import run)
  if (ref.source_run_id !== null && ref.source_run_id !== undefined) {
    const sameSource = candidates.find(
      (c) =>
        c.source_run_id === ref.source_run_id &&
        c.source_run_id !== null,
    );
    if (sameSource) return sameSource;
  }
  // Cross-subject: any run on the same dataset
  return candidates.find((c) => c.dataset_id === ref.dataset_id) ?? null;
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
