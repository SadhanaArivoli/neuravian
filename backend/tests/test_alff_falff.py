import argparse
import json
from pathlib import Path

import nibabel as nib
import numpy as np
import pandas as pd
import pytest

from app.services.artifact_registry import resolve_run_artifacts
from app.services.pipeline import get_registry
from app.tools.alff_falff import compute_alff_falff, normalize_map, run, validate_frequency_band
from app.tools.confounds import select_confounds


def test_nyquist_and_band_validation():
    assert validate_frequency_band(.01, .08, 2.0) == .25
    for low, high in [(.08,.01),(-.01,.08),(.01,.3)]:
        with pytest.raises(ValueError): validate_frequency_band(low, high, 2.0)


def test_fft_alff_falff_and_constant():
    tr=2.; n=100; t=np.arange(n)*tr
    x=np.column_stack([2*np.sin(2*np.pi*.05*t), np.ones(n)])
    alff,falff,freqs,_=compute_alff_falff(x,tr,.01,.08)
    assert freqs[np.argmax(np.abs(np.fft.rfft(x[:,0])))] == pytest.approx(.05)
    assert alff[0] == pytest.approx(1.0, abs=1e-12)
    assert falff[0] == pytest.approx(1.0, abs=1e-12)
    assert alff[1] == falff[1] == 0


def test_normalization():
    x=np.array([1.,2.,3.])
    assert normalize_map(x,"mean").mean() == pytest.approx(1)
    assert normalize_map(x,"zscore").std() == pytest.approx(1)


def test_confound_selection_is_exact(tmp_path: Path):
    path=tmp_path/"conf.tsv"; pd.DataFrame({"trans_x":[0,1]}).to_csv(path,sep="\t",index=False)
    selected=select_confounds(path,"motion6",2)
    assert selected.values is None and "trans_y" in selected.missing


def _fixture(root: Path):
    func=root/"sub-01"/"func"; func.mkdir(parents=True)
    shape=(3,3,3,100); tr=2.; t=np.arange(shape[-1])*tr
    data=np.zeros(shape,dtype=np.float32); data[1,1,1]=np.sin(2*np.pi*.05*t); data[1,1,2]=np.sin(2*np.pi*.03*t)
    affine=np.diag([2,2,2,1]); bold=func/"sub-01_task-rest_space-MNI_desc-preproc_bold.nii.gz"
    img=nib.Nifti1Image(data,affine); img.header.set_zooms((2,2,2,tr)); nib.save(img,bold)
    mask=np.zeros(shape[:3],np.uint8); mask[1,1,1:3]=1; nib.save(nib.Nifti1Image(mask,affine),func/"sub-01_task-rest_space-MNI_desc-brain_mask.nii.gz")
    return bold, affine


def test_end_to_end_maps_metadata_report_and_artifacts(tmp_path: Path):
    root=tmp_path/"fmriprep"; _,affine=_fixture(root); out=tmp_path/"out"
    args=argparse.Namespace(fmriprep_dir=str(root),output_dir=str(out),low_frequency=.01,high_frequency=.08,tr=None,confound_strategy="none",normalization="zscore",detrend=True,subject_label=None,task_label=None,run_label=None,source_run_id=44)
    meta=run(args)
    assert meta["source_run_id"] == 44 and meta["mask_voxel_count"] == 2
    for name in ["alff_map.nii.gz","falff_map.nii.gz","alff_normalized_map.nii.gz","falff_normalized_map.nii.gz","alff_histogram.png","falff_histogram.png","spectral_summary.png","alff_falff_metadata.json","alff_falff_report.html"]: assert (out/name).stat().st_size > 0
    result=nib.load(out/"alff_map.nii.gz"); assert np.allclose(result.affine,affine); assert np.isfinite(result.get_fdata()).all()
    assert json.loads((out/"alff_falff_metadata.json").read_text())["spectral_method"]
    manifest=get_registry()["alff-falff"]
    artifacts=resolve_run_artifacts(manifest,str(out),{},"success")
    assert next(a for a in artifacts if a.type=="alff_map_nii").resolved


def test_rejects_3d_and_empty_mask(tmp_path: Path):
    root=tmp_path/"fmriprep"; func=root/"sub-01"/"func"; func.mkdir(parents=True)
    nib.save(nib.Nifti1Image(np.zeros((2,2,2)),np.eye(4)),func/"sub-01_desc-preproc_bold.nii.gz")
    args=argparse.Namespace(fmriprep_dir=str(root),output_dir=str(tmp_path/"o"),low_frequency=.01,high_frequency=.08,tr=2.,confound_strategy="none",normalization="none",detrend=True,subject_label=None,task_label=None,run_label=None,source_run_id=None)
    with pytest.raises(ValueError,match="not 4D"): run(args)
