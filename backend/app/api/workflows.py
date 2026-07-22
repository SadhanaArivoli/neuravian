import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.dataset import Dataset
from app.models.workflow import SavedWorkflow
from app.models.workflow_execution import WorkflowExecution, WorkflowTransfer
from app.schemas.workflow import (
    WorkflowCreate,
    WorkflowDatasetCreate,
    WorkflowDatasetRead,
    WorkflowExecutionCreate,
    WorkflowExecutionRead,
    WorkflowExecutionUpdate,
    WorkflowRead,
    WorkflowSummary,
    WorkflowTransferRead,
    WorkflowUpdate,
)

router = APIRouter(tags=["workflows"])

CURRENT_SCHEMA_VERSION = "neuravian-workflow-v1"
EXECUTION_STATUSES = {
    "planned", "running-local", "handoff-required", "synchronizing-inputs",
    "starting-remote", "running-remote", "synchronizing-results", "failed", "complete",
}
ARTIFACT_KEY = re.compile(r"^[A-Za-z0-9._-]{1,256}$")


def _row_to_summary(row: SavedWorkflow) -> WorkflowSummary:
    tags = json.loads(row.tags_json) if row.tags_json else []
    state = json.loads(row.state_json) if row.state_json else {}
    node_count = len(state.get("nodes", []))
    return WorkflowSummary(
        id=row.id,
        name=row.name,
        description=row.description,
        dataset_id=row.dataset_id,
        tags=tags,
        schema_version=row.schema_version,
        is_template=row.is_template,
        is_favorite=row.is_favorite,
        is_archived=row.is_archived,
        template_source_id=row.template_source_id,
        node_count=node_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _row_to_read(row: SavedWorkflow) -> WorkflowRead:
    tags = json.loads(row.tags_json) if row.tags_json else []
    state = json.loads(row.state_json) if row.state_json else {}
    return WorkflowRead(
        id=row.id,
        name=row.name,
        description=row.description,
        dataset_id=row.dataset_id,
        tags=tags,
        state=state,
        schema_version=row.schema_version,
        is_template=row.is_template,
        is_favorite=row.is_favorite,
        is_archived=row.is_archived,
        template_source_id=row.template_source_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _execution_to_read(row: WorkflowExecution) -> WorkflowExecutionRead:
    return WorkflowExecutionRead(
        id=row.id, execution_uuid=row.execution_uuid, workflow_id=row.workflow_id,
        idempotency_key=row.idempotency_key, status=row.status,
        current_node_id=row.current_node_id, remote_profile_id=row.remote_profile_id,
        state=json.loads(row.state_json), revision=row.revision,
        return_sync_complete=row.return_sync_complete,
        created_at=row.created_at, updated_at=row.updated_at,
    )


def _transfer_to_read(row: WorkflowTransfer) -> WorkflowTransferRead:
    return WorkflowTransferRead(
        artifact_key=row.artifact_key, relative_path=row.relative_path,
        sha256=row.sha256, size_bytes=row.size_bytes,
        bytes_received=row.bytes_received, status=row.status,
        staged_path=row.local_path,
    )


@router.get("/workflows")
def list_workflows(db: Session = Depends(get_db)) -> list[WorkflowSummary]:
    rows = db.query(SavedWorkflow).order_by(SavedWorkflow.updated_at.desc()).all()
    return [_row_to_summary(r) for r in rows]


@router.post("/workflows", status_code=201)
def create_workflow(body: WorkflowCreate, db: Session = Depends(get_db)) -> WorkflowRead:
    if body.schema_version != CURRENT_SCHEMA_VERSION:
        raise HTTPException(status_code=400, detail=f"Unsupported schema version: {body.schema_version}")
    row = SavedWorkflow(
        name=body.name,
        description=body.description,
        dataset_id=body.dataset_id,
        tags_json=json.dumps(body.tags),
        state_json=json.dumps(body.state),
        schema_version=body.schema_version,
        is_template=body.is_template,
        is_favorite=body.is_favorite,
        is_archived=body.is_archived,
        template_source_id=body.template_source_id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _row_to_read(row)


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: int, db: Session = Depends(get_db)) -> WorkflowRead:
    row = db.get(SavedWorkflow, workflow_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    return _row_to_read(row)


@router.patch("/workflows/{workflow_id}")
def update_workflow(workflow_id: int, body: WorkflowUpdate, db: Session = Depends(get_db)) -> WorkflowRead:
    row = db.get(SavedWorkflow, workflow_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    if body.name is not None:
        row.name = body.name
    if body.description is not None:
        row.description = body.description
    if body.dataset_id is not None:
        row.dataset_id = body.dataset_id
    if body.tags is not None:
        row.tags_json = json.dumps(body.tags)
    if body.state is not None:
        row.state_json = json.dumps(body.state)
    if body.is_template is not None:
        row.is_template = body.is_template
    if body.is_favorite is not None:
        row.is_favorite = body.is_favorite
    if body.is_archived is not None:
        row.is_archived = body.is_archived
    row.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(row)
    return _row_to_read(row)


@router.delete("/workflows/{workflow_id}", status_code=204)
def delete_workflow(workflow_id: int, db: Session = Depends(get_db)) -> None:
    row = db.get(SavedWorkflow, workflow_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    db.delete(row)
    db.commit()


@router.post("/workflows/{workflow_id}/duplicate", status_code=201)
def duplicate_workflow(workflow_id: int, db: Session = Depends(get_db)) -> WorkflowRead:
    row = db.get(SavedWorkflow, workflow_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    now = datetime.now(UTC)
    copy = SavedWorkflow(
        name=f"{row.name} (copy)",
        description=row.description,
        dataset_id=row.dataset_id,
        tags_json=row.tags_json,
        state_json=row.state_json,
        schema_version=row.schema_version,
        is_template=False,   # copies are never templates by default
        is_favorite=False,
        is_archived=False,
        template_source_id=row.template_source_id,
        created_at=now,
        updated_at=now,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return _row_to_read(copy)


@router.post("/workflows/{workflow_id}/promote-template", status_code=201)
def promote_to_template(workflow_id: int, db: Session = Depends(get_db)) -> WorkflowRead:
    """Promote a saved workflow into a reusable template (independent copy)."""
    row = db.get(SavedWorkflow, workflow_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    now = datetime.now(UTC)
    tmpl = SavedWorkflow(
        name=f"{row.name} [Template]",
        description=row.description,
        dataset_id=None,   # templates are dataset-agnostic
        tags_json=row.tags_json,
        state_json=row.state_json,
        schema_version=row.schema_version,
        is_template=True,
        is_favorite=False,
        is_archived=False,
        template_source_id=row.id,
        created_at=now,
        updated_at=now,
    )
    db.add(tmpl)
    db.commit()
    db.refresh(tmpl)
    return _row_to_read(tmpl)


@router.post("/workflows/{workflow_id}/executions", status_code=201)
def create_workflow_execution(
    workflow_id: int, body: WorkflowExecutionCreate, db: Session = Depends(get_db),
) -> WorkflowExecutionRead:
    if not db.get(SavedWorkflow, workflow_id):
        raise HTTPException(status_code=404, detail=f"Workflow {workflow_id} not found")
    existing = db.query(WorkflowExecution).filter_by(
        workflow_id=workflow_id, idempotency_key=body.idempotency_key,
    ).first()
    if existing:
        return _execution_to_read(existing)
    execution_uuid = body.execution_uuid or str(uuid.uuid4())
    try:
        uuid.UUID(execution_uuid)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="execution_uuid must be a UUID") from exc
    row = WorkflowExecution(
        execution_uuid=execution_uuid, workflow_id=workflow_id,
        idempotency_key=body.idempotency_key, remote_profile_id=body.remote_profile_id,
        status="planned", state_json=json.dumps(body.state),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _execution_to_read(row)


@router.get("/workflow-executions/{execution_uuid}")
def get_workflow_execution(execution_uuid: str, db: Session = Depends(get_db)) -> WorkflowExecutionRead:
    row = db.query(WorkflowExecution).filter_by(execution_uuid=execution_uuid).first()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow execution not found")
    return _execution_to_read(row)


@router.patch("/workflow-executions/{execution_uuid}")
def update_workflow_execution(
    execution_uuid: str, body: WorkflowExecutionUpdate, db: Session = Depends(get_db),
) -> WorkflowExecutionRead:
    row = db.query(WorkflowExecution).filter_by(execution_uuid=execution_uuid).first()
    if not row:
        raise HTTPException(status_code=404, detail="Workflow execution not found")
    if row.revision != body.expected_revision:
        raise HTTPException(status_code=409, detail=f"Execution revision is {row.revision}")
    if body.status not in EXECUTION_STATUSES:
        raise HTTPException(status_code=400, detail="Invalid workflow execution status")
    if body.status == "complete" and not body.return_sync_complete:
        raise HTTPException(status_code=409, detail="Return synchronization must complete before the workflow completes")
    row.status = body.status
    row.current_node_id = body.current_node_id
    row.remote_profile_id = body.remote_profile_id or row.remote_profile_id
    row.return_sync_complete = body.return_sync_complete
    row.state_json = json.dumps(body.state)
    row.revision += 1
    row.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(row)
    return _execution_to_read(row)


def _transfer_root(execution_uuid: str) -> Path:
    root = Path(settings.data_dir).resolve() / "workflow-transfers" / execution_uuid / "inputs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _workflow_dataset_path(execution_uuid: str) -> Path:
    return (
        Path(settings.backend_datasets_mount)
        / ".neuravian-workflow-transfers"
        / execution_uuid
    )


@router.post(
    "/workflow-executions/{execution_uuid}/dataset",
    response_model=WorkflowDatasetRead,
)
def materialize_workflow_dataset(
    execution_uuid: str,
    body: WorkflowDatasetCreate,
    db: Session = Depends(get_db),
) -> WorkflowDatasetRead:
    """Create the cloud-local dataset identity used by a handed-off run."""
    execution = (
        db.query(WorkflowExecution)
        .filter_by(execution_uuid=execution_uuid)
        .first()
    )
    if not execution:
        raise HTTPException(status_code=404, detail="Workflow execution not found")

    path = str(_workflow_dataset_path(execution_uuid))
    dataset = db.query(Dataset).filter_by(path=path).first()
    if dataset is None:
        dataset = Dataset(
            name=body.name,
            path=path,
            validation_status="external",
            indexed_metadata=json.dumps(
                {
                    "workflow_execution_uuid": execution_uuid,
                    "source_dataset_id": body.source_dataset_id,
                }
            ),
        )
        db.add(dataset)
        db.commit()
        db.refresh(dataset)

    return WorkflowDatasetRead(
        id=dataset.id,
        source_dataset_id=body.source_dataset_id,
        name=dataset.name,
        path=dataset.path,
        workflow_execution_uuid=execution_uuid,
    )


@router.put("/workflow-executions/{execution_uuid}/inputs/{artifact_key}")
async def upload_workflow_input(
    execution_uuid: str, artifact_key: str, request: Request,
    x_neuravian_sha256: str = Header(...), x_neuravian_relative_path: str = Header(...),
    db: Session = Depends(get_db),
) -> WorkflowTransferRead:
    execution = db.query(WorkflowExecution).filter_by(execution_uuid=execution_uuid).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Workflow execution not found")
    if not ARTIFACT_KEY.fullmatch(artifact_key):
        raise HTTPException(status_code=400, detail="Invalid artifact key")
    relative = Path(x_neuravian_relative_path)
    if relative.is_absolute() or ".." in relative.parts or not relative.name:
        raise HTTPException(status_code=400, detail="Invalid relative artifact path")
    if not re.fullmatch(r"[0-9a-f]{64}", x_neuravian_sha256.lower()):
        raise HTTPException(status_code=400, detail="Invalid SHA-256")
    payload = await request.body()
    digest = hashlib.sha256(payload).hexdigest()
    if digest != x_neuravian_sha256.lower():
        raise HTTPException(status_code=422, detail="Artifact checksum mismatch")
    existing = db.query(WorkflowTransfer).filter_by(
        execution_id=execution.id, artifact_key=artifact_key,
    ).first()
    if existing and existing.status == "complete" and existing.sha256 == digest and existing.size_bytes == len(payload):
        return _transfer_to_read(existing)
    destination = (_transfer_root(execution_uuid) / relative).resolve()
    root = _transfer_root(execution_uuid)
    if not destination.is_relative_to(root):
        raise HTTPException(status_code=400, detail="Artifact path escapes transfer root")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    temporary.write_bytes(payload)
    temporary.replace(destination)
    row = existing or WorkflowTransfer(execution_id=execution.id, artifact_key=artifact_key)
    row.relative_path = relative.as_posix()
    row.sha256 = digest
    row.size_bytes = len(payload)
    row.bytes_received = len(payload)
    row.status = "complete"
    row.local_path = str(destination)
    row.updated_at = datetime.now(UTC)
    if not existing:
        db.add(row)
    db.commit()
    db.refresh(row)
    return _transfer_to_read(row)


@router.get("/workflow-executions/{execution_uuid}/inputs")
def list_workflow_inputs(execution_uuid: str, db: Session = Depends(get_db)) -> list[WorkflowTransferRead]:
    execution = db.query(WorkflowExecution).filter_by(execution_uuid=execution_uuid).first()
    if not execution:
        raise HTTPException(status_code=404, detail="Workflow execution not found")
    rows = db.query(WorkflowTransfer).filter_by(execution_id=execution.id).order_by(WorkflowTransfer.artifact_key).all()
    return [_transfer_to_read(row) for row in rows]
