from datetime import datetime

from pydantic import BaseModel, field_validator


class RemoteHostCreate(BaseModel):
    display_name: str
    hostname: str
    ssh_port: int = 22
    username: str
    key_path: str
    remote_work_root: str
    docker_host: str | None = None
    enabled: bool = True
    notes: str | None = None

    @field_validator("key_path")
    @classmethod
    def key_path_absolute(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError("key_path must be an absolute path")
        return v

    @field_validator("remote_work_root")
    @classmethod
    def remote_work_root_absolute(cls, v: str) -> str:
        if not v.startswith("/"):
            raise ValueError("remote_work_root must be an absolute path")
        return v


class RemoteHostUpdate(BaseModel):
    display_name: str | None = None
    hostname: str | None = None
    ssh_port: int | None = None
    username: str | None = None
    key_path: str | None = None
    remote_work_root: str | None = None
    docker_host: str | None = None
    enabled: bool | None = None
    notes: str | None = None


class RemoteHostRead(BaseModel):
    id: int
    display_name: str
    hostname: str
    ssh_port: int
    username: str
    key_path: str
    remote_work_root: str
    docker_host: str | None
    enabled: bool
    notes: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PreflightCheck(BaseModel):
    name: str
    passed: bool
    value: str | None = None
    detail: str | None = None


class PreflightResult(BaseModel):
    connected: bool
    checks: list[PreflightCheck]
    errors: list[str]
    warnings: list[str]
