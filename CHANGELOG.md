# Changelog

Neuravian was developed privately under the working name **NeuroForge** before
its first public release. Historical commits and qualification screenshots may
retain that former name.

All notable changes are documented here. Neuravian follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## 0.1.0 Early Access — 2026-07-22

### Platform

- Local-first projects, BIDS datasets, pipeline runs, logs, artifacts, reports,
  provenance, methods, citations, and workflow history.
- Manifest-driven pipeline registry and Pipeline Contract v1.
- Shared BIDS App adapter for compatible upstream containers.
- Typed artifact discovery, downstream compatibility, and lineage.
- NIfTI, surface, matrix, table, figure, and HTML report viewing.
- Researcher-managed remote workspaces and explicit cloud handoff support.
- Docker Compose deployment and an unsigned macOS Apple Silicon desktop bundle.
- FastAPI, React/TypeScript, Electron, SQLite, Alembic, and automated CI tests.

### Qualification

- MRIQC participant and group execution are qualified locally with documented
  limitations.
- fMRIPrep integration is complete; scientific execution qualification remains
  pending.
- Other registered manifests are integrated, not universally execution-qualified.

See [`docs/pipeline-status.md`](docs/pipeline-status.md) for the authoritative
manifest-by-manifest status and evidence.
