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
  return {
    frobenius: Math.sqrt(sum),
    minDiff: Number.isFinite(minDiff) ? minDiff : 0,
    maxDiff: Number.isFinite(maxDiff) ? maxDiff : 0,
  };
}

