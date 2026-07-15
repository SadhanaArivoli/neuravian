# Native x86 verification session plan

This plan is deliberately provider-neutral. It contains no instance prices
because prices and discounts change. Check the provider's current calculator
immediately before renting. Every duration below is a planning estimate, not a
runtime guarantee or a scientific verification result.

## Capacity and transfer plan

- **Architecture:** native Linux x86_64 only; Ubuntu 24.04 LTS.
- **Recommended capacity:** 8 vCPU and 32 GB RAM. The minimum acceptable
  fMRIPrep capacity is 4 vCPU and 16 GB RAM, but it may increase paid time.
- **Disk:** provision **200 GB** of persistent SSD space. The combined static
  working/output requirements are approximately 145 GB (fMRIPrep 80 + 20 GB,
  FastSurfer 15 + 10 GB, pydeface 3 + 1 GB, plus images/builds). The remainder
  is safety headroom; abort rather than allowing the root volume to fill.
- **Fixture transfer:** exactly 52,914,200 bytes (about 52.915 MB decimal), six
  files, validated against `verification/fixtures/fixture-manifest.json`.
- **Image transfer:** three digest-pinned images; the local-cache planning
  estimate is 4,733,173,392 compressed bytes total. Registry transfer and
  expanded disk use can differ.

## Paid-time order

| Order | Task and command | Estimated duration | Hard timeout | Expected resources / disk growth | Parallel work | Abort condition | Rerun after failure? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Boot and SSH | 3–10 min | 15 min operator limit | Negligible | None | Wrong architecture/OS or SSH unavailable | Retry connection once; replace the VM only if its platform is wrong. |
| 2 | Bootstrap with the exact commit | 10–35 min without pulls | 45 min | 2–8 vCPU, 4–12 GB RAM; up to 10 GB build/cache | Transfer the fixture while package/image downloads are active if the provider channel permits it | Docker/Compose cannot become healthy | Rerun; bootstrap is idempotent. |
| 3 | Validate fixture and pre-pull images | 10–45 min | 60 min | Network-bound; about 4.73 GB estimated compressed and potentially much more expanded | Docker layers may download while the fixture transfers | Digest/platform mismatch or fixture checksum mismatch | Resume pulls; retransfer only the corrupted fixture. |
| 4 | pydeface: `02-pydeface-verify.sh` | 2–15 min | 1 h | 2–4 vCPU, 4–8 GB RAM; about 1 GB output/work | No other scientific run | No progress, OOM, nonzero exit, invalid NIfTI | Once after fixing the identified cause. |
| 5 | fMRIPrep smoke: `03-fmriprep-verify.sh --mode smoke` | 5–30 min | 30 min | 4–8 vCPU, 16–32 GB RAM; TemplateFlow/cache growth | No other scientific run | Workflow construction fails, license/BIDS error, architecture error | Yes after correction; smoke produces no verified derivative. |
| 6 | fMRIPrep complete minimal: `03-fmriprep-verify.sh --mode full` | 2–8 h | 24 h | 4–8 vCPU, 16–32 GB RAM; up to 80 GB work + 20 GB output | Do not overlap FastSurfer; monitor disk/logs only | Crash marker, OOM, no forward progress, disk below safety margin | Reuse the identical persistent work directory when inputs/parameters are unchanged. |
| 7 | FastSurfer smoke: `04-fastsurfer-smoke.sh` | 5–30 min | 30 min | 4–8 vCPU, 8–16 GB RAM; early subject files | No other scientific run | Input/license rejected or no segmentation marker | Yes after correction. An intentional timeout with verified progress is an acceptable smoke result only. |
| 8 | Full FastSurfer: `05-fastsurfer-full.sh` | 1–4 h | 40 h | 8 vCPU, 8–16 GB RAM; up to 15 GB work + 10 GB output | Do not overlap fMRIPrep | OOM, error/incomplete marker, implausible stalled progress | Resume only with consistent stage markers; otherwise preserve and restart cleanly. |
| 9 | Validate and collect: scripts 06 then 07 | 5–20 min | 30 min | Low CPU/RAM; small ZIP only | None | Any validator failure or secret/identifier guard | Fix evidence collection only; rerun a pipeline solely if its scientific validation failed. |
| 10 | Download, verify ZIP, then script 08 and stop VM | 5–15 min | 30 min operator limit | Negligible | Verify local ZIP checksum before stopping | Evidence missing/corrupt | Do not stop until a local copy opens and its manifest validates. |

The rough paid-session envelope is **4–14 hours**, dominated by the two complete
scientific runs. It is an estimate, not a promise. A failed scientific validator
can extend the session. The scripts intentionally avoid concurrent scientific
runs so memory pressure does not create a false integration failure.

## Bootstrap command

Transfer the 52.915 MB prepared fixture and FreeSurfer license to the VM without
printing either. Then run the checked-in script from a temporary checkout or a
trusted copy:

```bash
FS_LICENSE=/secure/license.txt \
  ./scripts/cloud/bootstrap-x86-ubuntu.sh \
  --commit <FINAL_COMMIT_SHA> \
  --fixture-dir "$HOME/neuroforge-fixture" \
  --license-file "$FS_LICENSE" \
  --prepull
```

If bootstrap reports that docker-group membership is not active, reconnect once.
Then set these for the remaining commands:

```bash
cd "$HOME/neuroforge"
export FIXTURE_DIR="$HOME/neuroforge-fixture"
export FS_LICENSE="/secure/license.txt"
```

## Linear session checklist

- [ ] Confirm current provider price and set an external spending alert.
- [ ] Create one Ubuntu 24.04 native x86_64 VM with 8 vCPU, 32 GB RAM, and 200 GB disk.
- [ ] Record the VM identifier and intended shutdown method; do not store credentials in the repository.
- [ ] SSH and run bootstrap at the exact final commit.
- [ ] Transfer only the prepared fixture and license; never transfer private MRI data.
- [ ] Run `verification/x86/commands/00-system-check.sh`.
- [ ] Run `verification/x86/commands/01-neuroforge-health.sh`.
- [ ] Confirm all three inspected images match `image-lock.json`.
- [ ] Run script 02; stop if pydeface validation later fails.
- [ ] Run script 03 in smoke mode, then full mode.
- [ ] Run script 04; accept timeout only when required progress markers exist.
- [ ] Run script 05 and wait for a clean NeuroForge completion state.
- [ ] Run script 06; require `all_valid: true` for every pipeline.
- [ ] Add only reviewed, identifier-free `approved-redacted-*.png` screenshots if needed.
- [ ] Run script 07 and download the small evidence ZIP.
- [ ] Open the ZIP locally, validate its manifest, and verify its checksum.
- [ ] Run script 08 (optionally `--stop-services`); it deletes nothing.
- [ ] Stop the VM in the provider console and confirm its actual state/billing.
- [ ] Preserve the evidence ZIP; do not download entire derivative trees unless a validator requires investigation.

## Empirical work still outstanding

Until this checklist is completed on the real VM, pydeface, fMRIPrep, and
FastSurfer remain **pending native Linux x86_64 verification**. Static readiness,
dry-runs, fixture integrity, and validator unit tests do not substitute for
successful native execution and real-output validation.
