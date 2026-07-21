import { describe, expect, it } from "vitest";
import {
  resolveArtifactCapabilities,
  selectGeometryCompatibleArtifacts,
  classifyArtifactRole,
  selectDefaultViewerScene,
  type ArtifactSemanticRole,
} from "../src/lib/artifact-capabilities";

const geometry = (shape: number[]) => ({
  shape,
  voxelSize: [1, 1, 1],
  orientation: ["R", "A", "S"],
  affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
});

function artifact(relativePath: string, overrides: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    artifactId: Math.random(),
    relativePath,
    url: `/${relativePath}`,
    sha256: "0".repeat(64),
    sizeBytes: 1000,
    geometry: null,
    ...overrides,
  };
}

describe("artifact capability resolution", () => {
  it("classifies fMRIPrep and pydeface volumes by file type", () => {
    expect(resolveArtifactCapabilities("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz").viewableIn)
      .toEqual(["freeview", "mricrogl", "neuroforge-viewer"]);
    expect(resolveArtifactCapabilities("defaced.nii.gz").isVolume).toBe(true);
    expect(resolveArtifactCapabilities("sub-01.html").isReport).toBe(true);
  });

  it("selects only volumes with identical recorded geometry", () => {
    const artifacts: WorkspaceRun["artifacts"] = [
      { artifactId: 1, relativePath: "native.nii.gz", url: "/1", sha256: "1", sizeBytes: 1, geometry: geometry([10, 10, 10]) },
      { artifactId: 2, relativePath: "native_mask.nii.gz", url: "/2", sha256: "2", sizeBytes: 1, geometry: geometry([10, 10, 10]) },
      { artifactId: 3, relativePath: "mni.nii.gz", url: "/3", sha256: "3", sizeBytes: 1, geometry: geometry([20, 20, 20]) },
    ];
    expect(selectGeometryCompatibleArtifacts(artifacts).map((a) => a.relativePath))
      .toEqual(["native.nii.gz", "native_mask.nii.gz"]);
  });
});

describe("classifyArtifactRole", () => {
  // 1. fMRIPrep preprocessed T1w — native space (no space entity)
  it("classifies fMRIPrep native T1w as anatomical-intensity", () => {
    expect(classifyArtifactRole(artifact("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz")))
      .toBe("anatomical-intensity");
  });

  // 2. pydeface output — defaced pattern
  it("classifies defaced.nii.gz as defaced-intensity", () => {
    expect(classifyArtifactRole(artifact("defaced.nii.gz")))
      .toBe("defaced-intensity");
  });

  // 3. Defaced with underscore prefix (e.g. pydeface with custom outfile)
  it("classifies *_defaced.nii.gz as defaced-intensity", () => {
    expect(classifyArtifactRole(artifact("sub-01/anat/sub-01_T1w_defaced.nii.gz")))
      .toBe("defaced-intensity");
  });

  // 4. fMRIPrep brain mask — suffix=mask
  it("classifies brain mask NIfTI as mask", () => {
    expect(classifyArtifactRole(artifact("sub-01/anat/sub-01_desc-brain_mask.nii.gz")))
      .toBe("mask");
  });

  // 5. fMRIPrep discrete segmentation — suffix=dseg
  it("classifies dseg NIfTI as segmentation", () => {
    expect(classifyArtifactRole(artifact("sub-01/anat/sub-01_dseg.nii.gz")))
      .toBe("segmentation");
  });

  // 6. fMRIPrep BOLD run — suffix=bold
  it("classifies BOLD NIfTI as functional-intensity", () => {
    expect(classifyArtifactRole(artifact("sub-01/func/sub-01_task-rest_space-T1w_desc-preproc_bold.nii.gz")))
      .toBe("functional-intensity");
  });

  // 7. FreeSurfer orig.mgz
  it("classifies orig.mgz as anatomical-intensity", () => {
    expect(classifyArtifactRole(artifact("sub-01/mri/orig.mgz")))
      .toBe("anatomical-intensity");
  });

  // 8. FreeSurfer aseg.mgz
  it("classifies aseg.mgz as segmentation", () => {
    expect(classifyArtifactRole(artifact("sub-01/mri/aseg.mgz")))
      .toBe("segmentation");
  });

  // 9. Spatial transform (.lta)
  it("classifies .lta as transform", () => {
    expect(classifyArtifactRole(artifact("sub-01/transforms/sub-01_from-T1w_to-MNI_mode-image.lta")))
      .toBe("transform");
  });

  // 10. HTML report
  it("classifies HTML as report", () => {
    expect(classifyArtifactRole(artifact("sub-01.html")))
      .toBe("report");
  });
});

// ── Phase 2: semanticRole persistence ────────────────────────────────────────

describe("semanticRole — stored role propagation", () => {
  // 1. semanticRole is used when present (no filename parsing)
  it("uses stored semanticRole instead of inferring from filename", () => {
    // A file named like a mask but tagged as anatomical-intensity at sync time.
    // selectDefaultViewerScene must honour the stored role, not re-derive it.
    const a = artifact("sub-01/anat/sub-01_mask.nii.gz", {
      semanticRole: "anatomical-intensity" as ArtifactSemanticRole,
    });
    const mask = artifact("sub-01/anat/sub-01_dseg.nii.gz");
    // With stored role, "mask.nii.gz" is anatomical-intensity (priority 1–2)
    // and beats the dseg (segmentation → priority ∞, fallback).
    expect(selectDefaultViewerScene([mask, a])).toBe(a);
  });

  // 2. Legacy artifacts without semanticRole still work via filename fallback
  it("falls back to classifyArtifactRole for legacy artifacts with no semanticRole", () => {
    const legacy = artifact("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz");
    // No semanticRole field — must still classify correctly from the filename.
    expect(classifyArtifactRole(legacy)).toBe("anatomical-intensity");
    expect(selectDefaultViewerScene([legacy])).toBe(legacy);
  });

  // 3. New artifacts with semanticRole never require runtime filename parsing
  it("new artifact with semanticRole set — classifyArtifactRole is a fallback only", () => {
    // Simulate what workspace-client stamps at sync time.
    const synced = artifact("outputs/some_result.nii.gz", {
      semanticRole: "functional-intensity" as ArtifactSemanticRole,
    });
    // classifyArtifactRole alone would return "unknown-volume" for this filename.
    expect(classifyArtifactRole(synced)).toBe("unknown-volume");
    // But selectDefaultViewerScene reads the stored role, not the inferred one.
    const dummy = artifact("sub-01/anat/sub-01_dseg.nii.gz");
    expect(selectDefaultViewerScene([dummy, synced])).toBe(synced);
  });

  // 4. fMRIPrep: desc-preproc_T1w is selected as primary scene
  it("fMRIPrep cloud run selects desc-preproc_T1w as default scene", () => {
    const t1 = artifact("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz", {
      semanticRole: "anatomical-intensity" as ArtifactSemanticRole,
    });
    const mask = artifact("sub-01/anat/sub-01_desc-brain_mask.nii.gz", {
      semanticRole: "mask" as ArtifactSemanticRole,
    });
    const seg = artifact("sub-01/anat/sub-01_dseg.nii.gz", {
      semanticRole: "segmentation" as ArtifactSemanticRole,
    });
    expect(selectDefaultViewerScene([mask, seg, t1])).toBe(t1);
  });

  // 5. pydeface: defaced.nii.gz wins over all other candidates
  it("pydeface cloud run selects defaced.nii.gz as default scene", () => {
    const defaced = artifact("defaced.nii.gz", {
      semanticRole: "defaced-intensity" as ArtifactSemanticRole,
    });
    const orig = artifact("sub-01/anat/sub-01_T1w.nii.gz", {
      semanticRole: "anatomical-intensity" as ArtifactSemanticRole,
    });
    expect(selectDefaultViewerScene([orig, defaced])).toBe(defaced);
  });
});

describe("selectDefaultViewerScene", () => {
  it("returns null for an empty list", () => {
    expect(selectDefaultViewerScene([])).toBeNull();
  });

  it("returns the only artifact for a single-item list", () => {
    const a = artifact("sub-01/anat/sub-01_T1w.nii.gz");
    expect(selectDefaultViewerScene([a])).toBe(a);
  });

  // fMRIPrep scenario: prefers native T1w over MNI-space version
  it("selects native anatomical over template-space anatomical", () => {
    const native = artifact("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz");
    const mni = artifact("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_desc-preproc_T1w.nii.gz");
    const mask = artifact("sub-01/anat/sub-01_desc-brain_mask.nii.gz");
    expect(selectDefaultViewerScene([mni, mask, native])).toBe(native);
  });

  // pydeface scenario: defaced wins over everything
  it("selects defaced-intensity with highest priority", () => {
    const defaced = artifact("defaced.nii.gz");
    const t1 = artifact("sub-01/anat/sub-01_T1w.nii.gz");
    expect(selectDefaultViewerScene([t1, defaced])).toBe(defaced);
  });

  // Only masks/segmentations: falls back to first artifact
  it("falls back to first artifact when all are excluded roles", () => {
    const mask = artifact("sub-01/anat/sub-01_mask.nii.gz");
    const seg = artifact("sub-01/anat/sub-01_dseg.nii.gz");
    expect(selectDefaultViewerScene([mask, seg])).toBe(mask);
  });

  // Anatomical beats functional
  it("selects anatomical over functional", () => {
    const bold = artifact("sub-01/func/sub-01_task-rest_desc-preproc_bold.nii.gz");
    const t1 = artifact("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz");
    expect(selectDefaultViewerScene([bold, t1])).toBe(t1);
  });
});
