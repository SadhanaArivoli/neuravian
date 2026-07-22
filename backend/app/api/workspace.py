import hashlib
import os
import uuid
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(tags=["workspace"])

_IDENTITY_NAMESPACE = uuid.UUID("f48509fe-f7eb-4f55-8414-11d600ab858d")
_MACHINE_ID_PATHS = (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id"))


def _server_identity_source() -> str:
    configured = os.getenv("NEURAVIAN_SERVER_ID", "").strip()
    if configured:
        return f"configured:{configured}"
    for candidate in _MACHINE_ID_PATHS:
        try:
            value = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return f"machine:{value}"
    # This fallback is deterministic for a given installation without exposing
    # the database path. Production deployments should have a machine ID or set
    # NEURAVIAN_SERVER_ID explicitly.
    from app.core.config import settings

    return f"installation:{settings.data_dir}"


def server_identity() -> str:
    source_digest = hashlib.sha256(_server_identity_source().encode("utf-8")).hexdigest()
    return str(uuid.uuid5(_IDENTITY_NAMESPACE, source_digest))


@router.get("/workspace/identity")
async def workspace_identity() -> dict[str, str]:
    return {
        "workspace_id": server_identity(),
        "product": "Neuravian",
        "api_version": "1",
    }
