# image-statistics — Neuravian Plugin Example

This plugin ships with Neuravian as a reference implementation for plugin developers.
It adds one pipeline: **Image Statistics**, which reads any NIfTI file and writes a
JSON summary of basic voxelwise intensity statistics.

## What it demonstrates

| Feature | How it's used here |
|---|---|
| `plugin.yaml` | Plugin identity and metadata |
| `pipelines/*.yaml` | One manifest using `execution: native` |
| `artifact_types.yaml` | One new type: `image_statistics_json` |
| `backend/` directory | Python script auto-added to PATH at startup |
| `accepts[]` / `produces[]` | Compatible with `nifti_raw` and `nifti_skull_stripped` |

## Output

Writes `image_statistics.json` to the run's output directory:

```json
{
  "file": "/data/sub-01/anat/sub-01_T1w.nii.gz",
  "shape": [256, 256, 176],
  "voxel_size_mm": [1.0, 1.0, 1.0],
  "dtype": "float64",
  "n_voxels": 11534336,
  "n_nonzero": 1842000,
  "voxel_selection": "all",
  "mean": 423.12,
  "std": 318.74,
  "min": 0.0,
  "max": 1987.0,
  "p5": 0.0,
  "p25": 0.0,
  "p50": 390.1,
  "p75": 682.4,
  "p95": 947.1
}
```

## Using as a template

1. Copy this directory to `plugins/your-plugin-name/`
2. Edit `plugin.yaml`: change `id`, `name`, `version`, `author`, `description`
3. Edit `pipelines/your-pipeline.yaml`: change `id`, `display_name`, update `accepts`/`produces`
4. Replace `backend/neuravian-image-statistics` with your own executable
5. Edit `artifact_types.yaml` if your pipeline produces a new artifact type

See [docs/plugin-development.md](../../docs/plugin-development.md) for the full SDK guide.

## Dependencies

- `nibabel` — NIfTI file reading (standard Neuravian backend dependency)
- `numpy` — numerical operations (standard Neuravian backend dependency)

No additional packages required.
