from datetime import datetime

from pydantic import BaseModel, field_validator


class ValidationIssue(BaseModel):
    code: str
    message: str
    friendly: str
    fix_hint: str | None = None
    files: list[str] = []


class ValidationIssues(BaseModel):
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []


class IndexedMetadata(BaseModel):
    name: str | None = None
    bids_version: str | None = None
    subjects: list[str] = []
    sessions: list[str] = []
    tasks: list[str] = []
    datatypes: list[str] = []
    suffixes: list[str] = []
    file_count: int = 0


class DatasetCreate(BaseModel):
    path: str

    @field_validator("path")
    @classmethod
    def path_must_not_be_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("path must not be empty")
        return v.strip()


class DatasetRead(BaseModel):
    id: int
    name: str | None
    path: str
    bids_version: str | None
    validation_status: str
    validation_issues: ValidationIssues | None
    indexed_metadata: IndexedMetadata | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DatasetSummary(BaseModel):
    id: int
    name: str | None
    path: str
    validation_status: str
    bids_version: str | None
    subject_count: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}
