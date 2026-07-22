"""Plugins API — list all installed plugins and their status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

router = APIRouter(tags=["plugins"])


@router.get("/plugins")
def list_plugins() -> list[dict[str, Any]]:
    """Return every discovered plugin with its id, name, version, status, and registered content."""
    from app.services.plugin_loader import get_plugins

    result = []
    for p in get_plugins():
        result.append(
            {
                "id": p.id,
                "name": p.name,
                "version": p.version,
                "author": p.author,
                "description": p.description,
                "homepage": p.homepage,
                "license": p.license,
                "neuravian_version": p.neuravian_version,
                "dependencies": p.dependencies,
                "enabled": p.enabled,
                "status": p.status,
                "error": p.error,
                "pipeline_ids": p.pipeline_ids,
                "artifact_type_slugs": p.artifact_type_slugs,
                "plugin_dir": str(p.plugin_dir),
            }
        )
    return result
