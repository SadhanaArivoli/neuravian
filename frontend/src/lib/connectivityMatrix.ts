export interface ConnectivityMatrixData {
  labels: string[];
  values: number[][];
}

export interface ConnectivityMatrixRange {
  min: number;
  max: number;
  rows: number;
  cols: number;
}

export interface ConnectivityMatrixDifference {
  frobenius: number;
  minDiff: number;
  maxDiff: number;
  largestAbsDiff: number;
}

export interface ConnectivityMetadata {
  atlas: string;
  atlas_id: string;
  atlas_display_name?: string;
  atlas_source?: string;
  atlas_version?: string | null;
  atlas_fetcher?: string;
  atlas_type?: string;
  atlas_space?: string;
  atlas_resolution?: string;
  atlas_citation?: string;
  atlas_network_count?: number | null;
  roi_count?: number;
  correlation_method: string;
  n_rois: number;
  n_volumes: number;
  matrix_shape: [number, number];
  roi_labels: string[];
  correlation_min: number;
  correlation_max: number;
  correlation_mean: number;
  subject: string | null;
  task: string | null;
  bold_file: string | null;
  confounds_file: string | null;
  runtime_seconds: number;
  // Confound provenance (added in Fisher-z milestone)
  confound_strategy?: string;
  confounds_used?: string[];
  n_confound_regressors?: number;
  global_signal_included?: boolean;
  n_volumes_before_cleaning?: number;
  n_volumes_after_cleaning?: number;
}

export type MatrixComparisonMode = "same-source" | "cross-subject";

export interface MatrixCompatibilityResult {
  compatible: boolean;
  reason: string;
  mode?: MatrixComparisonMode;
}

export function checkMatrixCompatibility(
  a: ConnectivityMetadata,
  b: ConnectivityMetadata,
): MatrixCompatibilityResult {
  if (a.atlas_id !== b.atlas_id) {
    return { compatible: false, reason: `Atlas mismatch: "${a.atlas_id}" vs "${b.atlas_id}"` };
  }
  if (a.n_rois !== b.n_rois) {
    return { compatible: false, reason: `ROI count mismatch: ${a.n_rois} vs ${b.n_rois}` };
  }
  const aShape = a.matrix_shape;
  const bShape = b.matrix_shape;
  if (aShape[0] !== bShape[0] || aShape[1] !== bShape[1]) {
    return {
      compatible: false,
      reason: `Matrix dimensions differ: ${aShape.join("×")} vs ${bShape.join("×")}`,
    };
  }
  if (a.correlation_method !== b.correlation_method) {
    return {
      compatible: false,
      reason: `Correlation method mismatch: "${a.correlation_method}" vs "${b.correlation_method}"`,
    };
  }
  const labelsMatch =
    a.roi_labels.length === b.roi_labels.length &&
    a.roi_labels.every((l, i) => l === b.roi_labels[i]);
  if (!labelsMatch) {
    return { compatible: false, reason: "ROI label ordering differs between runs" };
  }
  const sameSource = a.bold_file !== null && a.bold_file === b.bold_file;
  return {
    compatible: true,
    reason: sameSource
      ? "Same source BOLD file (deterministic result expected)"
      : "Compatible atlas and ROI label ordering across subjects",
    mode: sameSource ? "same-source" : "cross-subject",
  };
}

export function parseConnectivityMatrixCsv(text: string): ConnectivityMatrixData {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("Matrix CSV is empty.");
  const labels = lines[0].split(",").slice(1).map((value) => value.trim());
  const values = lines.slice(1).map((line) => line.split(",").slice(1).map(Number));
  if (values.some((row) => row.some((value) => Number.isNaN(value)))) {
    throw new Error("Matrix CSV contains non-numeric values.");
  }
  return { labels, values };
}

export function connectivityMatrixRange(matrix: ConnectivityMatrixData): ConnectivityMatrixRange {
  const flat = matrix.values.flat();
  return {
    min: Math.min(...flat),
    max: Math.max(...flat),
    rows: matrix.values.length,
    cols: matrix.values[0]?.length ?? 0,
  };
}

export function connectivityMatrixDifference(
  a: ConnectivityMatrixData,
  b: ConnectivityMatrixData,
): ConnectivityMatrixDifference {
  const rows = Math.min(a.values.length, b.values.length);
  const cols = Math.min(a.values[0]?.length ?? 0, b.values[0]?.length ?? 0);
  let sum = 0;
  let minDiff = Number.POSITIVE_INFINITY;
  let maxDiff = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const diff = (a.values[y][x] ?? 0) - (b.values[y][x] ?? 0);
      sum += diff * diff;
      minDiff = Math.min(minDiff, diff);
      maxDiff = Math.max(maxDiff, diff);
    }
  }
  const finalMin = Number.isFinite(minDiff) ? minDiff : 0;
  const finalMax = Number.isFinite(maxDiff) ? maxDiff : 0;
  return {
    frobenius: Math.sqrt(sum),
    minDiff: finalMin,
    maxDiff: finalMax,
    largestAbsDiff: Math.max(Math.abs(finalMin), Math.abs(finalMax)),
  };
}
