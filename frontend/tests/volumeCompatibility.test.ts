import { describe, expect, it } from "vitest";
import { checkVolumeCompatibility, type VolumeGeometry } from "../src/lib/volumeCompatibility";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const base: VolumeGeometry = {
  dimensions: [64, 64, 40], voxelSize: [3, 3, 3], affine: identity,
  orientation: [1, 2, 3], coordinateSpace: "MNI152NLin2009cAsym",
};

describe("anatomical underlay compatibility", () => {
  it("accepts exact geometry and coordinate-space matches", () => {
    expect(checkVolumeCompatibility(base, { ...base })).toMatchObject({ compatible: true, spaceInferredFromAffine: false });
  });

  it.each([
    ["dimensions", { dimensions: [65, 64, 40] }, "dimensions differ"],
    ["voxel size", { voxelSize: [2, 3, 3] }, "voxel sizes differ"],
    ["affine", { affine: [...identity.slice(0, 12), 2, 0, 0, 1] }, "affine transforms differ"],
    ["orientation", { orientation: [2, 1, 3] }, "voxel orientations differ"],
    ["space", { coordinateSpace: "native" }, "coordinate spaces differ"],
  ])("rejects incompatible %s", (_name, patch, reason) => {
    expect(checkVolumeCompatibility(base, { ...base, ...patch })).toMatchObject({ compatible: false, reason: expect.stringContaining(reason) });
  });

  it("does not guess when affine metadata is absent", () => {
    expect(checkVolumeCompatibility(base, { ...base, affine: [] })).toMatchObject({ compatible: false, reason: "affine metadata is unavailable" });
  });

  it("documents when coordinate space is inferred from a matching affine", () => {
    expect(checkVolumeCompatibility({ ...base, coordinateSpace: undefined }, { ...base, coordinateSpace: undefined }))
      .toMatchObject({ compatible: true, spaceInferredFromAffine: true });
  });
});
