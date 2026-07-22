# Installation

## Public download status

Neuravian does not yet have a published, signed installer. The repository can
produce an unsigned macOS Apple Silicon `.app`; Linux uses Docker Compose;
Windows is not in the current release qualification matrix.

| Platform | Status | Requirements |
|---|---|---|
| macOS Apple Silicon | Unsigned application bundle can be built locally | Docker Desktop with Compose v2 |
| macOS Intel | No desktop bundle | Docker Desktop with Compose v2 |
| Linux | No desktop bundle | Docker Engine and Compose v2 |
| Windows | No release package | WSL2 may work but is not qualified in CI |

Published packages, when signing and platform work are complete, will appear on
the [GitHub Releases page](https://github.com/SadhanaArivoli/neuravian/releases).

## Requirements

| Dependency | Required level | Why Neuravian needs it |
|---|---|---|
| Operating system | macOS Apple Silicon for the packaged desktop candidate; macOS or Linux for Docker Compose | The desktop package, Docker images, and CI qualification do not cover Windows or every CPU architecture. |
| Docker | Docker Desktop on macOS or Docker Engine on Linux | Runs Neuravian services and containerized upstream neuroimaging tools. |
| Docker Compose | v2; 2.24.4 or newer is the tested desktop baseline | Starts the coordinated frontend/backend services with the correct mounts and localhost bindings. |
| CPU | `arm64` is supported for the macOS desktop; native `x86_64` Linux is required or recommended by several upstream images | fMRIPrep, FastSurfer, MRIQC, and FSL image behavior depends on upstream architecture support. Always read preflight results. |
| RAM | 8 GB host minimum; 16 GB recommended for MRIQC; 32 GB recommended for fMRIPrep evaluation | Processing full-resolution MRI volumes and parallel workers is memory intensive. Docker Desktop has a separate memory allocation. |
| Disk | At least 20 GB free to begin; 50 GB recommended for general evaluation | Images, caches, work directories, derivatives, reports, and logs accumulate locally. Pipeline minima include MRIQC 10 GB, FastSurfer 30 GB, and fMRIPrep 100 GB. |
| Internet | Required for initial clone/install, dependency and image downloads, and uncached models/atlases | The repository does not bundle every third-party image or scientific resource. Cloud workspaces also require network connectivity. |
| GPU | Optional only | MRIQC and the application do not require a GPU. Optional FastSurfer/SynthStrip CUDA execution requires NVIDIA hardware, drivers, Docker GPU passthrough, and NVIDIA Container Toolkit. |
| Dataset directory | Read access to the parent directory containing BIDS data | Source data is mounted read-only and is not imported into a proprietary store. |
| FreeSurfer license | Pipeline-specific | fMRIPrep and FastSurfer declare a license-file prerequisite from the upstream FreeSurfer project. |

Optional external viewers—FreeView and MRIcroGL—can be configured from the
desktop application. The built-in viewer does not require them.

### Pipeline-specific requirements

The application prerequisite check is only the baseline. Each pipeline must
also pass its own preflight before launch.

| Pipeline or family | Additional requirement | Status and reason |
|---|---|---|
| MRIQC | Official container image, internet for the first pull, 10 GB free space declared by the manifest | No GPU is required. Apple Silicon is the documented local qualification path, with limitations recorded in the pipeline-status table. |
| fMRIPrep | FreeSurfer license file, official container image, and 100 GB free space declared by the manifest | Resource-intensive; 32 GB RAM is the evaluation recommendation. Upstream image architecture and ANTs behavior must be checked on the selected host. |
| FastSurfer | FreeSurfer license file and 30 GB free space declared by the manifest | CPU execution is available; optional acceleration requires a supported NVIDIA/CUDA container runtime. |
| FSL wrappers | Locally built/provided Neuravian FSL wrapper images | The repository does not claim a public first-party registry. Preflight must find the named local image before execution. |
| BrainChop and model-backed tools | Internet access for any uncached upstream weights or atlases | First-use resources are supplied by the upstream tool, not silently embedded by Neuravian. |
| External viewers | FreeView or MRIcroGL installed at a configured executable path | Optional; only needed for “Open externally.” Built-in viewing remains available without them. |
| Future FreeSurfer, QSIPrep, MRtrix3, ANTs, and AFNI integrations | Requirements not yet qualified | Before any future integration is advertised, its manifest and preflight must declare image/tool version, supported architecture, memory, disk, licenses, GPU/runtime needs, and required auxiliary data. Users must not infer support from a roadmap mention. |

Neuravian should block launch when a declared hard prerequisite is absent and
show the failed check, why it matters, and a recovery action. Version drift,
network reachability, optional GPU support, and unusually low resources should
be warnings when they cannot be determined safely—not late raw-command errors.

The desktop startup check already verifies the operating system, Docker CLI,
daemon, Compose availability, required repository resources, ports 3000/8000,
host memory, and available disk. Memory and disk are reported rather than
globally rejected because requirements differ by pipeline; pipeline preflight
enforces declared minima. Future improvements should warn on an outdated Compose
version, test registry connectivity before the first image pull, and inspect
NVIDIA Container Toolkit only after a GPU option is selected.

Git and Node.js 20 are required for the current source and desktop build flow.
They should not be presented as end-user requirements once signed packages exist.

```bash
git clone https://github.com/SadhanaArivoli/neuravian.git
cd neuravian
cp .env.example .env
```

Set `HOST_DATASETS_DIR` in `.env` to the parent directory containing the BIDS
datasets you intend to import. Neuravian mounts this directory read-only at
`/host-data` inside the backend container.

```bash
docker compose up --build
```

Open <http://localhost:3000>. A green **Ready** indicator confirms that the
frontend can reach the API.

## Build the macOS Apple Silicon application

The current Electron shell starts the same Docker Compose services and requires
Node.js 20 for packaging:

```bash
cd desktop
npm ci
npm run dist:mac
```

The bundle is written to `desktop/dist/mac-arm64/Neuravian.app`. It is unsigned
and unnotarized. Use it only as an Early Access development build; do not disable
Gatekeeper globally. See [desktop packaging details](../desktop/README.md).

## First launch

1. Open Neuravian and wait for the **Ready** state.
2. Create a project.
3. Import a BIDS dataset from the directory configured in `.env`.
4. Run BIDS Validator.
5. Review the [pipeline status](pipeline-status.md), then configure MRIQC.

The first container pull can take several minutes. MRIQC itself can take more
than an hour depending on data and hardware.

## Update

Preserve local changes, then update and rebuild:

```bash
git pull --ff-only
docker compose build
docker compose up -d --force-recreate
```

Database migrations run during backend startup. Confirm health with
`docker compose ps`; do not delete the database to resolve a migration error.

## Stop and back up

```bash
docker compose down
```

Back up `data/neuravian.db`, `data/derivatives/`, and required workspace
metadata. `docker compose down` preserves these files. Never use
`docker compose down -v` unless you intentionally want to remove managed data.
