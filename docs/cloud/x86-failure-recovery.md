# Native x86 verification recovery guide

These procedures preserve paid-session evidence without claiming a pipeline is
verified. Never delete the persistent work directories until validation and
evidence download are complete.

| Failure | Preserve first | Resume or restart | Recovery |
| --- | --- | --- | --- |
| SSH disconnect | Nothing; Docker and Neuravian continue independently. | Resume monitoring. | Reconnect using the current address, read `verification/x86/evidence/run-state`, then query `/api/runs/{id}`. Do not submit a duplicate run. |
| Docker pull interrupted | Docker cache and bootstrap log. | Resume the pull. | Rerun `verification/x86/prepull-images.sh`; Docker reuses complete layers and verifies the frozen digest. |
| Insufficient disk | Logs, run JSON, and validator results. | Resume only after the same work/output mounts remain intact. | Stop the affected run, expand the existing volume, verify `df -h`, then retry. Do not prune images or work directories during the session. |
| Out of memory | Run log, exit state, and kernel OOM evidence. | Restart with fewer workers; an OOM-killed process is not resumable in place. | Keep fMRIPrep's work directory, lower `nprocs`/`omp-nthreads`, or resize the VM. For FastSurfer disable parallel hemispheres before retry. |
| Process timeout | Latest run JSON, logs, output inventory, work directory. | fMRIPrep may reuse its work cache; FastSurfer resume depends on its own complete stage markers. | Confirm the cancel completed. Increase a timeout only after showing forward progress and sufficient resources; record the change. |
| FastSurfer partial subject | Entire `scripts/` log/marker set and inventory. | Resume only if FastSurfer documents the finished stages and no corrupted surface exists. | Move the partial subject aside before a clean restart when markers are inconsistent. Never validate a directory containing `IsRunning*` or error markers. |
| fMRIPrep interrupted | Persistent `fmriprep-work` and crash files. | Usually resume-safe with identical fixture, version, and parameters. | Fix the cause and submit the identical command using the same work directory. Nipype hashes determine reusable nodes. Restart cleanly if inputs or parameters changed. |
| Stopped instance | Evidence, work, output, and Docker data must be on the retained volume. | Resume after start if the volume is intact. | Start the same instance, use its new address if needed, reconnect, run system and health checks, and query existing run state before resubmission. |
| Changed public IP | No compute recovery is needed. | Resume. | Update only the SSH destination or local SSH config. Do not rewrite Neuravian configuration or recreate the instance. |
| Corrupted fixture transfer | Failed checksum report. | Restart transfer, not a pipeline. | Delete only the corrupted transferred fixture copy, transfer again, and run `prepare_fixture.py --validate-only`. Never run a pipeline after a checksum mismatch. |

Abort the paid session if architecture is not native `x86_64`, a digest differs
from `image-lock.json`, the fixture checksum fails twice, or required persistent
storage cannot be preserved. A stopped instance can still incur storage costs;
confirm the provider state and billing separately after evidence download.

Only HTML reports are collected automatically because they can be sanitized.
Screenshots must be reviewed, have all identifiers obscured, and use an
`approved-redacted-*.png` filename before the evidence collector will include
them. Raw imaging files, PDF reports, licenses, keys, and environment files are
never added to the ZIP.
