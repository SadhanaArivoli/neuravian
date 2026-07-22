# Neuravian v0.1.0 — Early Access

**Released 2026-07-22**

This is the first public release of Neuravian. It is an Early Access release intended for researchers who want to evaluate the platform and contribute to its development. It is **not** a production-ready clinical tool and does not replace any established neuroimaging software.

---

## What Neuravian is

Neuravian is a local-first workspace for reproducible neuroimaging research. It organizes projects, BIDS datasets, pipeline runs, outputs, provenance records, and publication materials in one application—without replacing MRIQC, fMRIPrep, FSL, FastSurfer, Nilearn, or the other scientific tools it connects.

For each pipeline run, Neuravian records the tool version, container digest, command, parameters, inputs, outputs, and timing. Those records are the basis for the provenance view, methods drafts, and citation lists that the platform generates.

---

## What is included in this release

### Core platform

- Project, dataset, and run management backed by a local SQLite database
- BIDS dataset registration (read-only source mounts)
- Manifest-driven pipeline registry (Pipeline Contract v1)
- Shared BIDS App adapter for compatible upstream containers
- Typed artifact discovery, downstream compatibility matching, and lineage tracking
- Provenance recording: tool version, container image and digest, command, parameters, input identity, timestamps, and output artifacts
- Provenance-based methods draft generation and citation assembly (Methods Studio)

### Visualization

- Built-in NIfTI volume viewer (three-plane orthogonal rendering)
- Surface, connectivity matrix, timeseries, and HTML report viewing
- Artifact Explorer with type-based navigation

### Pipeline integrations

All integrations require Docker. See the [pipeline status table](pipeline-status.md) for the current qualification level of each tool.

| Tool | Status |
|---|---|
| MRIQC (participant and group) | **Qualified with limitations** — local execution, reports, IQMs, methods, and citation evidence documented |
| fMRIPrep | **Integrated; execution qualification pending** |
| BIDS Validator, dcm2niix, dcm2bids | **Integrated** |
| FSL BET, FAST, FLIRT, FNIRT | **Integrated** — researcher must build or provide the documented wrapper images |
| FastSurfer, SynthStrip, BrainChop, pydeface | **Integrated** |
| Nilearn-based analyses (functional connectivity, seed-based, ALFF/fALFF, ReHo, atlas ROI extraction, statistical map explorer) | **Integrated and tested** |

### Deployment

- Docker Compose deployment for macOS and Linux
- Unsigned macOS Apple Silicon application bundle (`.app`)
- Researcher-managed remote workspaces with explicit cloud handoff

---

## Platform requirements

| Requirement | Baseline |
|---|---|
| macOS (packaged desktop) | Apple Silicon |
| macOS (Docker Compose) | Apple Silicon or Intel |
| Linux (Docker Compose) | x86_64 |
| Windows | Not release-qualified; WSL2 may work |
| Docker | Docker Desktop on macOS; Docker Engine on Linux |
| Docker Compose | v2; 2.24.4 or newer tested |
| RAM | 8 GB minimum; 16 GB recommended for MRIQC; 32 GB recommended for fMRIPrep |
| Disk | 20 GB free to start; 50 GB recommended |

---

## Known limitations

- **No signed public installer.** The macOS bundle is unsigned and unnotarized. Gatekeeper must be bypassed on first launch for the local build. Signed packages are the primary remaining release blocker.
- **No Windows desktop package.** WSL2 may work with Docker Compose, but is not CI-qualified.
- **fMRIPrep is not execution-qualified** on this release's primary platform (macOS Apple Silicon). The integration is complete; a documented cloud x86_64 qualification run is the next step.
- **MRIQC qualification has limitations.** A progress-tracking fix was applied after the documented qualification run; a second complete run has not yet been recorded.
- **FSL wrapper images are not distributed.** Users must build the documented Docker wrapper images from the repository source.
- **Scientific outputs require researcher review.** Generated methods drafts, citation lists, and provenance summaries are starting points, not validated conclusions. Neuravian does not assert that any analysis is scientifically appropriate or publication-ready.

See [known limitations](known-limitations.md) for the complete list.

---

## Installation

Follow the [installation guide](installation.md). Docker is required. For the macOS application bundle, see [desktop/README.md](../desktop/README.md).

```bash
git clone https://github.com/SadhanaArivoli/neuravian.git
cd neuravian
cp .env.example .env
# Edit .env: set HOST_DATASETS_DIR to your BIDS datasets parent directory
docker compose up --build
```

Open <http://localhost:3000>.

---

## License

Apache License 2.0. Integrated tools, containers, atlases, and datasets retain their own licenses and citation requirements.

---

## Citation

```
Arivoli, S. (2026). Neuravian: A Local-First Neuroimaging Research Platform
(Version 0.1.0) [Software]. https://github.com/SadhanaArivoli/neuravian
```

Use the metadata in [`CITATION.cff`](../CITATION.cff) for reference managers.

---

## Feedback and contributions

Open an issue or pull request on GitHub. See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup and the contribution guide.
