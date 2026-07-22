# Neuravian researcher quickstart

Get Neuravian running, import a BIDS dataset, and launch your first qualified
quality-control workflow. Setup usually takes 10–20 minutes; MRIQC runtime
depends on dataset size and available compute.

---

## Before you begin

Neuravian does not yet publish signed installers. Follow the
[installation guide](installation.md) to launch the current release candidate,
then return here for the researcher workflow.

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| Docker Desktop | 4.x or later | Must be running before `docker compose up` |
| Git | any | For cloning |
| 8 GB RAM | — | 16 GB or more is recommended for MRIQC; fMRIPrep requires at least 16 GB |
| macOS or Linux | — | Windows via WSL2 is functional but not tested in CI |

> **Apple Silicon:** fMRIPrep is integrated but not execution-qualified on this
> platform. Use *Import fMRIPrep Derivatives* for precomputed results, or a
> supported researcher-managed Linux x86_64 environment. See the
> [canonical status table](pipeline-status.md).

---

## Step 1 — Clone and configure

```bash
git clone https://github.com/SadhanaArivoli/neuravian.git
cd neuravian
cp .env.example .env
```

Open `.env` and set `HOST_DATASETS_DIR` to the directory on your machine where your BIDS datasets or DICOM folders live:

```
HOST_DATASETS_DIR=/Users/yourname/datasets
```

This directory is mounted read-only inside the backend container at `/host-data`. Neuravian never writes to your source data.

---

## Step 2 — Start Neuravian

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

1. Click **Datasets** → **Import dataset**.
2. Enter the absolute path to a BIDS dataset inside the configured
   `HOST_DATASETS_DIR`. Neuravian translates the host path to `/host-data/...`
   inside the container.
3. Click **Import dataset**.

The dataset appears in your list. Its BIDS status is shown as a badge.

---

## Step 5 — Validate the dataset

1. Open **Pipelines**.
2. Find **BIDS Validator** and select it.
3. Accept the default parameters and click **Review & Launch**.
4. Confirm the preflight checks, then click **Start Run**.
5. Watch progress in the **Runs** log. The run typically takes 10–30 seconds.
6. Open the completed run to see the validation report.

If validation fails, the error report explains each issue with a reference to the BIDS specification.

---

## Step 6 — Run MRIQC

1. From the dataset view, go to **Pipelines** → **MRIQC**.
2. Select the subjects you want to process (or leave blank for all).
3. Click **Review & Launch**, review the preflight checks, then click **Start Run**.
4. MRIQC downloads its container image on first use. The download size and time
   vary by image version and platform; subsequent runs reuse the local image.
5. MRIQC can take more than an hour for a participant on laptop hardware. Keep
   Docker running and monitor progress and logs from the run page.
6. When the run completes, open the run to review the HTML report, image-quality
   metrics, discovered artifacts, and recorded provenance.

The HTML report is embedded directly in Neuravian — no need to locate files manually.

---

## Step 7 — Explore artifacts

1. Navigate to **Datasets** → your dataset → **Artifacts** tab.
2. Artifacts from all runs are catalogued here and assigned stable types (for
   example, `mriqc_report` and `bids_dataset_validated`).
3. Click any artifact to preview it or see which downstream pipelines can consume it (**Run Next**).

---

## What's next?

| Goal | Where to go |
|---|---|
| Run a full fMRI preprocessing → connectivity workflow | [Tutorial: First Analysis](tutorial-first-analysis.md) |
| Understand the system architecture | [Architecture](architecture.md) |
| Build a plugin | [Plugin Tutorial](plugin-tutorial.md) |
| Common problems | [FAQ](faq.md) |
| Check what is qualified | [Pipeline status](pipeline-status.md) |

---

## Stopping Neuravian

```bash
docker compose down
```

Your database and all run outputs are persisted in the `./data/` directory and survive restarts.

Back up `data/neuravian.db` and `data/derivatives/` before any maintenance.
Your source datasets are never modified by Neuravian.
