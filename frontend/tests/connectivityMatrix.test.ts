import { describe, expect, it } from "vitest";
import {
  checkMatrixCompatibility,
  connectivityMatrixDifference,
  connectivityMatrixRange,
  parseConnectivityMatrixCsv,
  type ConnectivityMetadata,
} from "../src/lib/connectivityMatrix";

const baseMeta: ConnectivityMetadata = {
  atlas: "Schaefer 2018, 100 parcels, 7 networks",
  atlas_id: "schaefer_100_7",
  correlation_method: "Pearson correlation",
  n_rois: 100,
  n_volumes: 168,
  matrix_shape: [100, 100],
  roi_labels: Array.from({ length: 100 }, (_, i) => `ROI_${i + 1}`),
  correlation_min: -0.5,
  correlation_max: 0.8,
  correlation_mean: 0.01,
  subject: "pixar123",
  task: "pixar",
  bold_file: "/data/sub-pixar123_bold.nii.gz",
  confounds_file: "/data/sub-pixar123_confounds.tsv",
  runtime_seconds: 5.0,
};

describe("connectivityMatrix helpers", () => {
  it("parses labelled matrix CSV and computes range", () => {
    const matrix = parseConnectivityMatrixCsv(",ROI A,ROI B\nROI A,1,0.25\nROI B,0.25,1\n");
    expect(matrix.labels).toEqual(["ROI A", "ROI B"]);
    expect(matrix.values).toEqual([[1, 0.25], [0.25, 1]]);
    expect(connectivityMatrixRange(matrix)).toEqual({
      min: 0.25,
      max: 1,
      rows: 2,
      cols: 2,
    });
  });

  it("computes Frobenius norm difference and largestAbsDiff", () => {
    const a = parseConnectivityMatrixCsv(",A,B\nA,1,0.5\nB,0.5,1\n");
    const b = parseConnectivityMatrixCsv(",A,B\nA,1,0.25\nB,0.25,1\n");
    const diff = connectivityMatrixDifference(a, b);
    expect(diff.frobenius).toBeCloseTo(Math.sqrt(0.25 ** 2 + 0.25 ** 2));
    expect(diff.minDiff).toBe(0);
    expect(diff.maxDiff).toBe(0.25);
    expect(diff.largestAbsDiff).toBe(0.25);
  });

  it("largestAbsDiff picks the larger of |min| and |max| diff", () => {
    const a = parseConnectivityMatrixCsv(",A,B\nA,0,-0.6\nB,0.4,0\n");
    const b = parseConnectivityMatrixCsv(",A,B\nA,0,0\nB,0,0\n");
    const diff = connectivityMatrixDifference(a, b);
    expect(diff.minDiff).toBeCloseTo(-0.6);
    expect(diff.maxDiff).toBeCloseTo(0.4);
    expect(diff.largestAbsDiff).toBeCloseTo(0.6);
  });

  it("identical matrices have Frobenius 0 and largestAbsDiff 0", () => {
    const a = parseConnectivityMatrixCsv(",A,B\nA,1,0.5\nB,0.5,1\n");
    const diff = connectivityMatrixDifference(a, a);
    expect(diff.frobenius).toBe(0);
    expect(diff.largestAbsDiff).toBe(0);
  });
});

describe("checkMatrixCompatibility", () => {
  it("marks two matching-atlas runs as compatible cross-subject when BOLD differs", () => {
    const b: ConnectivityMetadata = {
      ...baseMeta,
      subject: "sub02",
      bold_file: "/data/sub-02_bold.nii.gz",
    };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(true);
    expect(result.mode).toBe("cross-subject");
  });

  it("marks same-source runs (identical bold_file) as same-source", () => {
    const result = checkMatrixCompatibility(baseMeta, { ...baseMeta });
    expect(result.compatible).toBe(true);
    expect(result.mode).toBe("same-source");
  });

  it("rejects atlas mismatch", () => {
    const b: ConnectivityMetadata = { ...baseMeta, atlas_id: "schaefer_200_7" };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/atlas mismatch/i);
  });

  it("rejects ROI count mismatch", () => {
    const b: ConnectivityMetadata = {
      ...baseMeta,
      n_rois: 200,
      matrix_shape: [200, 200],
      roi_labels: Array.from({ length: 200 }, (_, i) => `ROI_${i + 1}`),
    };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/roi count/i);
  });

  it("rejects matrix dimension mismatch even with matching n_rois", () => {
    const b: ConnectivityMetadata = { ...baseMeta, matrix_shape: [100, 50] };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/dimensions/i);
  });

  it("rejects ROI label ordering mismatch", () => {
    const shuffledLabels = [...baseMeta.roi_labels].reverse();
    const b: ConnectivityMetadata = { ...baseMeta, roi_labels: shuffledLabels };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/label ordering/i);
  });

  it("rejects correlation method mismatch", () => {
    const b: ConnectivityMetadata = { ...baseMeta, correlation_method: "partial correlation" };
    const result = checkMatrixCompatibility(baseMeta, b);
    expect(result.compatible).toBe(false);
    expect(result.reason).toMatch(/correlation method/i);
  });

  it("null bold_file on both → cross-subject (not same-source)", () => {
    const a: ConnectivityMetadata = { ...baseMeta, bold_file: null };
    const b: ConnectivityMetadata = { ...baseMeta, bold_file: null };
    const result = checkMatrixCompatibility(a, b);
    expect(result.compatible).toBe(true);
    expect(result.mode).toBe("cross-subject");
  });
});
