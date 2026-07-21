# Tutorial: Your First fMRI Analysis

This tutorial walks through a complete fMRI workflow in NeuroForge: from raw BIDS data through image quality control, preprocessing derivative import, functional connectivity analysis, and a methods paragraph ready for a manuscript.

Estimated time: 30–60 minutes (most of which is pipeline execution time, not interaction time).

---

## What you will do

```
BIDS dataset
    │
    ├─── BIDS Validator          → confirm the dataset is valid
    │
    ├─── MRIQC                   → per-subject image quality metrics
    │
    ├─── Import fMRIPrep         → bring in precomputed derivatives
    │       Derivatives          → (running full fMRIPrep is optional)
    │
    ├─── Functional Connectivity → atlas-based correlation matrix
    │
    ├─── Connectome Graph        → graph-theoretic metrics
    │       Analysis
    │
    └─── Methods Studio          → draft methods paragraph
```

---

## Before you start

- NeuroForge is running at http://localhost:3000 (see [Quickstart](quickstart.md))
- You have a BIDS-formatted fMRI dataset inside `HOST_DATASETS_DIR`
- You have real fMRIPrep derivatives if you want to run the connectivity steps

---

## Step 1 — Import the dataset

1. Click **Datasets** → **Import dataset**.
2. Enter a name (e.g. *Tutorial Dataset*).
3. Enter the absolute path to your BIDS directory inside the configured
   `HOST_DATASETS_DIR`.
4. Click **Import dataset**.

You will see the dataset card with its BIDS validation status as a badge.

---

## Step 2 — Validate the dataset

1. Open the dataset → **Pipelines** tab.
2. Click **Run** next to **BIDS Validator**.
3. Leave parameters at defaults. Click **Start Run**.
4. Wait for the run to complete (10–30 seconds).
5. Open the completed run. The validation report lists any issues found, with references to the BIDS specification.

If there are errors, fix them in your source data before continuing. NeuroForge treats your source as read-only — it will not modify files.

---

## Step 3 — Run MRIQC

MRIQC computes image quality metrics (IQMs) per subject and produces a group-level summary.

1. From the dataset → **Pipelines**, click **Run** next to **MRIQC**.
2. Set parameters:
   - **Subjects**: leave empty to process all, or enter specific IDs (e.g. `sub-01 sub-02`)
   - **Modalities**: check `T1w` and `bold`
   - Leave other parameters at defaults
3. Click **Start Run**.
4. MRIQC pulls its Docker image on first use (approximately 2 GB). Monitor progress in the **Runs** log.
5. When complete, open the run to see the embedded MRIQC HTML report.

The MRIQC report shows signal-to-noise ratio, DVARS, framewise displacement, and other IQMs. Review these before preprocessing to identify subjects with excessive motion or acquisition artifacts.

After MRIQC completes, run **MRIQC Group** to aggregate IQMs across subjects into a summary table:

1. From **Pipelines**, click **Run** next to **MRIQC Group**.
2. The previous MRIQC run's output is automatically detected as input. Click **Start Run**.

---

## Step 4 — Import fMRIPrep derivatives

Running full fMRIPrep on a laptop takes several hours per subject and is resource-intensive. If you have precomputed derivatives (from a cluster or the sample dataset), use **Import fMRIPrep Derivatives** to register them without re-running.

1. From **Pipelines**, click **Run** next to **Import fMRIPrep Derivatives**.
2. Set the **Derivatives path** to the directory containing the fMRIPrep output (e.g. `/path/to/derivatives/fmriprep`). NeuroForge will translate host paths to container paths.
3. Click **Start Run**.

This run completes in seconds. It registers the derivatives as a `fmriprep_derivatives` artifact, making them available as input to all downstream connectivity pipelines.

> If you want to run full fMRIPrep locally, use the **fMRIPrep** pipeline instead. Note that on Apple Silicon this is marked `local-unsafe`; see the [FAQ](faq.md#fmriprep-apple-silicon) for details.

---

## Step 5 — Run Functional Connectivity

Functional Connectivity computes a Pearson correlation matrix across atlas parcels from the fMRIPrep derivatives.

1. From **Pipelines** → **Functional Connectivity**, click **Run**.
2. Set parameters:
   - **Atlas**: `schaefer-100` (Schaefer 2018, 100 parcels, 7 networks) — a widely used default
   - **Confounds**: `motion_csf_wm` — removes motion, CSF, and white matter regressors
   - **Smoothing FWHM**: `6` mm
   - **Band-pass filter**: `0.01–0.1 Hz` (the resting-state band)
3. Click **Start Run**. This runs as a native Python pipeline (Nilearn) and typically completes in 1–3 minutes.
4. Open the completed run to see the correlation matrix heatmap.

The output artifact is a `connectivity_matrix_csv` — a square matrix of Pearson r values, one row/column per parcel.

---

## Step 6 — Explore the Artifact Explorer

1. Navigate to the dataset → **Artifacts** tab.
2. You will see artifacts from all runs: validated BIDS dataset, MRIQC reports, fMRIPrep derivatives, and the connectivity matrix.
3. Click the connectivity matrix row to see:
   - A preview of the heatmap
   - **Run Next** options — pipelines that can consume this artifact (e.g. *Group FC*, *Connectome Graph Analysis*)
4. Click **Run Next** → **Connectome Graph Analysis** to launch the next pipeline from here.

---

## Step 7 — Run Connectome Graph Analysis

Connectome Graph Analysis applies graph-theoretic metrics (degree, clustering coefficient, path length, modularity) to the connectivity matrix.

1. Set parameters:
   - **Threshold**: `0.2` — edges with |r| below this value are excluded
   - **Community detection**: `louvain`
2. Click **Start Run**. Completes in seconds.
3. Open the run to see the graph metrics table.

---

## Step 8 — View the Analysis Graph

1. Navigate to the dataset → **Graph** tab.
2. The Analysis Graph shows all runs and artifacts as a directed graph. Each node is a run; each edge is a typed artifact.
3. You can see the full provenance chain: BIDS Validator → MRIQC → Import Derivatives → Functional Connectivity → Connectome Graph Analysis.
4. Click any node to jump to that run's detail page.

This graph is the lineage record for the entire analysis. You can share or export it for a methods audit.

---

## Step 9 — Generate a methods paragraph

1. Navigate to the dataset → **Reports** tab → **Methods Studio**.
2. Click **Generate Methods**.
3. NeuroForge produces a draft methods paragraph that includes:
   - The names and versions of all tools used
   - Atlas name, parcel count, and network assignment
   - Confound strategy, smoothing, and bandpass parameters
   - Container versions where applicable
4. Copy the paragraph into your manuscript. Edit as needed — the text is a starting point, not a submission-ready sentence.

The paragraph is built by template filling from provenance records, not by a language model. Every claim in the text traces to a logged field.

---

## What to try next

| Next step | Where |
|---|---|
| Compare two connectivity runs (different atlases or confounds) | Dataset → **Comparison Studio** |
| Build a reusable workflow from these steps | **Workflows** → **New Workflow** |
| Run seed-based connectivity or ALFF | Dataset → **Pipelines** |
| Build your own plugin | [Plugin Tutorial](plugin-tutorial.md) |
| Understand how the pipeline registry works | [Architecture](architecture.md) |
