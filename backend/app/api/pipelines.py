from fastapi import APIRouter, HTTPException, Query
from typing import Any

from app.services.pipeline import PipelineService

router = APIRouter(tags=["pipelines"])

_svc = PipelineService()

# Stable sort order for compute_profile — most usable locally first.
_PROFILE_ORDER = {"local-ok": 0, "local-slow": 1, "local-unsafe": 2}


@router.get("/pipelines")
def list_pipelines() -> list[dict[str, Any]]:
    return _svc.list_all()


@router.get("/pipelines/compatible")
def list_compatible_pipelines(
    artifact_type: str = Query(..., description="Artifact type slug to match against accepts[].type"),
) -> list[dict[str, Any]]:
    """Return pipelines whose manifests declare an accepts[] entry matching artifact_type.

    Each result represents one accept slot — if a pipeline has two slots with the
    same type (rare), two entries are returned so the caller knows which param to fill.

    Unknown artifact types return an empty list (not an error).
    """
    results: list[dict[str, Any]] = []

    for manifest in _svc._registry.values():
        for slot in manifest.get("accepts", []):
            if slot.get("type") != artifact_type:
                continue
            results.append({
                "pipeline_id": manifest["id"],
                "display_name": manifest["display_name"],
                "category": manifest.get("category"),
                "input_type": manifest.get("input_type"),
                "compute_profile": manifest.get("compute_profile"),
                "pipeline_description": manifest.get("description"),
                "accept_type": slot.get("type"),
                "accept_param": slot.get("param"),
                "accept_dataset_slot": slot.get("dataset_slot", False),
                "accept_label": slot.get("label"),
                "accept_description": slot.get("description"),
            })

    # Sort: local-ok first, then local-slow, then local-unsafe, then None;
    # within each tier, alphabetically by display_name for stability.
    results.sort(key=lambda r: (
        _PROFILE_ORDER.get(r["compute_profile"] or "", 99),
        (r["display_name"] or "").lower(),
    ))

    return results


@router.get("/pipelines/{pipeline_id}")
def get_pipeline(pipeline_id: str) -> dict[str, Any]:
    manifest = _svc.get_by_id(pipeline_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    return manifest
