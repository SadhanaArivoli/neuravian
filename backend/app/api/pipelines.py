from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Any

from app.core.database import get_db
from app.models.dataset import Dataset
from app.schemas.preflight import PipelinePreflightRequest, PipelinePreflightResponse
from app.services.pipeline import PipelineService
from app.services.preflight import PreflightService

router = APIRouter(tags=["pipelines"])

# Initialized lazily on first request so plugin discovery (load_all_plugins)
# in the FastAPI lifespan runs before the registry is built.
_svc: PipelineService | None = None

def _get_svc() -> PipelineService:
    global _svc
    if _svc is None:
        _svc = PipelineService()
    return _svc

# Stable sort order for compute_profile — most usable locally first.
_PROFILE_ORDER = {"local-ok": 0, "local-slow": 1, "local-unsafe": 2}


@router.get("/pipelines")
def list_pipelines() -> list[dict[str, Any]]:
    return _get_svc().list_all()


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

    for manifest in _get_svc()._registry.values():
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
    manifest = _get_svc().get_by_id(pipeline_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    return manifest


@router.get("/pipelines/{pipeline_id}/preflight", response_model=PipelinePreflightResponse)
def get_pipeline_preflight(pipeline_id: str) -> PipelinePreflightResponse:
    manifest = _get_svc().get_by_id(pipeline_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    return PreflightService().run(manifest)


@router.post("/pipelines/{pipeline_id}/preflight", response_model=PipelinePreflightResponse)
def post_pipeline_preflight(
    pipeline_id: str,
    payload: PipelinePreflightRequest,
    db: Session = Depends(get_db),
) -> PipelinePreflightResponse:
    manifest = _get_svc().get_by_id(pipeline_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    dataset = None
    if payload.dataset_id is not None:
        dataset = db.get(Dataset, payload.dataset_id)
        if dataset is None:
            raise HTTPException(status_code=404, detail=f"Dataset {payload.dataset_id} not found")
    return PreflightService().run(
        manifest,
        dataset=dataset,
        params=payload.params,
        parameterized=True,
    )
