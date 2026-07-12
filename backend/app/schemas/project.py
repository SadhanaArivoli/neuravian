from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel, field_validator, model_validator


# ── helpers ───────────────────────────────────────────────────────────────────

def _parse_json_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            return [str(x) for x in parsed] if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []


# ── Project ───────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    title: str
    description: str | None = None
    institution: str | None = None
    lab: str | None = None
    pi_name: str | None = None
    collaborators: list[str] = []
    tags: list[str] = []
    status: str = "active"


class ProjectUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    institution: str | None = None
    lab: str | None = None
    pi_name: str | None = None
    collaborators: list[str] | None = None
    tags: list[str] | None = None
    status: str | None = None


class ProjectSummary(BaseModel):
    id: int
    title: str
    description: str | None
    institution: str | None
    lab: str | None
    pi_name: str | None
    collaborators: list[str]
    tags: list[str]
    status: str
    dataset_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def parse_json_fields(cls, data: Any) -> Any:
        if hasattr(data, "__dict__"):
            obj = data.__dict__.copy()
            obj["collaborators"] = _parse_json_list(getattr(data, "collaborators_json", None))
            obj["tags"] = _parse_json_list(getattr(data, "tags_json", None))
            obj.setdefault("dataset_count", 0)
            return obj
        return data


class ProjectRead(ProjectSummary):
    note_count: int = 0


# ── Project Note ──────────────────────────────────────────────────────────────

class ProjectNoteCreate(BaseModel):
    title: str
    content_md: str = ""


class ProjectNoteUpdate(BaseModel):
    title: str | None = None
    content_md: str | None = None


class ProjectNoteRead(BaseModel):
    id: int
    project_id: int
    title: str
    content_md: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Timeline event ────────────────────────────────────────────────────────────

class TimelineEvent(BaseModel):
    event_type: str
    label: str
    details: dict[str, Any] = {}
    timestamp: str


# ── Publication status ────────────────────────────────────────────────────────

class PublicationCheckItem(BaseModel):
    key: str
    label: str
    done: bool
    detail: str | None = None


class PublicationStatus(BaseModel):
    checklist: list[PublicationCheckItem]
    completion_pct: int


# ── Project stats ─────────────────────────────────────────────────────────────

class ProjectStats(BaseModel):
    dataset_count: int
    run_count: int
    success_run_count: int
    report_count: int
    note_count: int
    pipeline_breakdown: dict[str, int]   # pipeline_manifest_id → count
    storage_bytes: int
