import platform
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "neuroforge-backend"}


def _git_commit() -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3,
            cwd=Path(__file__).parent.parent.parent.parent,
        )
        return result.stdout.strip() if result.returncode == 0 else "unknown"
    except Exception:
        return "unknown"


def _package_version() -> str:
    try:
        from importlib.metadata import version
        return version("neuroforge-backend")
    except Exception:
        return "0.1.0"


@router.get("/about")
async def about() -> dict:
    return {
        "app_name": "NeuroForge",
        "version": "0.1.0-alpha",
        "backend_version": _package_version(),
        "frontend_version": "0.1.0-alpha",
        "git_commit": _git_commit(),
        "python_version": sys.version.split()[0],
        "platform": platform.platform(),
        "license": "Apache 2.0",
        "github": "https://github.com/SadhanaArivoli/neuroforge",
    }
