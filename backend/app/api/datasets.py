from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.schemas.dataset import DatasetCreate, DatasetRead, DatasetSummary
from app.services.dataset import DatasetService

router = APIRouter(prefix="/datasets", tags=["datasets"])


def _svc(db: Session = Depends(get_db)) -> DatasetService:
    return DatasetService(db)


@router.post("", response_model=DatasetRead, status_code=status.HTTP_201_CREATED)
def register_dataset(
    payload: DatasetCreate,
    svc: DatasetService = Depends(_svc),
) -> DatasetRead:
    try:
        return svc.register(payload)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("", response_model=list[DatasetSummary])
def list_datasets(svc: DatasetService = Depends(_svc)) -> list[DatasetSummary]:
    return svc.list_all()


@router.get("/{dataset_id}", response_model=DatasetRead)
def get_dataset(dataset_id: int, svc: DatasetService = Depends(_svc)) -> DatasetRead:
    try:
        return svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))


@router.get("/{dataset_id}/scans")
def list_dataset_scans(dataset_id: int, svc: DatasetService = Depends(_svc)) -> dict:
    """List NIfTI scan files in the dataset, grouped by path components.

    Uses a simple filesystem walk — no pybids re-indexing per request.
    Only returns .nii and .nii.gz files whose paths follow BIDS structure
    (must start with a sub-* directory).
    """
    try:
        dataset = svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    root = Path(dataset.path)
    if not root.exists():
        return {"scans": []}

    scans = []
    for f in sorted(root.rglob("*")):
        if not (f.name.endswith(".nii.gz") or f.name.endswith(".nii")):
            continue
        try:
            rel = f.relative_to(root)
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) < 2 or not parts[0].startswith("sub-"):
            continue

        subject = parts[0][4:]  # strip "sub-"
        # Detect optional session level
        session: str | None = None
        datatype_idx = 1
        if len(parts) > 2 and parts[1].startswith("ses-"):
            session = parts[1][4:]  # strip "ses-"
            datatype_idx = 2

        datatype = parts[datatype_idx] if datatype_idx < len(parts) - 1 else None

        # Suffix: last "_"-separated token of the stem (strip .nii or .nii.gz)
        stem = f.name[:-7] if f.name.endswith(".nii.gz") else f.name[:-4]
        suffix = stem.rsplit("_", 1)[-1] if "_" in stem else stem

        scans.append({
            "subject": subject,
            "session": session,
            "datatype": datatype,
            "suffix": suffix,
            "path": rel.as_posix(),
        })

    return {"scans": scans}


@router.get("/{dataset_id}/files/{file_path:path}")
def serve_dataset_file(
    dataset_id: int,
    file_path: str,
    svc: DatasetService = Depends(_svc),
) -> FileResponse:
    """Serve a file from the dataset's root directory (read-only).

    Scoped strictly to each dataset's own directory — path traversal
    attempts (../../etc/passwd, encoded variants) are rejected with 403.
    """
    try:
        dataset = svc.get_by_id(dataset_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    dataset_root = Path(dataset.path).resolve()
    requested = (dataset_root / file_path).resolve()

    # Path traversal protection: raises ValueError if outside dataset_root
    try:
        requested.relative_to(dataset_root)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Path not allowed")

    if not requested.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    return FileResponse(str(requested))
