from datetime import datetime
from typing import Any

from pydantic import BaseModel


class LineageCreate(BaseModel):
    """Ephemeral lineage metadata passed by the frontend when a run is launched
    from a Run Next recommendation. Stored durably; never affects execution."""
    upstream_run_id: int
    upstream_pipeline_id: str
    upstream_pipeline_display_name: str | None = None
    artifact_type: str
    artifact_label: str
    injected_param: str | None = None
    injected_path: str | None = None


class RunCreate(BaseModel):
    pipeline_id: str   # manifest string id, e.g. "mriqc"
    dataset_id: int
    params: dict[str, Any] = {}
    lineage: LineageCreate | None = None


class ResourceWarningSchema(BaseModel):
    level: str
    message: str


class RunRead(BaseModel):
    id: int
    pipeline_manifest_id: str   # manifest string id (from pipelines.name join)
    pipeline_version: str
    dataset_id: int
    status: str
    params: dict[str, Any]
    command_preview: str | None
    output_dir: str | None
    error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    resource_warnings: list[ResourceWarningSchema] = []
    progress: dict | None = None

    model_config = {"from_attributes": True}


class RunSummary(BaseModel):
    id: int
    pipeline_manifest_id: str
    pipeline_version: str
    dataset_id: int
    status: str
    source_run_id: int | None = None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}
