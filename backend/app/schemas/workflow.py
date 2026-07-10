from datetime import datetime

from pydantic import BaseModel, Field


class WorkflowCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str | None = None
    dataset_id: int | None = None
    tags: list[str] = Field(default_factory=list)
    state: dict = Field(...)  # raw WorkflowState object from the builder
    schema_version: str = "neuroforge-workflow-v1"
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
