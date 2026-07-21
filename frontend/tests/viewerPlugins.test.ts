import { describe, expect, it } from "vitest";
import { classifyNeuroArtifact } from "../src/lib/neuroArtifactView";
import {
  VIEWER_REGISTRY,
  browserViewerAvailability,
  compatibleViewers,
  createLaunchPreset,
  viewerPlugin,
} from "../src/lib/viewerPlugins";

describe("viewer plugin registry", () => {
  it("registers the built-in viewer first and external viewers independently", () => {
    expect(VIEWER_REGISTRY.map((plugin) => plugin.id)).toEqual(["neuroforge", "freeview", "mricrogl"]);
  });

  it("disables desktop viewers in browser deployments with a synchronization explanation", () => {
    expect(browserViewerAvailability(viewerPlugin("freeview"))).toMatchObject({
      availability: "browser-unavailable",
      executable: null,
    });
    expect(browserViewerAvailability(viewerPlugin("freeview")).reason).toContain("Sync this run");
  });

  it("declares role and format compatibility", () => {
    const segmentation = classifyNeuroArtifact({ name: "aseg.auto.mgz", path: "mri/aseg.auto.mgz" }, "fastsurfer");
    expect(compatibleViewers(segmentation).map((plugin) => plugin.id)).toEqual([
      "neuroforge", "freeview", "mricrogl",
    ]);
    const report = classifyNeuroArtifact({ name: "report.html", path: "report.html" }, "fmriprep");
    expect(compatibleViewers(report).map((plugin) => plugin.id)).toEqual(["neuroforge"]);
  });
});

describe("viewer pairing and commands", () => {
  const anatomy = classifyNeuroArtifact({ name: "orig_nu.mgz", path: "mri/orig_nu.mgz" }, "fastsurfer");
  const segmentation = classifyNeuroArtifact({ name: "aseg.auto.mgz", path: "mri/aseg.auto.mgz" }, "fastsurfer");

  it("pairs a compatible anatomy underlay without resampling", () => {
    const preset = createLaunchPreset(segmentation, [anatomy, segmentation]);
    expect(preset.files.map((file) => file.path)).toEqual(["mri/orig_nu.mgz", "mri/aseg.auto.mgz"]);
    expect(preset.interpolation).toBe("nearest");
    expect(preset.lut).toBe("freesurfer");
  });

  it("generates argument arrays rather than shell command strings", () => {
    const preset = createLaunchPreset(segmentation, [anatomy, segmentation]);
    const command = viewerPlugin("freeview").buildCommand(
      { viewerId: "freeview", availability: "available", executable: "/opt/freesurfer/bin/freeview", reason: null },
      preset,
    );
    expect(command.executable).toBe("/opt/freesurfer/bin/freeview");
    expect(command.args).toEqual([
      "-v",
      "mri/orig_nu.mgz",
      "mri/aseg.auto.mgz:opacity=0.7:colormap=lut",
    ]);
  });

  it("rejects traversal in launch paths", () => {
    const preset = createLaunchPreset(segmentation, [segmentation]);
    preset.files[0].path = "../../etc/passwd";
    expect(() => viewerPlugin("mricrogl").buildCommand(
      { viewerId: "mricrogl", availability: "available", executable: "/usr/bin/MRIcroGL", reason: null },
      preset,
    )).toThrow("unsafe artifact path");
  });
});
