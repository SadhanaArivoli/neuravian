# NeuroForge Quickstart

Get NeuroForge running and complete your first analysis in under 15 minutes.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Docker Desktop | 4.x or later | Must be running before `docker compose up` |
| Git | any | For cloning |
| 8 GB RAM | — | Recommend 16 GB for FastSurfer or fMRIPrep |
| macOS or Linux | — | Windows via WSL2 is functional but not tested in CI |

> **Apple Silicon (M1/M2/M3):** Most pipelines run natively. fMRIPrep is marked `local-unsafe` on Apple Silicon due to ANTs/Rosetta 2 instability — use *Import fMRIPrep Derivatives* to bring in precomputed results instead.

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/SadhanaArivoli/neuroforge.git
cd neuroforge
cp .env.example .env
```

Open `.env` and set `HOST_DATASETS_DIR` to the directory on your machine where your BIDS datasets or DICOM folders live:

```
HOST_DATASETS_DIR=/Users/yourname/datasets
```

This directory is mounted read-only inside the backend container at `/host-data`. NeuroForge never writes to your source data.

---

## Step 2 — Start NeuroForge

```bash
docker compose up --build
```

The first build takes 3–5 minutes. On subsequent starts `--build` is optional.

Wait until you see:

```
backend-1  | INFO:     Application startup complete.
```

Then open **http://localhost:3000** in your browser.

---

## Step 3 — Create a project

1. Click **Projects** in the left sidebar.
2. Click **New Project**.
3. Fill in a name (e.g. *My fMRI Study*), optional description, and investigators.
4. Click **Create**.

Projects are organizational containers. They do not affect data storage.

---

## Step 4 — Import a dataset

1. Click **Datasets** → **New Dataset**.
2. Enter a name and select a **Source type**:
   - **Local path** — paste the path on your machine to a BIDS dataset. NeuroForge translates it to `/host-data/...` inside the container.
   - **Sample dataset** — downloads a minimal BIDS example for testing.
3. Click **Import**.

The dataset appears in your list. Its BIDS status is shown as a badge.

---

## Step 5 — Validate the dataset

1. Open the dataset → **Pipelines** tab.
2. Find **BIDS Validator** and click **Run**.
3. Accept the default parameters and click **Start Run**.
4. Watch progress in the **Runs** log. The run typically takes 10–30 seconds.
5. Open the completed run to see the validation report.

If validation fails, the error report explains each issue with a reference to the BIDS specification.

---

## Step 6 — Run MRIQC

1. From the dataset view, go to **Pipelines** → **MRIQC**.
2. Select the subjects you want to process (or leave blank for all).
3. Click **Start Run**.
4. MRIQC pulls its Docker image on first use (~2 GB). Subsequent runs skip this.
5. When the run completes, open the run to see the MRIQC HTML report.

The HTML report is embedded directly in NeuroForge — no need to locate files manually.

---

## Step 7 — Explore artifacts

1. Navigate to **Datasets** → your dataset → **Artifacts** tab.
2. Artifacts from all runs are catalogued here, typed (e.g. `mriqc_report_html`, `bids_dataset_validated`).
3. Click any artifact to preview it or see which downstream pipelines can consume it (**Run Next**).

---

## What's next?

| Goal | Where to go |
|---|---|
| Run a full fMRI preprocessing → connectivity workflow | [Tutorial: First Analysis](tutorial-first-analysis.md) |
| Understand the system architecture | [Architecture](architecture.md) |
| Build a plugin | [Plugin Tutorial](plugin-tutorial.md) |
| Common problems | [FAQ](faq.md) |

---

## Stopping NeuroForge

```bash
docker compose down
```

Your database and all run outputs are persisted in the `./data/` directory and survive restarts.

To reset completely (deletes all run records and derivatives):

```bash
docker compose down
rm -rf data/
docker compose up
```

Your source datasets are never touched.
