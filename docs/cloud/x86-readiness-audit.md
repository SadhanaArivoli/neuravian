# NeuroForge x86_64 readiness audit

Status date: 2026-07-14. This is a static readiness audit only. FastSurfer,
fMRIPrep, and pydeface remain **pending empirical native Linux x86_64
verification**. No cloud resources or emulated local runs were used.

| Pipeline | Static readiness | Blocking issue | Expected VM action | Success criteria |
|---|---|---|---|---|
| pydeface | Command, mounts, digest pin, watchdog, artifact pattern, and report integration are defined. | FSL FLIRT stalled under Apple Silicon amd64 emulation; no native x86_64 result exists. | Run the lightweight test first against the approved T1w fixture and validate the resulting NIfTI. | Exit 0; readable non-empty defaced NIfTI; dimensions and affine preserved; voxels changed; checksum and artifact registration recorded. |
| fMRIPrep | Versioned image, BIDS positional inputs, license mount, work directory, CPU/RAM flags, output spaces, watchdog, derivatives artifact, report, and provenance are defined. | Required ANTs normalization stalled under Apple Silicon emulation; minimal BIDS fixture and native x86_64 execution remain empirical. | Run smoke mode with `--fs-no-reconall`, then the complete minimal mode if smoke validation passes. | Exit 0; derivative structure, preprocessed BOLD, masks, confounds TSV/JSON, report, provenance, readable headers, and no crash markers. |
| FastSurfer | Versioned CPU image, T1/license mounts, subject/output handling, host UID behavior, segmentation/full modes, watchdog, subject-directory artifact, and report integration are defined. | amd64 CNN/FSL execution is prohibitively slow or stalls under Apple Silicon emulation; native x86_64 outputs are unverified. | Run smoke phase to confirm startup/segmentation progress, then segmentation and full surface phases under separate timeouts. | Smoke shows accepted input and early segmentation markers; full run exits 0 with complete paired hemispheres, volumes, surfaces, annotations, stats, and registered subject directory. |

## FastSurfer (`pipelines/fastsurfer.yaml`)

- **Image:** `deepmi/fastsurfer:cpu-v2.5.4`; expected platform Linux amd64.
- **Input:** one readable T1w `.nii` or `.nii.gz`, subject ID, and non-empty
  readable FreeSurfer license. It is not a BIDS positional pipeline.
- **Command construction:** the Docker executor mounts T1 and license read-only
  under `/inputs`, mounts the run output at `/out`, and emits `--t1`,
  `--fs_license`, `--sid`, `--sd /out`, mode, threads, and device flags.
- **Output/work:** `{run_output}/{sid}/`; FastSurfer manages internal temporary
  work. Estimated minimum free disk is 30 GB, with 15 GB working and 10 GB
  output allowance.
- **Watchdog/resources:** 40 hours; minimum 2 CPUs/8 GB RAM, recommended 8
  CPUs/16 GB. CPU mode is the verification baseline; CUDA is optional and not
  part of the minimum VM plan.
- **Artifacts/report:** `freesurfer_dir` rooted at the subject directory;
  NeuroForge report citations and FastSurfer result discovery already exist.
- **Apple Silicon failure:** amd64 CNN passes under emulation were measured at
  an impractical pace. The canonical x86 path contains no Apple-specific
  workaround; the platform selector lives in the executor.
- **Verification status:** pending native Linux x86_64 empirical verification.

Smoke success means the container starts, validates the input/license, begins
FastSurferCNN segmentation, emits early output/log markers, and shows no
architecture/emulation error. Full success requires clean exit, no incomplete
marker, readable `mri/` segmentation volumes, paired `lh.*`/`rh.*` surfaces,
plausible mesh counts, thickness arrays, annotations, statistics, and successful
artifact registration. Building a Surface Viewer is explicitly out of scope.

## fMRIPrep (`pipelines/fmriprep.yaml`)

- **Image/version:** `nipreps/fmriprep:25.2.5`; expected platform Linux amd64.
- **Input:** valid BIDS root mounted read-only at `/data`, output at `/out`,
  analysis level `participant`, optional participant/task filters, and a
  read-only FreeSurfer license mount.
- **Modes:** smoke and complete-minimal both use `--fs-no-reconall`; smoke is an
  early bounded execution check, not a scientifically complete result. Complete
  minimal runs one participant/task through successful exit.
- **Command/resources:** output space defaults to `MNI152NLin2009cAsym`;
  `nprocs`, `omp-nthreads`, and `mem` are explicit. Minimum is 4 CPUs/16 GB RAM;
  8 CPUs/32 GB is recommended.
- **Output/work/cache:** derivatives at `/out`; optional reusable `--work-dir`
  maps to `/work`. Allow 80 GB work, 20 GB output, and at least 100 GB free.
  TemplateFlow templates are expected to populate the container/user cache on
  first use unless preseeded; the VM commands preserve the work directory.
- **Watchdog:** 24 hours.
- **Artifacts/report/provenance:** `fmriprep_derivatives`, subject HTML report,
  confounds and NIfTI outputs, image digest, command, and run metadata are
  registered by existing infrastructure.
- **Apple Silicon failure:** ANTs SyN normalization stalled under amd64
  emulation even when skull stripping was skipped.
- **Verification status:** pending native Linux x86_64 empirical verification.

## pydeface (`pipelines/pydeface.yaml`)

- **Image:** `poldracklab/pydeface` pinned by digest
  `sha256:40855352a8dd6dde3f0bcd9ed0fff110b07849871c7c70f62db8bac5ab099541`;
  expected platform Linux amd64.
- **Input/command:** one readable structural NIfTI mounted read-only; executor
  emits output, overwrite, registration options, then the mounted positional
  input. Output defaults to `/out/defaced.nii.gz`.
- **License:** none.
- **Output/work/resources:** one NIfTI artifact; allow 3 GB working, 1 GB output,
  10 GB free, 2 CPUs/4 GB minimum, 4 CPUs/8 GB recommended.
- **Watchdog:** one hour.
- **Artifacts/report:** `nifti_defaced` at `defaced.nii.gz`; existing generic
  report/artifact viewers display the output.
- **Apple Silicon failure:** FSL FLIRT created no usable output and stalled under
  amd64 emulation.
- **Verification status:** pending native Linux x86_64 empirical verification.

## Central preflight architecture

The manifest `preflight` block is the single declarative source for empirical
status, OS/architecture policy, licensing, BIDS requirement, ports, and resource
thresholds. `PreflightService` evaluates all pipelines through one implementation
and returns structured `pass`, `warning`, `fail`, or `unknown` checks with
remediation, blocking flags, and measured/required values.

Endpoints:

- `GET /api/pipelines/{pipeline_id}/preflight` for environment-only checks.
- `POST /api/pipelines/{pipeline_id}/preflight` with `dataset_id` and `params`
  for selected-input checks.

Architecture mismatch is blocking for `local-unsafe` fMRIPrep/pydeface and a
visible warning for `local-slow` FastSurfer. “Pending empirical x86_64
verification” is represented separately from “unsupported” and never silently
promoted to verified.
