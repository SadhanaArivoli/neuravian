import { describe, expect, it } from "vitest";
import { artifactAvailabilityLabel, normalizeArtifact } from "../src/lib/artifactViewing";

const examples = [
  ["sub-01_T1w.nii.gz", "neuroimage"],
  ["sub-01.html", "report"],
  ["sub-01/figures/reportlet.svg", "image"],
  ["sub-01/anat/metrics.json", "structured"],
  ["sub-01/func/confounds.tsv", "structured"],
  ["sub-01/surf/lh.pial", "surface"],
  ["unknown.bin", "download"],
] as const;

describe("canonical artifact viewing contract", () => {
  it.each(examples)("selects %s by capability, independent of origin", (relativePath, viewer) => {
    const name = relativePath.split("/").pop()!;
    const local = normalizeArtifact({ id: 1, name, relativePath, origin: "local", contentUrl: `/api/runs/1/files/${relativePath}` });
    const cloud = normalizeArtifact({ id: "cloud-1", name, relativePath, origin: "cloud", availability: "streaming" });
    const synchronized = normalizeArtifact({ id: "cached-1", name, relativePath, origin: "synchronized", materialized: true });

    expect(local.viewer).toBe(viewer);
    expect(cloud.viewer).toBe(viewer);
    expect(synchronized.viewer).toBe(viewer);
    expect(local.view.kind).toBe(cloud.view.kind);
    expect(cloud.view.kind).toBe(synchronized.view.kind);
  });

  it("normalizes transport state without changing viewer selection", () => {
    const base = { id: 1, name: "sub-01_T1w.nii.gz", relativePath: "sub-01/anat/sub-01_T1w.nii.gz" };
    const local = normalizeArtifact({ ...base, origin: "local" });
    const remote = normalizeArtifact({ ...base, origin: "remote", availability: "synchronizing" });
    expect(local.viewer).toBe(remote.viewer);
    expect(artifactAvailabilityLabel(local)).toBe("Available locally");
    expect(artifactAvailabilityLabel(remote)).toBe("Synchronizing");
  });

  it("uses one unavailable state and does not claim partial content is complete", () => {
    const artifact = normalizeArtifact({
      id: 3,
      name: "sub-01.html",
      relativePath: "sub-01.html",
      origin: "cloud",
      availability: "error",
      materialized: false,
    });
    expect(artifact.viewer).toBe("report");
    expect(artifactAvailabilityLabel(artifact)).toBe("Temporarily unavailable");
  });
});
