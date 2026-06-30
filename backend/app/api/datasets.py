from fastapi import APIRouter, Depends, HTTPException, status
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
