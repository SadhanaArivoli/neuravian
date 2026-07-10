import { describe, expect, it } from "vitest";
import {
  compareRoiStatistics,
  filterRoiStatistics,
  normalizeRoiStatisticsJson,
  parseRoiStatisticsCsv,
  roiStatisticsToCsv,
  sortRoiStatistics,
  type RoiStatistic,
} from "../src/lib/roiStatistics";

const rows: RoiStatistic[] = [
  {
    roi_number: 1,
    roi_label: "7Networks_LH_Vis_1",
    network: "Vis",
    voxel_count: 120,
    mean_signal: 0.5,
    std_signal: 0.1,
    min_signal: 0.2,
    max_signal: 0.8,
    median_signal: 0.55,
  },
  {
    roi_number: 2,
    roi_label: "7Networks_LH_Default_1",
    network: "Default",
    voxel_count: 80,
    mean_signal: -0.25,
    std_signal: 0.2,
    min_signal: -0.6,
    max_signal: 0.1,
    median_signal: -0.2,
  },
];

describe("ROI statistics helpers", () => {
  it("parses CSV rows and normalizes nullable networks", () => {
    const parsed = parseRoiStatisticsCsv(
      "roi_number,roi_label,network,voxel_count,mean_signal,std_signal,min_signal,max_signal,median_signal\n" +
      '1,"7Networks_LH_Vis_1",Vis,120,0.5,0.1,0.2,0.8,0.55\n' +
      "2,AAL Frontal,,80,-0.25,0.2,-0.6,0.1,-0.2\n",
    );

    expect(parsed[0]).toMatchObject({ roi_number: 1, network: "Vis", voxel_count: 120 });
    expect(parsed[1]).toMatchObject({ roi_label: "AAL Frontal", network: null });
  });

  it("normalizes JSON rows", () => {
    expect(normalizeRoiStatisticsJson([{ roi_number: "3", roi_label: "ROI", voxel_count: "42" }])).toEqual([
      {
        roi_number: 3,
        roi_label: "ROI",
        network: null,
        voxel_count: 42,
        mean_signal: 0,
        std_signal: 0,
        min_signal: 0,
        max_signal: 0,
        median_signal: 0,
      },
    ]);
  });

  it("filters by search text and network", () => {
    expect(filterRoiStatistics(rows, "default", "")).toHaveLength(1);
    expect(filterRoiStatistics(rows, "", "Vis")).toEqual([rows[0]]);
  });

  it("sorts numeric and text fields", () => {
    expect(sortRoiStatistics(rows, "mean_signal", "desc").map((row) => row.roi_number)).toEqual([1, 2]);
    expect(sortRoiStatistics(rows, "roi_label", "asc").map((row) => row.roi_number)).toEqual([2, 1]);
  });

  it("exports valid CSV text", () => {
    const csv = roiStatisticsToCsv(rows);
    expect(csv).toContain("roi_number,roi_label,network,voxel_count");
    expect(csv).toContain("7Networks_LH_Default_1");
  });

  it("compares matched ROI mean signals without hypothesis testing", () => {
    const comparison = compareRoiStatistics(rows, [
      { ...rows[0], mean_signal: 0.25 },
      { ...rows[1], mean_signal: -0.75 },
    ]);

    expect(comparison.count).toBe(2);
    expect(comparison.meanDifference).toBeCloseTo(0.375);
    expect(comparison.meanAbsoluteDifference).toBeCloseTo(0.375);
    expect(comparison.largestDifferences[0].roi_label).toBe("7Networks_LH_Default_1");
  });
});
