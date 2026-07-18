import { describe, expect, it, vi } from "vitest";
import { validateLaunchCommand } from "../src/main/viewer-manager.js";

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
});
