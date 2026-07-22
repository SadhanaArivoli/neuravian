# MRIQC in Neuravian

Neuravian runs the official `nipreps/mriqc:24.0.2` container. It orchestrates,
records, displays, and reports the run; it does not reproduce MRIQC algorithms or
certify the scientific validity of the dataset or result. MRIQC output requires
researcher interpretation and is not intended for clinical diagnosis.

## Participant analysis

Select a registered BIDS dataset, choose **MRIQC**, optionally limit participant,
session, task, or modality, review preflight, and launch. The source dataset is
read-only. Reports, JSON IQMs, TSV metrics, SVG/PNG figures, and logs are found
recursively under the run output and appear through existing run, report, and
artifact experiences. HTML opens in the report experience; supported images and
structured files use existing previews.

## Group analysis

Complete participant MRIQC first. From that successful run, use **Run Next** and
choose **MRIQC Group Report**. Neuravian copies the recorded participant
derivatives into a fresh isolated output, records the upstream run lineage, and
runs MRIQC at `group` level. Launching without a resolved `mriqc_report` lineage
is rejected with an actionable error.

## Local and cloud execution

Local runs require a reachable Docker daemon and sufficient disk/RAM. Cloud runs
use the existing cloud-workspace handoff; the dataset and run record must already
be synchronized by that workflow. Both paths use the same declared BIDS App argv
semantics and artifact/report discovery.

## Troubleshooting and limitations

- Preflight establishes execution readiness and reports recorded BIDS validation
  status; neither is a scientific validation of the images.
- MRIQC 24.0.2 is pinned. Docker records the immutable digest after execution
  when the daemon provides it.
- Progress uses honest stages derived from recognizable log events. There is no
  fabricated percentage when MRIQC provides insufficient evidence.
- Resume/checkpoint is not supported or advertised. Retry starts a fresh run.
- A retained participant work directory may aid diagnosis but is not proof that
  restarting from it is scientifically safe.
- Architecture compatibility is reported by preflight. The existing executor
  uses the amd64 image path; native x86_64 remains the qualification target.

The MRIQC paper and RRID are emitted from the manifest methods metadata. Methods
text is generated from recorded run evidence; missing version, digest, or other
evidence must remain visibly incomplete rather than being inferred.
