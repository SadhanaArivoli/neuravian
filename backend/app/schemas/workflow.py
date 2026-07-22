from datetime import datetime

from pydantic import BaseModel, Field


class WorkflowCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str | None = None
    dataset_id: int | None = None
    tags: list[str] = Field(default_factory=list)
    state: dict = Field(...)  # raw WorkflowState object from the builder
    schema_version: str = "neuravian-workflow-v1"
    is_template: bool = False
    is_favorite: bool = False
    is_archived: bool = False
    template_source_id: int | None = None


class WorkflowUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=256)
    description: str | None = None
    dataset_id: int | None = None
    tags: list[str] | None = None
    state: dict | None = None
    is_template: bool | None = None
    is_favorite: bool | None = None
    is_archived: bool | None = None


class WorkflowRead(BaseModel):
    id: int
    name: str
    description: str | None
    dataset_id: int | None
    tags: list[str]
    state: dict
    schema_version: str
    is_template: bool
    is_favorite: bool
    is_archived: bool
    template_source_id: int | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WorkflowSummary(BaseModel):
    id: int
    name: str
    description: str | None
    dataset_id: int | None
    tags: list[str]
    schema_version: str
    is_template: bool
    is_favorite: bool
    is_archived: bool
    template_source_id: int | None
    node_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class WorkflowExecutionCreate(BaseModel):
    idempotency_key: str = Field(..., min_length=1, max_length=128)
    execution_uuid: str | None = None
    remote_profile_id: str | None = Field(None, max_length=128)
    state: dict


class WorkflowExecutionUpdate(BaseModel):
    expected_revision: int = Field(..., ge=1)
    status: str
    current_node_id: str | None = None
    remote_profile_id: str | None = None
    return_sync_complete: bool = False
    state: dict


class WorkflowExecutionRead(BaseModel):
    id: int
    execution_uuid: str
    workflow_id: int
    idempotency_key: str
    status: str
    current_node_id: str | None
    remote_profile_id: str | None
    state: dict
    revision: int
    return_sync_complete: bool
    created_at: datetime
    updated_at: datetime


class WorkflowTransferRead(BaseModel):
    artifact_key: str
    relative_path: str
    sha256: str
    size_bytes: int
    bytes_received: int
    status: str
    staged_path: str | None = None


class WorkflowDatasetCreate(BaseModel):
    source_dataset_id: int = Field(..., ge=1)
    name: str | None = Field(None, max_length=256)


class WorkflowDatasetRead(BaseModel):
    id: int
    source_dataset_id: int
    name: str | None
    path: str
    workflow_execution_uuid: str
