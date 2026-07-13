# NeuroForge Plugin Development Guide

Plugins let you add new pipelines to NeuroForge without modifying its source code.
Drop a directory into `plugins/` and restart the backend — your pipeline appears
automatically in the Pipeline Library, Workflow Builder, and Run Next suggestions.

---

## Minimal plugin

A plugin is a directory with a `plugin.yaml` file:

```
plugins/
  my-plugin/
    plugin.yaml
```

**`plugin.yaml`** (required):

```yaml
id: my-plugin           # lowercase, letters/digits/hyphens only
name: "My Plugin"
version: "1.0.0"        # semantic version: MAJOR.MINOR.PATCH
author: "Your Name"
description: "One paragraph describing what this plugin provides."
license: "MIT"          # recommended: SPDX identifier
```

That's it. A plugin with no pipelines is valid — it will appear in the Plugins page
with status **Active** and zero pipelines registered.

---

## Adding a pipeline

Create a `pipelines/` subdirectory containing one or more YAML manifests.
Each manifest uses the same JSON Schema as NeuroForge's built-in pipelines
(`pipelines/schema/manifest.schema.json`):

```
plugins/
  my-plugin/
    plugin.yaml
    pipelines/
      my-tool.yaml
```

**`pipelines/my-tool.yaml`**:

```yaml
id: my-plugin-my-tool         # must be globally unique; use your plugin id as prefix
display_name: "My Tool"
description: "What this pipeline does."
category: quality-control     # preprocessing | segmentation | functional | quality-control | connectivity | other
input_type: nifti

execution:
  type: native
  command: my-tool-cli        # must be on PATH inside the backend container

dataset_positional: false

inputs: [nifti]
outputs: [json]

parameters:
  - name: input-file
    type: file_path
    required: true
    positional_suffix: true
    help: "Path to a NIfTI file."

  - name: output
    cli_flag: "-o"
    type: string
    required: false
    default: "{output_dir}/result.json"
    help: "Output path."

accepts:
  - type: nifti_raw
    param: input-file

produces:
  - type: my_plugin_output_json
    path_hint: "result.json"
    label: "Result"
    description: "The tool's JSON output."

max_runtime_hours: 0.5
```

> **Pipeline ID uniqueness** — pipeline `id` must not conflict with any built-in
> NeuroForge pipeline or any other installed plugin. NeuroForge will refuse to start
> the plugin with a clear error message if a conflict is detected. Prefix your pipeline
> IDs with your plugin ID to avoid conflicts (e.g. `my-plugin-my-tool`).

---

## Providing a native executable

If your pipeline uses `execution.type: native`, the command must be on `PATH`
inside the backend container. The easiest way is to ship it with your plugin:

```
plugins/
  my-plugin/
    plugin.yaml
    backend/
      my-tool-cli          # Python script or compiled binary
```

At startup, NeuroForge automatically:
1. Sets the execute bit on all files in `backend/`
2. Prepends `backend/` to `PATH` so `shutil.which("my-tool-cli")` finds it

Your script can be any executable: a Python script with a `#!/usr/bin/env python3`
shebang, a shell script, or a compiled binary. It must be executable by the user
running the backend process.

**Python script example** (`backend/my-tool-cli`):

```python
#!/usr/bin/env python3
import argparse, json, sys
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument("input_file")
    p.add_argument("-o", "--output", required=True)
    args = p.parse_args()

    result = {"file": args.input_file, "status": "ok"}
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(f"Done: {args.output}", flush=True)

if __name__ == "__main__":
    main()
```

---

## Registering new artifact types

If your pipeline produces a type not in NeuroForge's core vocabulary
(`pipelines/schema/artifact_types.yaml`), register it in an `artifact_types.yaml`
file at the plugin root:

```
plugins/
  my-plugin/
    plugin.yaml
    artifact_types.yaml
    pipelines/
      my-tool.yaml
```

**`artifact_types.yaml`**:

```yaml
artifact_types:
  my_plugin_output_json:
    label: "My Plugin Output"
    description: "JSON output produced by My Tool."
    extensions: [".json"]
```

The slug (`my_plugin_output_json`) can then be used in `accepts[].type` and
`produces[].type` in your pipeline manifests. Prefix slugs with your plugin name
to avoid conflicts with core types or other plugins.

---

## Discovery order

NeuroForge scans the following locations for plugins, in order:

1. Paths listed in `NEUROFORGE_PLUGINS_DIRS` env var (colon-separated)
2. `/plugins-user` (Docker: optional user-supplied volume mount)
3. `/plugins` (Docker: core plugins shipped with the image)
4. `<repo-root>/plugins` (local development)

Each immediate subdirectory of a scan root that contains a `plugin.yaml` file
is treated as a plugin. Symlinks are followed; duplicate real paths are skipped.

**Docker volume mount** — to load your own plugins without rebuilding the image,
add a volume mount to `docker-compose.yml`:

```yaml
services:
  backend:
    volumes:
      - ./my-plugins:/plugins-user:ro
```

---

## Disabling a plugin

Set `enabled: false` in `plugin.yaml`. The plugin appears in the Plugins page
with status **Disabled** but its pipelines and artifact types are not registered:

```yaml
id: my-plugin
# ... other fields ...
enabled: false
```

---

## Plugin manifest reference

All fields supported in `plugin.yaml`:

| Field | Required | Type | Description |
|---|---|---|---|
| `id` | yes | string | Unique identifier. Pattern: `^[a-z][a-z0-9_-]*$` |
| `name` | yes | string | Human-readable name shown in the Plugins page |
| `version` | yes | string | Semantic version (e.g. `1.0.0` or `0.2.1-alpha`) |
| `author` | yes | string | Author or organization name |
| `description` | yes | string | Description of what the plugin provides |
| `homepage` | no | URI | URL to documentation or repository |
| `license` | no | string | SPDX identifier (e.g. `Apache-2.0`, `MIT`) |
| `neuroforge_version` | no | string | Required NeuroForge version range (informational only) |
| `dependencies` | no | list[string] | Python packages needed (informational; you must install them) |
| `enabled` | no | boolean | Set to `false` to disable (default: `true`) |

---

## Plugin directory layout

```
plugins/
  my-plugin/              ← plugin root (directory name doesn't matter)
    plugin.yaml           ← required: plugin identity
    pipelines/            ← optional: pipeline manifests
      my-tool.yaml
    artifact_types.yaml   ← optional: new artifact type definitions
    backend/              ← optional: native executables (added to PATH)
      my-tool-cli
    README.md             ← optional: developer documentation
```

---

## Testing your plugin locally

The easiest way to test is during local development (outside Docker):

```bash
# From the repository root
export NEUROFORGE_PLUGINS_DIRS=/path/to/your/plugins

# Start the backend
cd backend
uv run uvicorn app.main:app --reload
```

The Plugins page at `http://localhost:5173/plugins` will show your plugin's status.

To run the backend test suite against your plugin:

```bash
cd backend
NEUROFORGE_PLUGINS_DIRS=/path/to/your/plugins uv run pytest tests/test_plugin_loader.py -v
```

---

## Example plugin

The `plugins/image-statistics/` directory ships as a working example.
It demonstrates every plugin feature: `plugin.yaml`, a native pipeline manifest,
`artifact_types.yaml`, and a `backend/` executable script.

See [`plugins/image-statistics/README.md`](../plugins/image-statistics/README.md)
for details.

---

## Best practices

- **Prefix everything with your plugin id** — pipeline IDs, artifact type slugs, and
  CLI command names should all be prefixed to avoid conflicts with core NeuroForge
  and other plugins (e.g. `my-plugin-my-tool`, `my_plugin_output_json`).
- **Use `execution.type: native`** for tools written in Python or shell — no Docker
  container overhead, works both inside and outside the NeuroForge Docker setup.
- **Declare `accepts[]` and `produces[]`** — this enables Run Next suggestions in
  the UI and allows your pipeline to participate in automated workflow chaining.
- **Write `known_errors`** — users will see plain-English error explanations when
  your tool fails. See `pipelines/brainchop.yaml` for examples.
- **Keep executables self-contained** — scripts in `backend/` should import only
  packages already in the NeuroForge backend image (`nibabel`, `numpy`, `scipy`,
  etc.) or document their extra dependencies clearly in `plugin.yaml:dependencies`.
- **Test with the real plugin loader** — call `load_all_plugins()` in your tests
  and assert on `plugin.status == "ok"`. See `backend/tests/test_plugin_loader.py`
  for patterns.
