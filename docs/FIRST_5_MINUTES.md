# First 5 Minutes with Neuravian

**Estimated time: 5–10 minutes**

This guide walks you through your very first session with Neuravian. By the end, you will have imported a neuroimaging dataset and run your first brain analysis pipeline — no terminal or programming experience required.

If you get stuck at any step, jump to [Troubleshooting](#troubleshooting) or the [Beginner FAQ](#beginner-faq).

---

## What you will do

| Step | Action | Time |
|---|---|---|
| 1 | Launch Neuravian and confirm it is ready | ~2 min |
| 2 | Tell Neuravian where your data lives, then import a dataset | ~2 min |
| 3 | Run BrainChop to process your first MRI file | ~1 min setup, ~9 min run |

---

## Before you begin

You will need:

- **Neuravian** installed on your Mac — see [Installation](installation.md)
- **Docker Desktop** installed and running — you can download it free from [docker.com](https://www.docker.com/products/docker-desktop/)
- A **BIDS dataset** on your computer — see [What is a BIDS dataset?](#what-is-a-bids-dataset) if you are not sure what this means

> **Don't have a dataset yet?**
> You can download free, openly available MRI datasets from [OpenNeuro](https://openneuro.org). Many are already formatted in BIDS and ready to use.

---

## Step 1 — Launch Neuravian

Open the **Neuravian** application from your Applications folder or Dock.

The startup screen performs a series of checks:

- Docker Desktop is running
- Required service images are available
- Ports are free

On the **first launch**, Neuravian downloads its container images. This can take 3–5 minutes depending on your internet connection. Subsequent launches are much faster.

When the banner turns green and shows **Ready**, the application is fully started.

> **Why this matters**
>
> Neuravian runs its analysis tools inside Docker containers — isolated, reproducible software environments that ensure the same pipeline produces the same results on any Mac. You do not need to install FSL, FreeSurfer, or any other neuroimaging tool manually.



### Expected Result

✓ The startup banner shows **Ready**

✓ No red error indicators are visible

✓ The left sidebar is active and navigable

### If this doesn't happen

- **Docker error on startup:** open Docker Desktop, wait for the whale icon in the macOS menu bar to stop animating, then click **Retry** in Neuravian.
- **Startup takes longer than 10 minutes:** your internet connection may be slow. The images are large on first download. Leave Neuravian open and check back.
- **Persistent errors:** see [Docker is not running](#docker-is-not-running) in the Troubleshooting section.

---

## Step 2 — Set your dataset root and import a BIDS dataset

### What is a dataset root?

Neuravian needs to know which folder on your Mac contains your research data. This folder is called the **dataset root**.

The dataset root is the **parent folder** that contains one or more BIDS dataset folders — not the dataset folder itself.

Here is an example of what this looks like:

```
/Users/yourname/Documents/         ← dataset root  (tell Neuravian this)
  neuravian-data/
    openneuro-ds/                  ← a BIDS dataset (import this)
      sub-01/
        anat/
          sub-01_T1w.nii.gz        ← an MRI file
      dataset_description.json
      participants.tsv
```

In this example, the dataset root is `/Users/yourname/Documents`. The BIDS dataset you will import is the folder `openneuro-ds` inside it.

> **Why this matters**
>
> Neuravian shares your dataset root with its analysis tools through a secure, read-only connection. Your original files are never modified. By setting the root once, every dataset inside it becomes available to all pipelines automatically.

### Checking or changing the dataset root

1. Click **Datasets** in the left sidebar.

2. Near the top of the page, find the **Dataset root** card. It shows the current path — for example `/Users/yourname/Documents`.

3. If the path shown is not where your data lives, click **Change…** and select the correct folder using the folder picker.

4. After changing the root, a note appears: **Restart Neuravian before importing a dataset.** Close and reopen Neuravian, then return to this step.

> **Why a restart is needed**
>
> The connection between Neuravian's analysis tools and your files is established once when the application starts. Changing the dataset root while Neuravian is running has no effect until the next launch.

### Importing a BIDS dataset

**BIDS (Brain Imaging Data Structure)** is a standard way of organizing neuroimaging files and their associated metadata into folders. Most modern neuroimaging datasets from repositories like OpenNeuro are already in BIDS format.

Once the dataset root is confirmed:

1. Scroll down to the **Import a BIDS dataset** section.

2. Click **Browse…** to open a folder picker, navigate to your BIDS dataset folder, and select it.

   Alternatively, type the full path directly into the text field:

   ```
   /Users/yourname/Documents/neuravian-data/openneuro-ds
   ```

3. Click **Import dataset**.

Neuravian will:

- Register the dataset in its local database
- Run **BIDS Validator** in the background to check the dataset's structure
- Display the validation result with any warnings or errors

**About validation results:**

- **Valid** — the dataset passes all BIDS checks and is ready for pipelines.
- **Valid with warnings** (yellow) — the dataset is usable but has minor metadata gaps. Warnings are common in real-world datasets and do not block pipeline runs.
- **Errors** (red) — the dataset has structural problems. Some pipelines may refuse to run. See [BIDS Validator shows errors](#bids-validator-shows-errors) in the Troubleshooting section.

### Expected Result

✓ The dataset appears in the dataset list below the import form

✓ Subjects are listed (for example `sub-01`, `sub-02`)

✓ A validation badge is shown — **Valid** or **Valid with warnings**

### If this doesn't happen

- **"Outside the configured dataset root" error:** the folder you selected is not inside the dataset root shown in the card. Either choose a different folder that is inside the root, or click **Change…** to set a new root that contains your dataset, restart Neuravian, and try again.
- **No subjects listed:** the dataset may not be in valid BIDS format. Check that it contains a `participants.tsv` file and at least one `sub-XX/` folder.
- **Import button stays greyed out:** make sure the path field is not empty and does not have a trailing space.
- For further help, see [Troubleshooting](#troubleshooting).

---

## Step 3 — Run BrainChop skull-stripping

**Skull stripping** is the process of removing non-brain tissue (skull, scalp, eyes) from an MRI image. This is usually the first step before any brain analysis. The result is an image that shows only the brain.

**BrainChop** is Neuravian's built-in skull-stripping pipeline. It uses a deep-learning model called MindGrab and works on any structural MRI type — T1-weighted, T2-weighted, FLAIR, or PD.

### Open the pipeline

1. Click **Pipelines** in the left sidebar.
2. Select **BrainChop (MindGrab skull-strip)** from the list.

### Choose the right input file

BrainChop requires one MRI file in **NIfTI format** (`.nii` or `.nii.gz`). NIfTI is the standard file format used by neuroimaging software to store MRI images.

For best results, choose a **T1-weighted MRI** (T1w). A T1-weighted scan is a high-resolution structural image used to visualize brain anatomy — grey matter appears grey, white matter appears white, and cerebrospinal fluid appears dark.

Look for a file with a name like:

```
sub-01_T1w.nii.gz
```

**Avoid these file types for BrainChop:**

| File type | Why to avoid |
|---|---|
| `_bold.nii.gz` | Functional MRI time-series — not a structural scan |
| `_events.tsv` | A text file with timing data, not an MRI image |
| `_inplaneT2.nii.gz` | Lower-resolution scan, less ideal for skull stripping |
| `_fieldmap.nii.gz` | A field map for distortion correction, not an anatomical image |

### Enter the input file path

In the **input-file** field, enter the full path to the NIfTI file:

```
/Users/yourname/Documents/neuravian-data/openneuro-ds/sub-01/anat/sub-01_T1w.nii.gz
```

**How to construct the path:**

```
Dataset root:  /Users/yourname/Documents
Dataset:       neuravian-data/openneuro-ds
File:          sub-01/anat/sub-01_T1w.nii.gz

Full path:     /Users/yourname/Documents/neuravian-data/openneuro-ds/sub-01/anat/sub-01_T1w.nii.gz
```

The path must:

- Start with a `/` (it is an absolute path, not a relative one)
- End with `.nii` or `.nii.gz`
- Match the capitalisation of your filename exactly (`T1w` not `t1w`)

> **Tip:** if you are not sure of the exact path, open a Finder window, navigate to the file, right-click it, hold the Option key, and choose **Copy as Pathname**.

### Run the pipeline

Click **Run**.

A progress panel opens showing live log output from the pipeline.

| Environment | Typical duration |
|---|---|
| Docker Desktop (current default) | ~9 minutes |

> **Why does it take 9 minutes?**
>
> Docker Desktop runs a small Linux virtual machine on your Mac. BrainChop runs inside that virtual machine. The extra time compared to native macOS comes from the virtualisation layer, not from the analysis itself. The model will run faster in a future native backend.

> **First run only:** BrainChop downloads the MindGrab model from the internet the first time it runs. This adds a few minutes to the first run. The model is cached for all future runs.

### Outputs

When the run finishes, two files are written to the run's output directory:

| File | What it contains |
|---|---|
| `stripped.nii.gz` | The skull-stripped brain volume — non-brain tissue removed |
| `brain_mask.nii.gz` | A binary brain mask: 1 = brain voxel, 0 = non-brain voxel |

Click the output directory link in the results panel to open the folder in Finder.

### Expected Result

✓ The run status shows **Completed**

✓ Two output files are listed: `stripped.nii.gz` and `brain_mask.nii.gz`

✓ Opening `stripped.nii.gz` in a viewer shows a brain without a skull

### If this doesn't happen

- **"File not found" error:** check the path for typos, confirm the file exists, and confirm the dataset root is correct. See [NIfTI file not found](#nifti-file-not-found-brainchop-error) in Troubleshooting.
- **Run exits immediately with a model error:** your internet connection may have interrupted the model download. Check your connection and click Run again.
- **Run is still in progress after 20 minutes:** this is unusual. Check the live log for error messages. See [Troubleshooting](#troubleshooting).

---

## What success looks like

After completing all three steps, your session should look like this:

- The startup banner shows **Ready** with no red indicators
- The dataset root card shows a path under your home directory (for example `/Users/yourname/Documents`)
- Your dataset appears in the dataset list with a **Valid** or **Valid with warnings** badge
- Subjects from the dataset are listed (for example `sub-01`, `sub-02`)
- The BrainChop run shows **Completed** with two output files
- `stripped.nii.gz` shows a brain without a skull when opened in a viewer

If all of these are true, you have successfully set up Neuravian and completed your first neuroimaging pipeline run.

---

## Troubleshooting

### Docker is not running

**Symptom:** Neuravian startup screen shows a Docker error and a **Retry** button.

**Fix:**
1. Open Docker Desktop from your Applications folder or Spotlight.
2. Wait for the whale icon in the macOS menu bar to stop animating — this means Docker is ready.
3. Click **Retry** in Neuravian.

To confirm Docker is reachable, open Terminal and run:

```bash
docker info
```

If this returns an error, Docker Desktop is not running or not installed.

---

### Dataset folder is outside the configured dataset root

**Symptom:** importing a folder returns "outside the configured dataset root."

**Fix:**
1. Click **Change…** in the Dataset root card.
2. Select a folder that is a parent of all your BIDS datasets — for example `/Users/yourname/Documents`.
3. Restart Neuravian.
4. Try importing again.

---

### Containers are still using the old dataset root after changing it

**Symptom:** BrainChop cannot find a file you know exists, even after updating the dataset root.

**Fix:** restart Neuravian. The connection between the analysis tools and your files is set once at startup. A restart picks up the new root.

To confirm which folder is currently connected, open Terminal and run:

```bash
docker inspect neuravian-backend-1 \
  --format '{{range .Mounts}}{{.Source}} → {{.Destination}}{{"\n"}}{{end}}'
```

The line ending in `→ /host-data` shows which folder on your Mac is currently visible to the analysis tools.

---

### NIfTI file not found (BrainChop error)

**Symptom:** BrainChop exits immediately with a "file not found" or similar error.

**Common causes:**

1. **Typo in the path.** Check every segment — subject label, session label, filename, and extension. Capitalisation matters: `T1w` is not the same as `t1w`.

2. **File is outside the dataset root.** The path must be inside the folder shown in the Dataset root card. If it is not, change the root and restart.

3. **Dataset root changed but Neuravian was not restarted.** Restart and try again.

To see all NIfTI files that the analysis tools can currently access, open Terminal and run:

```bash
docker exec neuravian-backend-1 find /host-data -name "*.nii.gz" | head -20
```

---

### BIDS Validator shows warnings but no errors

**What this means:** your dataset passes BIDS validation but has minor metadata gaps — for example, a missing `IntendedFor` field on a fieldmap, or a non-standard filename suffix. Warnings are common in real-world datasets.

**What to do:** warnings do not block pipeline runs. You can proceed. If you are preparing data for publication, review the warning messages and address any that are relevant to your study.

---

### BIDS Validator shows errors

**What this means:** the dataset has structural problems — for example, required files are missing, filenames do not follow the BIDS naming convention, or `dataset_description.json` is malformed.

**What to do:** review each error message. Consult the [BIDS Specification](https://bids-specification.readthedocs.io/) to understand what is required. Fix the dataset structure before running pipelines.

---

### Terminal shows "permission denied" when accessing the dataset root

**Symptom:** a diagnostic command returns `permission denied`.

**Fix:** Docker Desktop requires explicit permission to access folders outside `/Users`, `/Volumes`, `/tmp`, and `/private`.

1. Open Docker Desktop.
2. Go to **Settings → Resources → File Sharing**.
3. Add the folder containing your datasets.
4. Restart Docker Desktop, then restart Neuravian.

If your data is already inside `/Users/yourname/Documents`, permission denied usually means the path has a typo. Verify it with:

```bash
ls -la "/Users/yourname/Documents/neuravian-data/openneuro-ds"
```

---

### BrainChop model download fails

**Symptom:** the run log shows a model download error and the job exits.

**Fix:**
1. Confirm you have an active internet connection.
2. Click **Run** again — the download will retry automatically.

The MindGrab model is downloaded once on first use and cached inside the backend container. If the container was recreated (for example after a full Docker reset), the download runs again.

To check whether the model is already cached:

```bash
docker exec neuravian-backend-1 ls ~/.mindgrab/
```

If the directory is empty or missing, the next run will download it automatically.

---

## Four useful diagnostic commands

Run these in Terminal when something is not working as expected.

```bash
# Is Docker running and reachable?
docker info
```

```bash
# Are all Neuravian services up?
docker compose -f ~/Library/Application\ Support/neuravian-desktop/docker-compose.packaged.yml ps
```

```bash
# What host folder is mounted into the backend right now?
docker inspect neuravian-backend-1 \
  --format '{{range .Mounts}}{{.Source}} → {{.Destination}}{{"\n"}}{{end}}'
```

```bash
# List NIfTI files the backend can actually see
docker exec neuravian-backend-1 find /host-data -name "*.nii.gz" | head -30
```

---

## Beginner FAQ

### What is a BIDS dataset?

**BIDS (Brain Imaging Data Structure)** is a standard way of organizing neuroimaging files into folders so that analysis software can automatically find and understand them. Instead of storing files however you like, BIDS requires specific folder names, file names, and companion files (like `participants.tsv` and `dataset_description.json`). Most datasets on [OpenNeuro](https://openneuro.org) are already in BIDS format.

### What is a dataset root?

The dataset root is the parent folder that contains all of your BIDS dataset folders. Neuravian uses it to know where to look for data. You set it once, and all datasets inside it become accessible to your pipelines.

### What is a subject?

In BIDS, a **subject** is one participant in the study. Each subject has their own folder named `sub-XX` (for example `sub-01`, `sub-02`). Inside are the MRI files for that participant.

### Which MRI file should I use for BrainChop?

Use a **T1-weighted anatomical scan** — a file ending in `_T1w.nii.gz`. This is the standard high-resolution structural image used to see brain anatomy. Do not use functional MRI (BOLD) files, fieldmaps, or event files.

### What does BrainChop do?

BrainChop removes non-brain tissue — skull, scalp, eyes, and other structures — from an MRI image. This step is called **skull stripping** and is usually the first step before any brain analysis. The result is an image that contains only the brain.

### Where are my output files saved?

Output files are saved to a run-specific directory inside Neuravian's data folder. After a run completes, click the output directory link in the results panel to open the folder in Finder.

### Why am I seeing validation warnings?

Validation warnings mean your dataset has minor metadata gaps — for example, missing optional fields or slightly non-standard filenames. Warnings are very common in real-world datasets and do not prevent you from running pipelines. Only errors (red) require attention before proceeding.

### Do I need Docker knowledge to use Neuravian?

No. Neuravian manages Docker automatically. You do not need to know how to write Dockerfiles, build images, or run containers manually. Docker Desktop just needs to be installed and running in the background.

---

## Glossary

**MRI (Magnetic Resonance Imaging)**
A medical imaging technique that uses magnetic fields to produce detailed images of internal body structures, particularly soft tissues like the brain.

**T1-weighted MRI (T1w)**
A structural MRI scan that provides high-resolution images of brain anatomy. Grey matter appears grey, white matter appears white, and cerebrospinal fluid appears dark.

**T2-weighted MRI (T2w)**
A structural MRI scan sensitive to water content. Cerebrospinal fluid appears bright, making it useful for detecting lesions and edema.

**Functional MRI (fMRI)**
An MRI technique that measures brain activity over time by detecting changes in blood oxygenation. Produces a time-series of volumes rather than a single structural image.

**BIDS (Brain Imaging Data Structure)**
A community standard for organizing neuroimaging data into a consistent folder and file naming structure so that analysis tools can automatically discover and use the data.

**Dataset root**
The parent folder on your Mac that contains one or more BIDS dataset folders. Neuravian uses this as the root of its read-only connection to your data.

**Subject**
One participant in a neuroimaging study, represented as a `sub-XX` folder in a BIDS dataset.

**Pipeline**
An automated sequence of image-processing steps. In Neuravian, a pipeline takes one or more input files, processes them using an established neuroimaging tool, and produces output files.

**Skull stripping**
The process of removing non-brain tissue (skull, scalp, eyes) from an MRI image, leaving only the brain. A standard preprocessing step before most brain analyses.

**Segmentation**
The process of labeling regions of an MRI image — for example, identifying which voxels belong to grey matter, white matter, or cerebrospinal fluid.

**Derivatives**
Output files produced by an analysis pipeline. In BIDS, derivatives are stored in a `derivatives/` folder so they are clearly separated from the original source data.

**NIfTI (.nii / .nii.gz)**
Neuroimaging Informatics Technology Initiative format. The standard file format for storing MRI image data used by virtually all neuroimaging software. Files end in `.nii` (uncompressed) or `.nii.gz` (compressed).

---

## Learn more

| Resource | Description |
|---|---|
| [BIDS Specification](https://bids-specification.readthedocs.io/) | Complete reference for the Brain Imaging Data Structure standard |
| [BIDS Starter Kit](https://bids-standard.github.io/bids-starter-kit/) | Practical guide for organizing your own data in BIDS format |
| [OpenNeuro](https://openneuro.org) | Free repository of openly available MRI datasets in BIDS format |
| [BrainChop](https://brainchop.org) | Web-based and library version of the MindGrab skull-stripping model |
| [NIfTI format overview](https://nifti.nimh.nih.gov/) | Technical specification for the NIfTI file format |
| [Neuravian documentation](README.md) | Full documentation index for Neuravian |
| [Neuravian Quick Start](quickstart.md) | Next step: run MRIQC quality control on your dataset |
| [Troubleshooting](troubleshooting.md) | Recover from Docker, dataset, pipeline, and viewer failures |

---

## Next steps

| What to do next | Where to look |
|---|---|
| Run MRIQC quality control on your dataset | [Quick Start](quickstart.md) |
| Understand BIDS formatting and fix validation errors | [BIDS Specification](https://bids-specification.readthedocs.io/) |
| Check which pipelines are execution-qualified | [Pipeline Status](pipeline-status.md) |
| Recover from a Docker or dataset failure | [Troubleshooting](troubleshooting.md) |
| Run a workflow across multiple pipelines | [First Workflow](workflow-guide.md) |
| Open output files in a viewer | [Viewer Guide](viewer-guide.md) |
