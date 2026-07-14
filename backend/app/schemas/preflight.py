from typing import Any, Literal

from pydantic import BaseModel, Field


PreflightStatus = Literal["pass", "warning", "fail", "unknown"]


class PreflightCheck(BaseModel):
    id: str
    label: str
    status: PreflightStatus
    message: str
    remediation: str | None = None
    blocking: bool = False
    measured_value: str | float | int | bool | None = None
    required_value: str | float | int | bool | None = None


class PipelinePreflightRequest(BaseModel):
    dataset_id: int | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class PipelinePreflightResponse(BaseModel):
    pipeline_id: str
    empirical_status: str
    can_launch: bool
    checks: list[PreflightCheck]
