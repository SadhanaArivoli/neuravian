import { describe, expect, it } from "vitest";
import {
  connectivityMatrixDifference,
  connectivityMatrixRange,
  parseConnectivityMatrixCsv,
} from "../src/lib/connectivityMatrix";

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

  it("computes Frobenius norm difference", () => {
    const a = parseConnectivityMatrixCsv(",A,B\nA,1,0.5\nB,0.5,1\n");
    const b = parseConnectivityMatrixCsv(",A,B\nA,1,0.25\nB,0.25,1\n");
    const diff = connectivityMatrixDifference(a, b);
    expect(diff.frobenius).toBeCloseTo(Math.sqrt(0.25 ** 2 + 0.25 ** 2));
    expect(diff.minDiff).toBe(0);
    expect(diff.maxDiff).toBe(0.25);
  });
});

