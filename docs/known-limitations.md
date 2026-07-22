# Early Access known limitations

Neuravian 0.1.0 is an Early Access research orchestration platform. It does not
scientifically validate upstream tools, interpret MRI findings, or provide
clinical guidance.

## Qualification boundaries

- The local MRIQC participant workflow has been executed end to end on a public
  BIDS dataset. Evidence is recorded in
  [`docs/qa/mriqc-execution-qualification/REPORT.md`](qa/mriqc-execution-qualification/REPORT.md).
- fMRIPrep integration is available through the shared BIDS App adapter, but a
  full execution is not qualified on Apple Silicon. Use a supported Linux x86
  host or import existing derivatives and verify the resulting provenance.
- Cloud and SSH execution depend on researcher-managed infrastructure. A green
  unit or integration test is not evidence that a specific remote environment,
  dataset transfer, or long-running scientific job has completed successfully.
- Windows through WSL2 is functional but is not part of the continuous-integration
  qualification matrix.

## Operational constraints

- Container images are large and first-run downloads can take significant time.
- MRIQC and fMRIPrep runtimes vary substantially with modality, participant count,
  CPU, memory, storage, and container platform.
- Source datasets are mounted read-only by default. Run outputs, the SQLite
  database, and logs still require sufficient local disk space and should be
  backed up by the researcher.
- Reports and generated methods are drafts derived from recorded provenance.
  Researchers must review them for completeness and scientific appropriateness.

Report reproducible product defects with the GitHub issue templates. For an
upstream pipeline failure, retain the Neuravian run export and raw log so the
tool version, command, parameters, and environment can be reviewed.
