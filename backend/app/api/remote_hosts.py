from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.remote_host import RemoteHost
from app.schemas.remote_host import (
    PreflightResult,
    RemoteHostCreate,
    RemoteHostRead,
    RemoteHostUpdate,
)

router = APIRouter(tags=["remote-hosts"])


@router.get("/remote-hosts")
def list_remote_hosts(db: Session = Depends(get_db)) -> list[RemoteHostRead]:
    hosts = db.query(RemoteHost).order_by(RemoteHost.display_name).all()
    return [RemoteHostRead.model_validate(h) for h in hosts]


@router.post("/remote-hosts", status_code=201)
def create_remote_host(
    body: RemoteHostCreate,
    db: Session = Depends(get_db),
) -> RemoteHostRead:
    host = RemoteHost(**body.model_dump())
    db.add(host)
    db.commit()
    db.refresh(host)
    return RemoteHostRead.model_validate(host)


@router.get("/remote-hosts/{host_id}")
def get_remote_host(host_id: int, db: Session = Depends(get_db)) -> RemoteHostRead:
    host = db.get(RemoteHost, host_id)
    if not host:
        raise HTTPException(status_code=404, detail=f"Remote host {host_id} not found")
    return RemoteHostRead.model_validate(host)


@router.put("/remote-hosts/{host_id}")
def update_remote_host(
    host_id: int,
    body: RemoteHostUpdate,
    db: Session = Depends(get_db),
) -> RemoteHostRead:
    host = db.get(RemoteHost, host_id)
    if not host:
        raise HTTPException(status_code=404, detail=f"Remote host {host_id} not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(host, field, value)
    host.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(host)
    return RemoteHostRead.model_validate(host)


@router.delete("/remote-hosts/{host_id}", status_code=204)
def delete_remote_host(host_id: int, db: Session = Depends(get_db)) -> None:
    host = db.get(RemoteHost, host_id)
    if not host:
        raise HTTPException(status_code=404, detail=f"Remote host {host_id} not found")
    db.delete(host)
    db.commit()


@router.post("/remote-hosts/{host_id}/preflight")
def preflight_remote_host(host_id: int, db: Session = Depends(get_db)) -> PreflightResult:
    host = db.get(RemoteHost, host_id)
    if not host:
        raise HTTPException(status_code=404, detail=f"Remote host {host_id} not found")

    from app.execution.ssh_executor import run_preflight

    cfg = {
        "hostname": host.hostname,
        "ssh_port": host.ssh_port,
        "username": host.username,
        "key_path": host.key_path,
        "remote_work_root": host.remote_work_root,
        "docker_host": host.docker_host,
    }
    return run_preflight(cfg)
