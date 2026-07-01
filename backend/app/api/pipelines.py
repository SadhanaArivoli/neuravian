from fastapi import APIRouter, HTTPException
from typing import Any

from app.services.pipeline import PipelineService

router = APIRouter(tags=["pipelines"])

_svc = PipelineService()


@router.get("/pipelines")
def list_pipelines() -> list[dict[str, Any]]:
    return _svc.list_all()


@router.get("/pipelines/{pipeline_id}")
def get_pipeline(pipeline_id: str) -> dict[str, Any]:
    manifest = _svc.get_by_id(pipeline_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail=f"Pipeline '{pipeline_id}' not found")
    return manifest
