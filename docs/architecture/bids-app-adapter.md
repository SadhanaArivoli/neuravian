# BIDS App adapter

## Purpose

The Pipeline Contract v1 BIDS App adapter turns a manifest into a structured
container plan: an argv list, bind mounts, and environment variables. It never
constructs a shell command. MRIQC participant and group analysis are the first
and currently only reference integrations.

The source BIDS directory is always mounted read-only. Derivatives and optional
work directories are writable, explicitly scoped mounts. The manifest declares
supported analysis levels and label/work parameters; the adapter does not infer
flags that a tool may not support. The same Docker command preview is recorded
in local provenance and is consumed by the existing remote/cloud executor path.

## Authoring contract

```yaml
contract:
  version: 1
  unit_of_work: participant
  lifecycle:
    retry_mode: fresh
    resume_strategy: none
    preserve_work_directory: true
  progress:
    strategy: stages
    stages:
      - id: process
        label: Processing participants
        pattern: "Running node"
        weight: 1
  bids_app:
    analysis_levels: [participant]
    analysis_level_parameter: analysis_level
    participant_parameter: participant-label
    session_parameter: session-id
    work_directory_parameter: work-dir
  reporting:
    html_globs: ["**/*.html"]
    figure_globs: ["**/*.svg", "**/*.png"]
    metric_globs: ["**/*.json", "**/*.tsv"]
```

Every referenced parameter must exist. Analysis-level options must be a subset
of declared levels. Parameters retain manifest order, so command generation is
deterministic. Empty values and false booleans are omitted. Participant,
session, task, and run labels have their BIDS entity prefixes removed before
being passed to the app. Source/configuration paths declared with `mount: true`
are mounted read-only. Static, non-secret environment values may be declared in
the contract; secrets must not be placed in manifests.

## Execution and provenance

The adapter is executor-neutral data preparation. Docker receives argv directly,
without a shell. The existing run service records the exact preview, parameters,
image tag, resolved image digest (when Docker exposes it), execution location,
timestamps, lineage, logs, and discovered output checksums. Cloud workspaces use
the existing execution and synchronization path; the adapter adds no separate
cloud product flow.

Cancellation stops the active container through the existing executor. Timeouts
use the manifest maximum runtime. MRIQC declares fresh retry and no resume:
retaining a work directory is useful for diagnosis, but is not advertised as a
safe checkpoint capability.

## Adding another BIDS App

Add and validate a manifest, expose only documented flags, declare report and
artifact globs, add command/preflight tests, and qualify the official pinned
container against a legally usable public dataset. Pipeline-specific execution,
report, provenance, or cloud code should not be needed unless the official app
has behavior that the contract cannot honestly express.
