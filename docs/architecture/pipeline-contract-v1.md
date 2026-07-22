# Pipeline Contract v1

## Purpose

Pipeline Contract v1 is the stable semantic layer between a tool manifest and
Neuravian's execution, workflow, artifact, report, methods, viewer, desktop,
and cloud surfaces. It does not add a pipeline or change an existing command.
Legacy manifests remain valid and receive conservative defaults.

## Architecture audit

| Area | Existing strength | Scaling gap before Contract v1 |
|---|---|---|
| Manifests | JSON Schema, pinned containers, typed parameters, preflight | No contract version or declared lifecycle/report/method capabilities |
| Execution | Backend-neutral `Executor`, Docker/native/SSH, streamed logs | Resume and checkpoint semantics were implicit; command contract is Docker-oriented |
| Parameters | Required/default/select/path/mount/positional support | No structured subject/session scope, secrets, mutually-exclusive groups, or resource-to-parameter mapping |
| Progress | Durable snapshots and live events | Only tqdm output was understood |
| Artifacts | Stable vocabulary, glob discovery, workflow compatibility | Mostly pipeline-specific types; no common family/role/media metadata |
| Provenance | Parameters, command, image/digest, timestamps, lineage, events | No manifest contract version, resource samples, checkpoint, or resume events |
| Workflows | Typed accepts/produces and local/cloud continuity | Single input edge per node; no fan-in, arrays, optional branches, or longitudinal subject sets |
| Reports | Dataset aggregation, artifact inventory, embedded figures | Discovery and scientific sections contain pipeline-ID special cases |
| Methods | Recorded metadata and explicit templates | New tools require hard-coded frontend and backend prose/citation entries |
| Plugins | Schema-validated manifests and artifact extensions | Compatibility range/dependencies are informational; no viewer adapter contribution point |
| Viewers | NIfTI/MGH/MGZ volumes, surfaces, annotations, reports, PNG/SVG | No native CIFTI, general GIFTI scalar/label, transform, tractogram, or diffusion-gradient adapters |
| Cloud/sync | Shared run model, events, artifact manifests, caching | No portable checkpoint/work-directory contract or scheduler job identity |

## Universal contract

Every future integration may declare `contract.version: 1` with these sections:

- `unit_of_work`: dataset, participant, session, group, subject, or longitudinal.
- `lifecycle`: expected/max duration, heartbeat expectations, cancellation grace,
  retry mode, resume strategy, checkpoint paths, and work-directory retention.
- `progress`: no progress, tqdm, named-group regular expressions, or weighted stages.
- `bids_app`: analysis levels and the manifest parameters used for participant,
  session, and work-directory selection.
- `reporting`: recursive HTML, figure, metric, and QC artifact discovery.
- `methods`: metadata-driven prose and citations.

The API returns a normalized contract and boolean capability summary for every
pipeline. Semantic validation rejects invalid parameter references, malformed
progress expressions, incoherent resume declarations, and QC types the pipeline
does not produce.

## Long-running pipeline readiness

The current run queue, incremental log file, persisted progress snapshot,
container reattachment, cancellation flag, maximum runtime, cloud event stream,
and synchronized metadata are suitable for 10–20 hour jobs. Contract v1 adds a
place to state expectations consistently.

Capabilities still required before claiming production resume support:

1. Persist executor/scheduler job identity for every backend, not only Docker
   container identity in process memory.
2. Make retry reuse a retained output/work directory only when the manifest
   explicitly declares it safe.
3. Record checkpoint discovery and resume provenance events.
4. Restore checkpoint/progress state after backend restart.
5. Apply cancellation grace from the contract across Docker, native, SSH, and
   future scheduler executors.
6. Add periodic CPU, memory, disk, I/O, and heartbeat samples.
7. Add multi-subject and longitudinal run grouping rather than encoding the
   cohort only in free-form parameters.

### FreeSurfer/recon-all

The framework already handles long timeouts, directory outputs, MGH/MGZ,
surface geometry, annotations, labels, statistics, logs, cancellation, and
container provenance. Contract v1 adds standard surface/annotation/transform/
statistics types and lifecycle/progress declarations.

Missing before recon-all qualification: safe `-make all` resume semantics,
IsRunning lock handling, recon-all stage parser, subject-directory integrity
checks, hemisphere-aware output grouping, longitudinal base/time-point
relationships, license secret handling, and restart-safe executor identity.

### fMRIPrep/BIDS Apps

The framework already supports BIDS dataset mounting, participant parameters,
work-directory mounting, derivatives directories, recursive HTML/PNG/SVG/JSON/
TSV discovery, output synchronization, reports, and provenance. Contract v1
makes BIDS-App scope, recursive discovery, and methods metadata declarative.

Missing before qualification: session parameter support in the existing
manifest, retained work-directory resume, resource sampling, crash-safe worker
reattachment beyond Docker, explicit derivative dataset registration, reportlet
relationships, confound/transform semantic groupings, and per-participant status
inside a multi-participant run.

## Artifact vocabulary

Contract v1 adds format-level fallback types for surface geometry, surface
annotations/labels, spatial transforms, statistics tables, HTML reports,
structured metadata, CIFTI, GIFTI, MGH/MGZ volumes, and lookup tables. Resolved
artifacts now expose `family`, `role`, `media_type`, and extensions. Specific
scientific artifact types remain preferable when their meaning is known.

## Viewer readiness

Already viewable:

- NIfTI, MGH, and MGZ structural/functional volumes, masks, segmentations,
  probability maps, and statistical maps.
- FreeSurfer surface geometry with common annotation, label, and statistics
  sidecars through Neuravian Viewer or FreeView where supported.
- HTML reports/reportlets and PNG/JPEG/SVG figures.

Architecture-ready but requiring adapters (not implemented here):

- CIFTI dense scalar/time-series/label/connectivity files.
- General GIFTI scalar, functional, and label overlays.
- ANTs/ITK composite transforms and transform-chain inspection.
- MRtrix `.tck`, diffusion gradients, FODs, and tract-density products.
- AFNI HEAD/BRIK pairs and SUMA-specific datasets.
- QSIPrep/QSIRecon diffusion QC and tractography collections.

Viewer selection should continue to use artifact roles and formats; future
adapters should not branch on pipeline IDs.

## Reports and methods

Run result discovery now uses contract globs recursively rather than assuming
reports and figures live at the output root. Existing specialized scientific
sections remain intact. A future pipeline can supply generic methods prose and
citations in its manifest, eliminating backend/frontend ID tables for the common
case. Handwritten scientific sections remain appropriate only when a report
needs domain-specific derived summaries.

## Cloud and synchronization contract

The contract is execution-location neutral and travels with the manifest.
Artifacts retain semantic type metadata after synchronization. Full resume on a
future cluster additionally requires scheduler job IDs, portable work/checkpoint
manifests, lease/heartbeat ownership, and checksum-verified checkpoint transfer.
Those changes are intentionally not claimed or simulated by this refactor.

## Integration effort estimate

Estimates include manifest, validation, artifact mapping, progress, reports,
methods, tests, and one qualified local/cloud run; they exclude upstream tool
runtime and scientific validation datasets.

| Tool family | Before | After Contract v1 | Remaining dominant work |
|---|---:|---:|---|
| FreeSurfer recon-all | 6–9 engineer-weeks | 3–5 engineer-weeks | Resume integrity, longitudinal grouping, qualification |
| fMRIPrep | 4–6 weeks | 2–3 weeks | Work-dir resume, participant status, resource qualification |
| ANTs | 3–5 weeks | 1.5–3 weeks | Transform semantics and registration QC |
| QSIPrep | 7–10 weeks | 4–6 weeks | Diffusion collections, resource needs, QC adapters |
| MRtrix3 | 7–11 weeks | 4–7 weeks | Tractogram/FOD artifacts and viewers |
| AFNI | 5–8 weeks | 3–5 weeks | HEAD/BRIK/SUMA formats and command families |

The reduction comes from reusable lifecycle declarations, generic progress,
recursive report discovery, shared artifact metadata, automatic capability
exposure, and manifest-driven methods/citations. Tools with new scientific data
formats still require dedicated viewer work and scientific qualification.

## Implementation delivered

- Versioned, normalized manifest contract with semantic validation.
- API-visible pipeline capability summaries.
- Manifest-configurable regex and weighted-stage progress parsing while keeping
  tqdm compatibility.
- Recursive, manifest-configurable report/figure/metric discovery.
- Format-level artifact vocabulary and resolved artifact metadata.
- Manifest-driven methods prose and citations with existing templates retained.
- Unit coverage for defaults, capabilities, validation, regex progress, and
  stage progress.
