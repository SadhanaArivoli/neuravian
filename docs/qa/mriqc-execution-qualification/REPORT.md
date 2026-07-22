# MRIQC execution qualification — 2026-07-21

## Scope and verdict

| Workflow | Verdict | Evidence |
|---|---|---|
| Dataset registration and parameterized preflight | PASS | Dataset 5; `participant-preflight.json` |
| Local participant MRIQC | PASS WITH LIMITATIONS | Run 124, exit 0, 4,176 seconds |
| Participant report/viewer/artifact access | PASS | `participant-results-fixed.json`; live embedded report screenshot |
| Participant progress | FAIL in qualified run | Run 124 stayed at 11%/initialization despite later reliable log events; stage patterns were corrected after qualification but a second 70-minute participant run was not executed |
| Local group MRIQC and lineage | PASS | Runs 125 and 131, source run 124, exit 0 |
| Runtime version evidence | PASS after fix | Run 131 records `24.1.0.dev0+gd5b13cb5.d20240826`; image remains `nipreps/mriqc:24.0.2` |
| Methods and citation generation | PASS | `generated-methods-run-131.txt`; Methods Studio screenshot and DOI/RRID inspection |
| Cancellation | PASS | Run 126 ended `cancelled`; container stopped; logs retained |
| Invalid BIDS preflight | PASS | `invalid-bids-preflight.json`, `can_launch:false` |
| Missing participant/session preflight | PASS after fix | `missing-entities-preflight-fixed.json` |
| Failed command translation | PASS WITH LIMITATIONS | Run 129 failed and retained raw MRIQC error; preflight now prevents this case and a specific translation was added, but it was not re-executed after the translation fix |
| Missing Docker | PASS by automated test only | Docker-unavailable preflight tests; daemon was not stopped on this workstation |
| Disk-full handling | NOT EXECUTED | Destructive disk exhaustion was not safe on this workstation |
| Backend interruption | NOT EXECUTED | The successful scientific run was not deliberately killed after 69 minutes |
| Cloud upload/execution/sync/download | FAIL qualification | No reachable authenticated cloud workspace was configured; the only remote target is the unreachable placeholder `192.168.1.100` |
| Cloud interruption | NOT EXECUTED | No real cloud execution existed to interrupt |

The cloud verdict is a qualification failure, not evidence that cloud execution
code failed. It means the advertised complete local/cloud workflow has not been
proven in this environment.

## Dataset

- OpenNeuro accession: `ds000001`
- Snapshot/version: `1.0.0`
- DOI: `10.18112/openneuro.ds000001.v1.0.0`
- Name: Balloon Analog Risk-taking Task
- License: CC0 / Public Domain Dedication and License 1.0
- Local size measured by `du -sh`: 2.3 GB
- Qualified input: `sub-13/anat/sub-13_T1w.nii.gz` (4.7 MB compressed)

Reproduce with DataLad:

```bash
datalad install https://github.com/OpenNeuroDatasets/ds000001.git
cd ds000001
git checkout 1.0.0
datalad get sub-13/anat/sub-13_T1w.nii.gz
```

The repository `data/sample-bids` fixture is not sufficient: its NIfTI file is
zero bytes. `backend/tests/data/bids-valid` is a useful structural/integration
fixture but is not a public scientific qualification dataset.

## Executed scientific workflow

Participant run 124 command:

```text
docker run --rm -v /Users/arivolitirouvingadame/Documents/openneuro-ds:/data:ro -v /Users/arivolitirouvingadame/Documents/neuravian/data/derivatives/mriqc/124:/out:rw -v /Users/arivolitirouvingadame/Documents/neuravian/data/work/mriqc/5:/work:rw nipreps/mriqc:24.0.2 /data /out participant --participant-label 13 --modalities T1w --nprocs 1 --omp-nthreads 1 --ants-float --work-dir /work --no-sub
```

Run 124 started `2026-07-21T22:04:21Z`, finished
`2026-07-21T23:13:57Z`, and exited successfully. The source was mounted
read-only. Docker recorded image digest
`nipreps/mriqc@sha256:dabe930dd0d1180c565a42f2c6a34f2b23026d9642db5d110f05b427413b829f`.

Discovered participant outputs:

- `sub-13_T1w.html`
- `sub-13/anat/sub-13_T1w.json`
- `sub-13/figures/sub-13_desc-background_T1w.svg`
- `sub-13/figures/sub-13_desc-zoomed_T1w.svg`
- MRIQC log and configuration TOML
- derivative `dataset_description.json`

Group run 125 consumed a copied, isolated lineage artifact from run 124 and
completed in nine seconds. It produced `group_T1w.html` and `group_T1w.tsv`.
Run 131 repeated the same path after the runtime-version fix and recorded the
version reported inside MRIQC's log rather than treating the container tag as
the tool version.

Post-fix screenshots:

- `screenshots/participant-run-124-fixed.png`
- `screenshots/group-run-125.png`
- `screenshots/methods-run-131.png`

## Regression results

- Backend: `750 passed, 1 skipped` (`52.59s`)
- Frontend: `459 passed`; production Vite build succeeded
- Desktop: `118 passed`; TypeScript and production build succeeded
- Docker backend and frontend images built and the application containers were
  recreated successfully
- `git diff --check`: passed
- Ruff on the new BIDS App adapter, execution integration, contract, and test
  modules: passed
- A broader targeted Ruff invocation including the legacy `preflight.py` and
  `run.py` modules reports 34 existing style/import violations. These are
  release hygiene debt, not test or runtime failures, and were not bulk-edited
  during the MRIQC-only qualification.

## Defects found and fixed

1. Nonexistent participants and sessions passed preflight. Manifest-declared
   BIDS entity checks now block them with remediation.
2. The container tag and runtime MRIQC version disagreed. A manifest-declared
   runtime version regex now records actual log evidence.
3. `dataset_description.json` was treated as an IQM and appeared as a fake
   participant. MRIQC metric globs now include only participant IQMs and group
   TSVs.
4. MRIQC SVGs appeared under “Connectivity files.” The generic section is now
   “Figures and analysis files.”
5. MRIQC report directory artifacts had unknown family/role/media type. They are
   now typed as quality-control report directories.
6. The reliable normalization/report log events were not reflected in progress.
   The manifest patterns now recognize them. Full participant requalification of
   this correction remains outstanding.
7. Missing participant execution produced only the generic non-zero-exit text.
   A specific MRIQC error translation was added. Re-execution after that fix is
   outstanding because preflight now blocks the invalid launch.

## Scientific transparency

The catalog and guide state that MRIQC is an established external research tool,
Neuravian orchestrates and records it, results require researcher
interpretation, and neither scientific certification nor clinical use is
claimed. No MRIQC algorithm was reimplemented.

## Release recommendation

**Do not release the complete local-and-cloud MRIQC workflow as qualified Early
Access yet.** Local participant→group execution is real and reproducible, but
participant progress after the fix and every real cloud stage remain unexecuted.
If the release is explicitly local-only, the MRIQC workflow is **PASS WITH
LIMITATIONS**, with the progress limitation disclosed.
