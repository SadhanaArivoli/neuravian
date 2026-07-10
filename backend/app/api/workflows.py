import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.workflow import SavedWorkflow
from app.schemas.workflow import WorkflowCreate, WorkflowRead, WorkflowSummary, WorkflowUpdate

router = APIRouter(tags=["workflows"])

CURRENT_SCHEMA_VERSION = "neuroforge-workflow-v1"


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
