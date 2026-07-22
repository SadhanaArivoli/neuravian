# MRIQC execution qualification

This repository does not redistribute human MRI data. Use a legally reusable,
public BIDS dataset or a dataset you are authorized to process. Synthetic unit
fixtures test orchestration only and are not scientific validation.

## Frozen qualification sequence

1. Record the dataset URL, release/version, license, and root checksum externally.
2. Register the dataset and run the repository's BIDS validation flow.
3. Launch MRIQC participant analysis for at least two participants with the
   pinned `nipreps/mriqc:24.0.2` image.
4. Verify completion, raw logs, command, image digest, participant HTML reports,
   JSON IQMs, any TSV/SVG/PNG outputs, output checksums, provenance export, and
   generated methods/citation output.
5. Cancel a separate participant run and verify `cancelled`, retained logs, and
   no success artifacts.
6. Launch MRIQC Group Report through Run Next from the successful participant
   run. Verify the source run ID, copied derivative prerequisite, group HTML/TSV,
   lineage, provenance, and methods output.
7. Attempt group launch without lineage and verify it is rejected before Docker.
8. Repeat through an already-qualified cloud workspace where available, then
   synchronize and open the same outputs locally.

Record Neuravian commit, host OS/architecture, Docker version, dataset identity,
run IDs, timestamps, image digest, commands, checksums, and screenshots. Passing
this sequence qualifies execution/integration behavior only. It does not validate
MRIQC's scientific algorithms or certify any individual result.
