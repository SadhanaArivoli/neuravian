import { describe, expect, it } from "vitest";
import {
  DISPLAY_PROFILES,
  classifyScientificMap,
  computeDisplayStatistics,
  selectDisplayProfile,
} from "../src/lib/scientificDisplayProfiles";

describe("scientific display profile classification", () => {
  it("prioritizes artifact type over conflicting filename", () => {
    expect(classifyScientificMap({ artifactType: "brain_mask", name: "t1w.nii.gz" })).toBe("binary-mask");
    expect(classifyScientificMap({ artifactType: "seed_connectivity_map_nii", name: "orange-map.nii.gz" })).toBe("correlation");
  });

  it("uses metadata before semantic type and filename", () => {
    expect(classifyScientificMap({ semanticType: "alff", name: "alff.nii.gz", metadata: { units: "z-score" } })).toBe("z-score");
  });

  it("uses pipeline metadata before filename fallback", () => {
    expect(classifyScientificMap({ pipelineId: "statistical-map-explorer", metadata: { direction: "positive" }, name: "result.nii.gz" })).toBe("positive-continuous");
    expect(classifyScientificMap({ name: "sub-01_atlas.nii.gz" })).toBe("label-atlas");
    expect(classifyScientificMap({ name: "sub-01_T1w.nii.gz" })).toBe("structural");
    expect(classifyScientificMap({ name: "stripped.nii.gz" })).toBe("structural");
  });

  it("uses pipeline identity before filename-derived semantic hints", () => {
    expect(classifyScientificMap({
      pipelineId: "seed-based-connectivity",
      semanticType: "z_map",
      name: "seed_connectivity_map.nii.gz",
    })).toBe("correlation");
  });

  it("selects scientifically labelled profiles", () => {
    expect(selectDisplayProfile({ artifactType: "seed_connectivity_map_nii" }).colorbarLabel).toBe("Fisher z");
    expect(selectDisplayProfile({ artifactType: "reho_normalized_map_nii" }).signed).toBe(true);
    expect(DISPLAY_PROFILES["binary-mask"].interpolation).toBe("nearest");
  });
});

describe("smart display ranges", () => {
  it("excludes a mostly-zero background from positive percentiles", () => {
    const values = [...Array(1000).fill(0), 1, 2, 3, 4, 5];
    const stats = computeDisplayStatistics(values, DISPLAY_PROFILES["positive-continuous"]);
    expect(stats.displayMin).toBe(0);
    expect(stats.p2).toBeGreaterThan(0);
    expect(stats.backgroundZeroCount).toBe(1000);
  });

  it("makes asymmetric signed tails symmetric around zero", () => {
    const values = [...Array(1000).fill(0), -12, -6, -3, -1, 0.5, 1, 2, 4];
    const stats = computeDisplayStatistics(values, DISPLAY_PROFILES["signed-continuous"]);
    expect(stats.displayMin).toBe(-stats.displayMax);
    expect(stats.displayMin).toBeLessThan(0);
    expect(stats.displayMax).toBeGreaterThan(0);
  });

  it("anchors all-positive maps at zero", () => {
    const stats = computeDisplayStatistics([1, 2, 3, 4], DISPLAY_PROFILES["positive-continuous"]);
    expect(stats.displayMin).toBe(0);
    expect(stats.displayMax).toBeGreaterThan(3);
  });

  it("creates a usable range for a constant map", () => {
    const stats = computeDisplayStatistics([5, 5, 5], DISPLAY_PROFILES["positive-continuous"]);
    expect(stats.isConstant).toBe(true);
    expect(stats.displayMin).toBeLessThan(stats.displayMax);
  });

  it("keeps binary masks and label atlases exact", () => {
    expect(computeDisplayStatistics([0, 0, 1, 1], DISPLAY_PROFILES["binary-mask"]).displayMax).toBe(1);
    const labels = computeDisplayStatistics([0, 1, 4, 9], DISPLAY_PROFILES["label-atlas"]);
    expect([labels.displayMin, labels.displayMax]).toEqual([0, 9]);
  });

  it("ignores NaN and Infinity", () => {
    const stats = computeDisplayStatistics([Number.NaN, -2, 0, 3, Number.POSITIVE_INFINITY], DISPLAY_PROFILES["signed-continuous"]);
    expect(stats.validCount).toBe(3);
    expect(stats.displayMin).toBe(-stats.displayMax);
  });

  it("handles empty and all-zero maps", () => {
    expect(computeDisplayStatistics([], DISPLAY_PROFILES["unknown-continuous"]).isEmpty).toBe(true);
    const zeros = computeDisplayStatistics([0, 0, 0], DISPLAY_PROFILES["signed-continuous"]);
    expect(zeros.isEmpty).toBe(true);
    expect([zeros.displayMin, zeros.displayMax]).toEqual([0, 1]);
  });
});
