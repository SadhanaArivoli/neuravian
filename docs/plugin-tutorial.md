# Plugin Tutorial: Building Your First NeuroForge Plugin

This tutorial walks through building a complete NeuroForge plugin. You will create a plugin that computes a simple histogram of NIfTI voxel intensities and saves it as a PNG — a realistic example that exercises every plugin feature.

For the complete SDK reference, see [`docs/plugin-development.md`](plugin-development.md).

---

## What a plugin is

A plugin is a directory with a specific layout. It adds pipelines, artifact types, and native executables to NeuroForge without modifying any core code.

```
my-plugin/
├── plugin.yaml          — required: plugin identity and metadata
├── pipelines/
│   └── my-pipeline.yaml — optional: one or more pipeline manifests
├── artifact_types.yaml  — optional: new artifact type definitions
├── backend/
│   └── my-tool          — optional: native executable (Python script, shell script, binary)
└── README.md            — optional: documentation
```

---

## Step 1 — Create the plugin directory

During local development, put your plugin in the `plugins/` directory at the repository root. NeuroForge discovers it automatically.

```bash
mkdir -p plugins/voxel-histogram/pipelines
mkdir -p plugins/voxel-histogram/backend
```

---

## Step 2 — Write plugin.yaml

`plugin.yaml` identifies the plugin and is validated against a JSON Schema on startup.

```yaml
# plugins/voxel-histogram/plugin.yaml
id: voxel-histogram
name: "Voxel Histogram"
version: "0.1.0"
author: "Your Name"
description: "Computes a voxel intensity histogram from any NIfTI image."
homepage: "https://github.com/yourname/neuroforge-voxel-histogram"
license: "Apache-2.0"
neuroforge_version: ">=0.1.0"
dependencies: []
enabled: true
```

Required fields: `id`, `name`, `version`, `author`, `description`.

Plugin IDs must be lowercase and may contain letters, digits, hyphens, and underscores. The ID must be globally unique — it will conflict with any core or other-plugin pipeline with the same ID.

---

## Step 3 — Define a new artifact type

Create `artifact_types.yaml` to register the `voxel_histogram_png` type:

```yaml
# plugins/voxel-histogram/artifact_types.yaml
artifact_types:
  voxel_histogram_png:
    label: "Voxel Histogram"
    description: "PNG histogram of NIfTI voxel intensity distribution"
    extensions: [".png"]
```

This type slug appears in `produces[]` in the pipeline manifest and in the Artifact Explorer type filter.

---

## Step 4 — Write the pipeline manifest

```yaml
# plugins/voxel-histogram/pipelines/voxel-histogram.yaml
id: voxel-histogram
display_name: "Voxel Intensity Histogram"
version: "0.1.0"
description: "Plots the voxel intensity distribution of a NIfTI image as a PNG histogram."
category: quality_control
input_type: nifti
compute_profile: local-ok

execution:
  type: native
  command: neuroforge-voxel-histogram

accepts:
  - type: nifti_raw
    label: "Input NIfTI"
    param: input-file
  - type: nifti_skull_stripped
    label: "Input NIfTI (skull stripped)"
    param: input-file

produces:
  - type: voxel_histogram_png
    label: "Voxel Histogram"
    path_hint: "voxel_histogram.png"

parameters:
  - name: bins
    label: "Number of bins"
    type: integer
    default: 64
    min: 8
    max: 512
    help: "Number of histogram bins."
  - name: exclude-zeros
    label: "Exclude zero voxels"
    type: boolean
    default: true
    help: "If true, voxels with value 0 are excluded from the histogram."
```

Key points:
- `execution.type: native` means NeuroForge runs the `command` as a subprocess, with the plugin's `backend/` directory prepended to `PATH`.
- `accepts[]` lists the artifact types this pipeline can consume. Multiple entries mean *any one* of these types is accepted (they all map to the same `param`).
- `produces[]` declares what the pipeline writes.
- `category` must be one of: `conversion`, `validation`, `quality_control`, `segmentation`, `preprocessing`, `deidentification`, `connectivity`.

---

## Step 5 — Write the native executable

```python
#!/usr/bin/env python3
# plugins/voxel-histogram/backend/neuroforge-voxel-histogram
"""Voxel intensity histogram for NeuroForge."""

import argparse
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import matplotlib
matplotlib.use("Agg")  # headless rendering
import matplotlib.pyplot as plt


def main() -> None:
    parser = argparse.ArgumentParser(description="Voxel intensity histogram")
    parser.add_argument("input_file", help="Path to NIfTI (.nii or .nii.gz)")
    parser.add_argument("-o", "--output", required=True, help="Output PNG path")
    parser.add_argument("--bins", type=int, default=64, help="Number of bins")
    parser.add_argument("--exclude-zeros", action="store_true",
                        help="Exclude zero-valued voxels")
    args = parser.parse_args()

    print(f"Loading: {args.input_file}", flush=True)
    img = nib.load(args.input_file)
    data = img.get_fdata().ravel()

    if args.exclude_zeros:
        data = data[data != 0]

    print(f"Voxels included: {len(data):,}", flush=True)

    fig, ax = plt.subplots(figsize=(8, 4))
    ax.hist(data, bins=args.bins, color="#5b8dee", edgecolor="none", alpha=0.85)
    ax.set_xlabel("Intensity")
    ax.set_ylabel("Voxel count")
    ax.set_title("Voxel Intensity Distribution")
    fig.tight_layout()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, dpi=150)
    print(f"Histogram saved: {output_path}", flush=True)


if __name__ == "__main__":
    main()
```

Make it executable:

```bash
chmod +x plugins/voxel-histogram/backend/neuroforge-voxel-histogram
```

> **Dependencies:** This script uses `nibabel`, `numpy`, and `matplotlib`. These are already available in the NeuroForge backend container. If your plugin requires packages that are not, list them in `dependencies[]` in `plugin.yaml` and document the installation step in your plugin's README.

---

## Step 6 — Verify the plugin loads

Restart the backend (or the full stack):

```bash
docker compose restart backend
```

Watch the logs:

```bash
docker compose logs backend | grep -i plugin
```

You should see:

```
Plugin loaded: voxel-histogram v0.1.0 (1 pipelines, 1 artifact types)
```

If you see `Plugin in ... failed to load`, the logs will include the validation error.

---

## Step 7 — Verify in the UI

1. Open http://localhost:3000/plugins.
2. The **Plugins** page shows your plugin under **Active** with its name, version, author, and registered pipeline and artifact type IDs.
3. Open any dataset → **Pipelines**. Your **Voxel Intensity Histogram** pipeline appears alongside the built-in ones.
4. Run it on any NIfTI artifact. The output `voxel_histogram.png` appears in the **Artifact Explorer** and can be previewed inline.

---

## Distributing your plugin

A NeuroForge plugin is just a directory. You can distribute it as:

- **A Git repository** — users clone it into their local `plugins/` directory or set `NEUROFORGE_PLUGINS_DIRS` to point at it.
- **A zip archive** — users extract it into `plugins/`.
- **A Docker volume** — advanced deployments can mount the plugin directory as `/plugins-user` (already configured in `docker-compose.yml`).

There is no registry or package manager yet. Plugins are discovered by directory presence.

---

## Debugging tips

| Problem | Likely cause | Fix |
|---|---|---|
| Plugin not showing in UI | Validation error | Check `docker compose logs backend \| grep plugin` |
| Pipeline not appearing | Wrong `category` value (hyphen instead of underscore) | Use `quality_control`, not `quality-control` |
| Command not found at runtime | Executable not in PATH | Confirm `backend/` dir exists and file is `chmod +x` |
| Artifact type not available in Run Next | Type not declared in `produces[]` or `accepts[]` | Check pipeline manifest spelling matches `artifact_types.yaml` |
| Plugin loads but run fails immediately | Script import error | Run the script directly: `python3 plugins/voxel-histogram/backend/neuroforge-voxel-histogram --help` |

---

## Full SDK reference

[`docs/plugin-development.md`](plugin-development.md) covers:

- Discovery order and environment variable override
- JSON Schema for `plugin.yaml`
- All manifest fields
- Artifact type vocabulary
- PATH patching details
- Disabling a plugin without removing it
- Testing plugins locally
