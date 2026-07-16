import { describe, expect, it } from "vitest";
import {
  bidsPairCompatible,
  classifyFmriprepDerivative,
  fmriprepLayer,
  preferredBaseFor,
} from "../src/lib/fmriprepArtifacts";

const derive = (path: string, size = 100) => {
  const parts = path.split("/");
  return classifyFmriprepDerivative({ name: parts[parts.length - 1], path, size });
};

describe("fMRIPrep derivative classification", () => {
  it("classifies anatomical derivatives and their scientific semantics", () => {
    const t1 = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_desc-preproc_T1w.nii.gz");
    const mask = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_desc-brain_mask.nii.gz");
    const dseg = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_dseg.nii.gz");
    const probability = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_label-GM_probseg.nii.gz");

    expect(t1).toMatchObject({ role: "anatomical-intensity", section: "Spatial Normalization", space: "MNI152NLin2009cAsym" });
    expect(mask).toMatchObject({ role: "binary-mask", overlaySemantics: "binary" });
    expect(dseg).toMatchObject({ role: "discrete-label", overlaySemantics: "categorical" });
    expect(probability).toMatchObject({ role: "probability-map", overlaySemantics: "probability", label: "GM" });
    expect(fmriprepLayer(probability, 5)).toMatchObject({ artifactType: "fmriprep_probseg", colormap: "viridis", opacity: 0.55 });
  });

  it("classifies functional 4D, reference, confounds, transform, and report files", () => {
    expect(derive("sub-01/func/sub-01_task-rest_space-MNI152NLin6Asym_desc-preproc_bold.nii.gz").role).toBe("functional-timeseries");
    expect(derive("sub-01/func/sub-01_task-rest_space-MNI152NLin6Asym_boldref.nii.gz").role).toBe("functional-reference");
    expect(derive("sub-01/func/sub-01_task-rest_desc-confounds_timeseries.tsv").role).toBe("confounds");
    expect(derive("sub-01/anat/sub-01_from-T1w_to-MNI152NLin2009cAsym_mode-image_xfm.h5").role).toBe("transform");
    expect(derive("sub-01.html").role).toBe("report");
    expect(derive("sub-01/figures/sub-01_dseg.svg").role).toBe("reportlet");
    expect(derive("logs/CITATION.html").role).toBe("other");
  });

  it("auto-pairs only matching BIDS entities and space", () => {
    const native = derive("sub-01/anat/sub-01_desc-preproc_T1w.nii.gz");
    const mni = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_desc-preproc_T1w.nii.gz");
    const mniMask = derive("sub-01/anat/sub-01_space-MNI152NLin2009cAsym_desc-brain_mask.nii.gz");
    const otherSubject = derive("sub-02/anat/sub-02_space-MNI152NLin2009cAsym_desc-preproc_T1w.nii.gz");

    expect(bidsPairCompatible(mni, mniMask)).toBe(true);
    expect(bidsPairCompatible(native, mniMask)).toBe(false);
    expect(bidsPairCompatible(otherSubject, mniMask)).toBe(false);
    expect(preferredBaseFor(mniMask, [native, otherSubject, mni])).toBe(mni);
  });
});
