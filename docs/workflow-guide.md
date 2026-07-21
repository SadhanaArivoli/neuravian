# Workflow Guide

## Build a first workflow

1. Open **Workflows** and select **New Workflow**.
2. Choose a template or **Blank Workflow**.
3. Select an existing dataset or a completed run as the source.
4. Use **Find compatible steps**. Recommendations come from manifest-declared
   artifact types; incompatible pipelines are not offered.
5. Add and configure one step at a time, then save the workflow.
6. Review **Planned execution** before pressing **Run workflow**.

## Execution locations

- **Local OK** runs locally by default.
- **Slow locally / Cloud recommended** can transition to a configured cloud
  workspace when the planner determines a handoff is appropriate.
- Completed local nodes are not rerun after handoff.

## Example: BET to FLIRT

Use a completed `dcm2niix` run exposing `nifti_raw` as the source. Add **FSL
BET**, then add **FSL FLIRT** from BET's `nifti_skull_stripped` output. BET runs
locally. With a cloud workspace configured, FLIRT enters the handoff-required
state. Select the workspace and press **Continue in Cloud**.

The workflow history records node location, run IDs, parameters, lineage,
transfer state, errors, and result synchronization. A failed handoff can be
retried; the idempotency key prevents a duplicate workflow execution.
