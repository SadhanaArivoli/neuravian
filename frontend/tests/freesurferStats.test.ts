import { describe, expect, it } from "vitest";
import { parseFreeSurferStats } from "../src/lib/freesurferStats";

describe("FreeSurfer statistics parsing", () => {
  it("parses aseg region IDs, names, voxel counts, volumes, and measures with units", () => {
    const parsed = parseFreeSurferStats(`# Measure BrainSeg, BrainSegVol, Brain Segmentation Volume, 12345.5, mm^3
# ColHeaders Index SegId NVoxels Volume_mm3 StructName normMean normStdDev normMin normMax normRange
1 2 100 100.5 Left-Cerebral-White-Matter 80 2 1 100 99
2 41 120 121.5 Right-Cerebral-White-Matter 81 2 1 100 99`);
    expect(parsed.measures[0]).toMatchObject({ name: "BrainSeg", value: 12345.5, units: "mm^3" });
    expect(parsed.rows[0]).toMatchObject({ segmentationId: 2, voxelCount: 100, volumeMm3: 100.5, name: "Left-Cerebral-White-Matter", hemisphere: "left" });
    expect(parsed.rows[1].hemisphere).toBe("right");
  });

  it("uses standard FastSurfer aseg columns when ColHeaders is absent", () => {
    const parsed = parseFreeSurferStats("1 17 50 51.25 Left-Hippocampus 70 2 1 99 98");
    expect(parsed.rows[0]).toMatchObject({ segmentationId: 17, name: "Left-Hippocampus", volumeMm3: 51.25 });
  });

  it("guards oversized previews", () => {
    expect(() => parseFreeSurferStats("x".repeat(5_000_001))).toThrow("5 MB");
  });
});
