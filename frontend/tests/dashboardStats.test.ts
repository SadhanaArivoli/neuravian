import { describe, expect, it } from "vitest";
import type { DatasetArtifact, DashboardRecentRun } from "../src/api/client";
import {
  buildArtifactLineage,
  artifactRelativePath,
  artifactFileUrl,
  resolvePreviewKind,
  filterArtifacts,
  sortArtifacts,
  uniqueArtifactTypes,
  uniqueArtifactPipelines,
  fmtBytes,
  fmtSeconds,
  DEFAULT_ARTIFACT_FILTERS,
} from "../src/lib/dashboardStats";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeArtifact(
  overrides: Partial<DatasetArtifact> & { run_id: number; type: string },
): DatasetArtifact {
  return {
    pipeline_id: "mriqc",
    pipeline_version: "24.0.0",
    run_status: "success",
    run_started_at: "2025-01-01T10:00:00Z",
    run_finished_at: "2025-01-01T10:01:00Z",
    source_run_id: null,
    label: overrides.type,
    description: "",
    resolution_source: "output_dir",
    multiple: false,
    path: `/app/data/derivatives/mriqc/${overrides.run_id}/output.html`,
    is_directory: false,
    size_bytes: 1024,
    output_dir: `/app/data/derivatives/mriqc/${overrides.run_id}`,
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<DashboardRecentRun> & { id: number },
): DashboardRecentRun {
  return {
    pipeline_manifest_id: "mriqc",
    pipeline_version: "24.0.0",
    dataset_id: 1,
    status: "success",
    source_run_id: null,
    started_at: "2025-01-01T10:00:00Z",
    finished_at: "2025-01-01T10:01:00Z",
    created_at: "2025-01-01T10:00:00Z",
    ...overrides,
  };
}

// ── fmtBytes ─────────────────────────────────────────────────────────────────

describe("fmtBytes", () => {
  it("formats 0 bytes", () => expect(fmtBytes(0)).toBe("0 B"));
  it("formats bytes", () => expect(fmtBytes(512)).toBe("512 B"));
  it("formats kilobytes", () => expect(fmtBytes(1024)).toBe("1.0 KB"));
  it("formats megabytes", () => expect(fmtBytes(1024 * 1024)).toBe("1.0 MB"));
  it("formats gigabytes", () => expect(fmtBytes(1024 ** 3)).toBe("1.0 GB"));
});

// ── fmtSeconds ───────────────────────────────────────────────────────────────

describe("fmtSeconds", () => {
  it("formats sub-minute", () => expect(fmtSeconds(45)).toBe("45s"));
  it("formats minutes", () => expect(fmtSeconds(90)).toBe("1m 30s"));
  it("formats exact minutes", () => expect(fmtSeconds(120)).toBe("2m"));
  it("formats hours", () => expect(fmtSeconds(3661)).toBe("1h 1m"));
  it("formats exact hours", () => expect(fmtSeconds(7200)).toBe("2h"));
});

// ── filterArtifacts ───────────────────────────────────────────────────────────

describe("filterArtifacts", () => {
  const artifacts = [
    makeArtifact({ run_id: 1, type: "mriqc_report", pipeline_id: "mriqc", is_directory: false, size_bytes: 500 }),
    makeArtifact({ run_id: 2, type: "connectivity_matrix_csv", pipeline_id: "functional-connectivity", is_directory: false, size_bytes: 2000, path: "/app/data/derivatives/functional-connectivity/2/matrix.csv", output_dir: "/app/data/derivatives/functional-connectivity/2" }),
    makeArtifact({ run_id: 3, type: "freesurfer_dir", pipeline_id: "freesurfer", is_directory: true, size_bytes: 50000000 }),
  ];

  it("returns all with default filters", () => {
    expect(filterArtifacts(artifacts, DEFAULT_ARTIFACT_FILTERS)).toHaveLength(3);
  });

  it("filters by artifact type", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, artifactType: "mriqc_report" });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("mriqc_report");
  });

  it("filters by pipeline", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, pipeline: "mriqc" });
    expect(out).toHaveLength(1);
  });

  it("filters files only", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, fileKind: "file" });
    expect(out.every((a) => !a.is_directory)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("filters directories only", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, fileKind: "directory" });
    expect(out.every((a) => a.is_directory)).toBe(true);
    expect(out).toHaveLength(1);
  });

  it("filters by search matching label", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, search: "mriqc_report" });
    expect(out).toHaveLength(1);
  });

  it("filters by search matching run id", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, search: "2" });
    expect(out.some((a) => a.run_id === 2)).toBe(true);
  });

  it("search is case-insensitive", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, search: "MRIQC" });
    expect(out.length).toBeGreaterThan(0);
  });

  it("returns empty for no matches", () => {
    const out = filterArtifacts(artifacts, { ...DEFAULT_ARTIFACT_FILTERS, search: "xyznotfound" });
    expect(out).toHaveLength(0);
  });
});

// ── sortArtifacts ─────────────────────────────────────────────────────────────

describe("sortArtifacts", () => {
  const artifacts = [
    makeArtifact({ run_id: 1, type: "a", size_bytes: 100, run_finished_at: "2025-01-01T10:00:00Z", pipeline_id: "brainchop" }),
    makeArtifact({ run_id: 2, type: "b", size_bytes: 5000, run_finished_at: "2025-01-03T10:00:00Z", pipeline_id: "mriqc" }),
    makeArtifact({ run_id: 3, type: "c", size_bytes: 200, run_finished_at: "2025-01-02T10:00:00Z", pipeline_id: "freesurfer" }),
  ];

  it("sorts newest first", () => {
    const out = sortArtifacts(artifacts, "newest");
    expect(out[0].run_id).toBe(2);
    expect(out[2].run_id).toBe(1);
  });

  it("sorts oldest first", () => {
    const out = sortArtifacts(artifacts, "oldest");
    expect(out[0].run_id).toBe(1);
  });

  it("sorts largest first", () => {
    const out = sortArtifacts(artifacts, "largest");
    expect(out[0].size_bytes).toBe(5000);
  });

  it("sorts smallest first", () => {
    const out = sortArtifacts(artifacts, "smallest");
    expect(out[0].size_bytes).toBe(100);
  });

  it("sorts by pipeline alphabetically", () => {
    const out = sortArtifacts(artifacts, "pipeline");
    expect(out[0].pipeline_id).toBe("brainchop");
  });

  it("sorts by type alphabetically", () => {
    const out = sortArtifacts(artifacts, "type");
    expect(out[0].type).toBe("a");
  });
});

// ── uniqueArtifactTypes / uniqueArtifactPipelines ────────────────────────────

describe("uniqueArtifactTypes", () => {
  it("returns sorted unique types", () => {
    const artifacts = [
      makeArtifact({ run_id: 1, type: "mriqc_report" }),
      makeArtifact({ run_id: 2, type: "connectivity_matrix_csv" }),
      makeArtifact({ run_id: 3, type: "mriqc_report" }),
    ];
    expect(uniqueArtifactTypes(artifacts)).toEqual(["connectivity_matrix_csv", "mriqc_report"]);
  });

  it("returns empty for no artifacts", () => {
    expect(uniqueArtifactTypes([])).toEqual([]);
  });
});

describe("uniqueArtifactPipelines", () => {
  it("returns sorted unique pipelines", () => {
    const artifacts = [
      makeArtifact({ run_id: 1, type: "a", pipeline_id: "mriqc" }),
      makeArtifact({ run_id: 2, type: "b", pipeline_id: "freesurfer" }),
      makeArtifact({ run_id: 3, type: "c", pipeline_id: "mriqc" }),
    ];
    expect(uniqueArtifactPipelines(artifacts)).toEqual(["freesurfer", "mriqc"]);
  });
});

// ── artifactRelativePath ─────────────────────────────────────────────────────

describe("artifactRelativePath", () => {
  it("strips the output_dir prefix", () => {
    const a = makeArtifact({
      run_id: 1,
      type: "mriqc_report",
      path: "/app/data/derivatives/mriqc/1/report.html",
      output_dir: "/app/data/derivatives/mriqc/1",
    });
    expect(artifactRelativePath(a)).toBe("report.html");
  });

  it("handles trailing slash in output_dir", () => {
    const a = makeArtifact({
      run_id: 1,
      type: "t",
      path: "/out/sub/file.csv",
      output_dir: "/out/",
    });
    expect(artifactRelativePath(a)).toBe("sub/file.csv");
  });

  it("returns full path when output_dir does not match", () => {
    const a = makeArtifact({
      run_id: 1,
      type: "t",
      path: "/other/file.csv",
      output_dir: "/out",
    });
    expect(artifactRelativePath(a)).toBe("/other/file.csv");
  });
});

// ── artifactFileUrl ──────────────────────────────────────────────────────────

describe("artifactFileUrl", () => {
  it("constructs correct API URL", () => {
    const a = makeArtifact({
      run_id: 42,
      type: "mriqc_report",
      path: "/app/data/derivatives/mriqc/42/report.html",
      output_dir: "/app/data/derivatives/mriqc/42",
    });
    expect(artifactFileUrl(a)).toBe("/api/runs/42/files/report.html");
  });
});

// ── resolvePreviewKind ───────────────────────────────────────────────────────

describe("resolvePreviewKind", () => {
  const base = makeArtifact({ run_id: 1, type: "t", is_directory: false });

  it("detects nifti (.nii.gz)", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/brain.nii.gz" })).toBe("nifti");
  });

  it("detects nifti (.nii)", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/brain.nii" })).toBe("nifti");
  });

  it("detects html", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/report.html" })).toBe("html");
  });

  it("detects connectivity matrix csv by type", () => {
    expect(
      resolvePreviewKind({ ...base, type: "connectivity_matrix_csv", path: "/out/m.csv" }),
    ).toBe("connectivity_matrix");
  });

  it("detects image png", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/heatmap.png" })).toBe("image");
  });

  it("routes connectivity_matrix_png type to image, not matrix", () => {
    expect(
      resolvePreviewKind({ ...base, type: "connectivity_matrix_png", path: "/out/heatmap.png" }),
    ).toBe("image");
  });

  it("detects tsv", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/data.tsv" })).toBe("tsv");
  });

  it("detects json", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/params.json" })).toBe("json");
  });

  it("returns none for directories", () => {
    expect(resolvePreviewKind({ ...base, is_directory: true, path: "/out/" })).toBe("none");
  });

  it("returns none for unknown extensions", () => {
    expect(resolvePreviewKind({ ...base, path: "/out/file.npy" })).toBe("none");
  });
});

// ── buildArtifactLineage ─────────────────────────────────────────────────────

describe("buildArtifactLineage", () => {
  it("builds a single-step lineage for a root artifact", () => {
    const artifact = makeArtifact({ run_id: 1, type: "mriqc_report" });
    const runs = [makeRun({ id: 1 })];
    const steps = buildArtifactLineage(artifact, runs, "My Dataset");
    expect(steps[0].kind).toBe("dataset");
    expect(steps[0].label).toBe("My Dataset");
    expect(steps[1].kind).toBe("run");
    expect(steps[1].runId).toBe(1);
    expect(steps[steps.length - 1].kind).toBe("artifact");
    expect(steps[steps.length - 1].label).toBe("mriqc_report");
  });

  it("includes upstream run in lineage chain", () => {
    const parent = makeRun({ id: 10, source_run_id: null });
    const child = makeRun({ id: 20, source_run_id: 10, pipeline_manifest_id: "freesurfer" });
    const artifact = makeArtifact({ run_id: 20, type: "freesurfer_dir" });
    const steps = buildArtifactLineage(artifact, [parent, child], "DS");
    const runSteps = steps.filter((s) => s.kind === "run");
    expect(runSteps).toHaveLength(2);
    expect(runSteps[0].runId).toBe(10); // upstream first
    expect(runSteps[1].runId).toBe(20); // producing run last
  });

  it("handles missing producing run gracefully", () => {
    const artifact = makeArtifact({ run_id: 999, type: "t" });
    const steps = buildArtifactLineage(artifact, [], "DS");
    expect(steps[1].kind).toBe("run");
    expect(steps[1].runId).toBe(999);
  });
});
