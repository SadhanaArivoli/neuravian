from datetime import datetime
from typing import Any

from pydantic import BaseModel


class RunCreate(BaseModel):
    pipeline_id: str   # manifest string id, e.g. "mriqc"
    dataset_id: int
    params: dict[str, Any] = {}


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

    model_config = {"from_attributes": True}


class RunSummary(BaseModel):
    id: int
    pipeline_manifest_id: str
    pipeline_version: str
    dataset_id: int
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}
