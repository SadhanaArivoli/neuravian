import { describe, expect, it, vi } from "vitest";
import { commandForPreset, validateLaunchCommand, validateVolumeGeometry } from "../src/main/viewer-manager.js";

describe("desktop viewer launch security", () => {
  it("accepts cached artifact paths and preserves argument arrays", () => {
    const result = validateLaunchCommand({
      viewerId: "mricrogl",
      executable: "/Applications/MRIcroGL.app/Contents/MacOS/MRIcroGL",
      args: ["/cache/run-7/artifacts/anat/T1w.nii.gz"],
    }, "/cache");
    expect(result.args).toEqual(["/cache/run-7/artifacts/anat/T1w.nii.gz"]);
  });

  it("rejects host paths outside the managed cache", () => {
    expect(() => validateLaunchCommand({
      viewerId: "freeview",
      executable: "/opt/freesurfer/bin/freeview",
      args: ["-v", "/etc/passwd"],
    }, "/cache")).toThrow("NeuroForge cache");
  });

  it("rejects relative executables", () => {
    expect(() => validateLaunchCommand({
      viewerId: "mricrogl", executable: "MRIcroGL", args: [],
    }, "/cache")).toThrow("absolute path");
  });

  it("generates FreeView commands from cache-scoped relative artifacts", () => {
    const command = commandForPreset({
      viewerId: "freeview",
      runId: 7,
      files: [
        { relativePath: "mri/orig_nu.mgz" },
        { relativePath: "mri/aseg.auto.mgz", overlay: true },
      ],
      opacity: 0.7,
      freesurferLut: true,
    }, "/opt/freesurfer/bin/freeview", "/cache");
    expect(command.args).toEqual([
      "-v",
      "/cache/run-7/artifacts/mri/orig_nu.mgz",
      "/cache/run-7/artifacts/mri/aseg.auto.mgz:opacity=0.7:colormap=lut",
    ]);
  });

  it("rejects traversal before command generation", () => {
    expect(() => commandForPreset({
      viewerId: "mricrogl", runId: 7, files: [{ relativePath: "../outside.nii.gz" }],
    }, "/usr/bin/MRIcroGL", "/cache")).toThrow("unsafe artifact path");
  });

  it("blocks paired volumes with mismatched geometry", () => {
    expect(() => validateVolumeGeometry(["base.nii.gz", "mask.nii.gz"], [
      { relativePath: "base.nii.gz", geometry: { shape: [10, 10, 10], voxelSize: [1, 1, 1] } },
      { relativePath: "mask.nii.gz", geometry: { shape: [9, 10, 10], voxelSize: [1, 1, 1] } },
    ])).toThrow("do not share identical geometry");
  });

  it("accepts paired volumes only when complete geometry matches", () => {
    const geometry = {
      shape: [10, 10, 10], voxelSize: [1, 1, 1], orientation: ["R", "A", "S"],
      affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    };
    expect(() => validateVolumeGeometry(["base.nii.gz", "mask.nii.gz"], [
      { relativePath: "base.nii.gz", geometry },
      { relativePath: "mask.nii.gz", geometry },
    ])).not.toThrow();
  });
});
