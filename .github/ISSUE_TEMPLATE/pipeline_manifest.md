---
name: New pipeline manifest
about: Request or propose a new pipeline integration
labels: pipeline
---

**Tool name and homepage**

**What it does**
One paragraph description of the tool's purpose and scientific output.

**Execution type**
- [ ] Native Python (wraps a Python library; no Docker required)
- [ ] Docker (uses a published container image)

**Docker image** (if applicable)
Name and tag of the container image, e.g. `nipreps/mriqc:24.0.0`.

**Input artifact type(s)**
What does this pipeline consume? Use existing artifact type slugs from `pipelines/schema/artifact_types.yaml` if possible, or propose new ones.

**Output artifact type(s)**
What does it produce?

**Compute profile**
- [ ] `local-ok` — runs comfortably on a laptop; verified on Apple Silicon
- [ ] `local-slow` — functional but slow (>10 min per subject)
- [ ] `local-unsafe` — not recommended on laptop hardware

**Apple Silicon status**
Has this been tested on Apple Silicon (M1/M2/M3)? If the Docker image is `linux/amd64`, describe Rosetta 2 behavior if known.

**References**
Paper(s) to cite, documentation link, and any known quirks.
