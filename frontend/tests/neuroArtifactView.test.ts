import { describe, expect, it } from "vitest";
import {
  artifactEntityCompatible,
  classifyNeuroArtifact,
  preferredArtifactBase,
} from "../src/lib/neuroArtifactView";

const file = (path: string) => ({ path, name: path.split("/").pop()! });
const classify = (path: string, pipeline = "fmriprep") => classifyNeuroArtifact(file(path), pipeline);

describe("unified neuroimaging artifact classification", () => {
  it.each([
    ["sub-x/anat/sub-x_desc-preproc_T1w.nii.gz", "structural", "structural-intensity"],
    ["sub-x/anat/sub-x_desc-brain_mask.nii.gz", "binary-mask", "binary-mask"],
    ["sub-x/anat/sub-x_dseg.nii.gz", "discrete-segmentation", "discrete-label"],
    ["sub-x/anat/sub-x_label-GM_probseg.nii.gz", "probability-map", "probability"],
    ["sub-x/func/sub-x_task-rest_boldref.nii.gz", "functional-reference", "functional-intensity"],
    ["sub-x/func/sub-x_task-rest_desc-preproc_bold.nii.gz", "functional-timeseries", "functional-timeseries"],
    ["sub-x/anat/sub-x_zstat.nii.gz", "statistical-map", "signed-statistical"],
  ])("classifies %s", (path, role, profile) => {
    const artifact = classify(path);
    expect(artifact.role).toBe(role);
    expect(artifact.displayProfile).toBe(profile);
    expect(artifact.canView).toBe(true);
  });

  it.each([
    ["sub-x/mri/orig.mgz", "structural", "Conformed Anatomy"],
    ["sub-x/mri/aseg.auto.mgz", "discrete-segmentation", "Brain and Tissue Segmentations"],
    ["sub-x/mri/aparc.DKTatlas+aseg.deep.mgz", "discrete-segmentation", "Cortical Parcellations"],
    ["sub-x/mri/wmparc.mgz", "discrete-segmentation", "Cortical Parcellations"],
    ["sub-x/mri/ribbon.mgz", "discrete-segmentation", "Cortical Parcellations"],
    ["sub-x/mri/cerebellum.CerebNet.nii.gz", "discrete-segmentation", "Cerebellar Segmentation"],
    ["sub-x/mri/hypothalamus.HypVINN.nii.gz", "discrete-segmentation", "Hypothalamic Segmentation"],
  ])("classifies FastSurfer artifact %s", (path, role, section) => {
    const artifact = classify(path, "fastsurfer");
    expect(artifact.role).toBe(role);
    expect(artifact.section).toBe(section);
  });

  it("does not mistake a stats file named .mgz for a volume", () => {
    const artifact = classify("sub-x/stats/aseg.auto.mgz", "fastsurfer");
    expect(artifact.kind).toBe("statistics");
    expect(artifact.canOverlay).toBe(false);
  });

  it.each([
    ["sub-x/surf/lh.white", "surface", "left"],
    ["sub-x/surf/rh.pial", "surface", "right"],
    ["sub-x/surf/lh.inflated", "surface", "left"],
    ["sub-x/surf/callosum.surf", "surface", null],
    ["sub-x/surf/lh.pial.surf.gii", "surface", "left"],
  ])("classifies surface %s", (path, kind, hemisphere) => {
    const artifact = classify(path, "fastsurfer");
    expect(artifact.kind).toBe(kind);
    expect(artifact.hemisphere).toBe(hemisphere);
    expect(artifact.canView).toBe(true);
  });

  it.each([
    ["sub-x/label/lh.aparc.annot", "annotation"],
    ["sub-x/label/rh.cortex.label", "annotation"],
    ["sub-x/surf/lh.curv.shape.gii", "surface-overlay"],
    ["sub-x/surf/lh.thickness.w", "surface-overlay"],
    ["sub-x/surf/lh.thickness", "surface-overlay"],
  ])("requires a surface for %s", (path, kind) => {
    const artifact = classify(path, "fastsurfer");
    expect(artifact.kind).toBe(kind);
    expect(artifact.canView).toBe(false);
    expect(artifact.unsupportedReason).toContain("surface geometry");
  });

  it.each([
    ["sub-x/anat/from-T1w_to-MNI_xfm.h5", "transform"],
    ["sub-x/mri/transforms/register.lta", "transform"],
    ["sub-x/func/confounds.tsv", "table"],
    ["sub-x/stats/aseg.stats", "statistics"],
    ["sub-x/scripts/deep-seg.log", "log"],
    ["sub-x/report.html", "report"],
    ["sub-x/figures/coreg.svg", "image"],
  ])("correctly classifies non-volume %s", (path, kind) => {
    expect(classify(path, path.includes("mri/") ? "fastsurfer" : "fmriprep").kind).toBe(kind);
  });

  it("pairs only matching BIDS entities and spaces", () => {
    const native = classify("sub-x/anat/sub-x_desc-preproc_T1w.nii.gz");
    const nativeDseg = classify("sub-x/anat/sub-x_dseg.nii.gz");
    const mniDseg = classify("sub-x/anat/sub-x_space-MNI_dseg.nii.gz");
    expect(artifactEntityCompatible(native, nativeDseg)).toBe(true);
    expect(artifactEntityCompatible(native, mniDseg)).toBe(false);
    expect(preferredArtifactBase(nativeDseg, [native])).toBe(native);
  });

  it("never pairs functional artifacts across task or run", () => {
    const base = classify("sub-x/func/sub-x_task-rest_run-1_boldref.nii.gz");
    const mask = classify("sub-x/func/sub-x_task-rest_run-2_desc-brain_mask.nii.gz");
    expect(artifactEntityCompatible(base, mask)).toBe(false);
  });

  it("marks MGZ and MGH for bounded client conversion", () => {
    expect(classify("sub-x/mri/orig.mgz", "fastsurfer").requiresClientConversion).toBe(true);
    expect(classify("sub-x/mri/orig.mgh", "fastsurfer").requiresClientConversion).toBe(true);
  });

  it("keeps transform artifacts metadata-only", () => {
    const artifact = classify("sub-x/anat/from-native_to-template_xfm.mat");
    expect(artifact.canView).toBe(false);
    expect(artifact.unsupportedReason).toContain("never treated as image volumes");
  });
});
