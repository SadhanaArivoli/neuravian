"""Projects API — research project management layer."""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.dataset import Dataset
from app.models.pipeline import Pipeline
from app.models.project import Project, ProjectNote
from app.models.report import Report
from app.models.run import Run
from app.schemas.project import (
    ProjectCreate,
    ProjectNoteCreate,
    ProjectNoteRead,
    ProjectNoteUpdate,
    ProjectRead,
    ProjectStats,
    ProjectSummary,
    ProjectUpdate,
    PublicationCheckItem,
    PublicationStatus,
    TimelineEvent,
)

router = APIRouter(prefix="/projects", tags=["projects"])


# ── helpers ───────────────────────────────────────────────────────────────────

def _get_project_or_404(project_id: int, db: Session) -> Project:
    proj = db.get(Project, project_id)
    if proj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project {project_id} not found")
    return proj


def _project_dataset_ids(project_id: int, db: Session) -> list[int]:
    rows = db.query(Dataset.id).filter(Dataset.project_id == project_id).all()
    return [r[0] for r in rows]


def _to_summary(proj: Project, db: Session) -> ProjectSummary:
    ds_count = db.query(func.count(Dataset.id)).filter(Dataset.project_id == proj.id).scalar() or 0
    d = {
        "id": proj.id,
        "title": proj.title,
        "description": proj.description,
        "institution": proj.institution,
        "lab": proj.lab,
        "pi_name": proj.pi_name,
        "collaborators": _parse_json_list(proj.collaborators_json),
        "tags": _parse_json_list(proj.tags_json),
        "status": proj.status,
        "dataset_count": ds_count,
        "created_at": proj.created_at,
        "updated_at": proj.updated_at,
    }
    return ProjectSummary(**d)


def _to_read(proj: Project, db: Session) -> ProjectRead:
    summary = _to_summary(proj, db)
    note_count = db.query(func.count(ProjectNote.id)).filter(ProjectNote.project_id == proj.id).scalar() or 0
    return ProjectRead(**summary.model_dump(), note_count=note_count)


def _parse_json_list(val: str | None) -> list[str]:
    if not val:
        return []
    try:
        parsed = json.loads(val)
        return [str(x) for x in parsed] if isinstance(parsed, list) else []
    except Exception:
        return []


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[ProjectSummary])
def list_projects(db: Session = Depends(get_db)) -> list[ProjectSummary]:
    projects = db.query(Project).order_by(Project.updated_at.desc()).all()
    return [_to_summary(p, db) for p in projects]


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db)) -> ProjectRead:
    proj = Project(
        title=payload.title,
        description=payload.description,
        institution=payload.institution,
        lab=payload.lab,
        pi_name=payload.pi_name,
        collaborators_json=json.dumps(payload.collaborators),
        tags_json=json.dumps(payload.tags),
        status=payload.status,
    )
    db.add(proj)
    db.commit()
    db.refresh(proj)
    return _to_read(proj, db)


@router.get("/{project_id}", response_model=ProjectRead)
def get_project(project_id: int, db: Session = Depends(get_db)) -> ProjectRead:
    proj = _get_project_or_404(project_id, db)
    return _to_read(proj, db)


@router.patch("/{project_id}", response_model=ProjectRead)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db)) -> ProjectRead:
    proj = _get_project_or_404(project_id, db)
    if payload.title is not None:
        proj.title = payload.title
    if payload.description is not None:
        proj.description = payload.description
    if payload.institution is not None:
        proj.institution = payload.institution
    if payload.lab is not None:
        proj.lab = payload.lab
    if payload.pi_name is not None:
        proj.pi_name = payload.pi_name
    if payload.collaborators is not None:
        proj.collaborators_json = json.dumps(payload.collaborators)
    if payload.tags is not None:
        proj.tags_json = json.dumps(payload.tags)
    if payload.status is not None:
        proj.status = payload.status
    proj.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(proj)
    return _to_read(proj, db)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: int, db: Session = Depends(get_db)) -> None:
    proj = _get_project_or_404(project_id, db)
    # Unassign datasets (do not delete them)
    db.query(Dataset).filter(Dataset.project_id == project_id).update({"project_id": None})
    db.delete(proj)
    db.commit()


# ── Dataset assignment ────────────────────────────────────────────────────────

@router.get("/{project_id}/datasets")
def list_project_datasets(project_id: int, db: Session = Depends(get_db)) -> list[dict]:
    _get_project_or_404(project_id, db)
    datasets = db.query(Dataset).filter(Dataset.project_id == project_id).order_by(Dataset.created_at.desc()).all()
    return [
        {
            "id": d.id,
            "name": d.name,
            "path": d.path,
            "validation_status": d.validation_status,
            "created_at": d.created_at.isoformat(),
        }
        for d in datasets
    ]


@router.post("/{project_id}/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def assign_dataset(project_id: int, dataset_id: int, db: Session = Depends(get_db)) -> None:
    _get_project_or_404(project_id, db)
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dataset {dataset_id} not found")
    ds.project_id = project_id
    db.commit()


@router.delete("/{project_id}/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def unassign_dataset(project_id: int, dataset_id: int, db: Session = Depends(get_db)) -> None:
    _get_project_or_404(project_id, db)
    ds = db.get(Dataset, dataset_id)
    if ds is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Dataset {dataset_id} not found")
    if ds.project_id == project_id:
        ds.project_id = None
        db.commit()


# ── Notes ─────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/notes", response_model=list[ProjectNoteRead])
def list_notes(project_id: int, db: Session = Depends(get_db)) -> list[ProjectNoteRead]:
    _get_project_or_404(project_id, db)
    notes = (
        db.query(ProjectNote)
        .filter(ProjectNote.project_id == project_id)
        .order_by(ProjectNote.updated_at.desc())
        .all()
    )
    return [ProjectNoteRead.model_validate(n) for n in notes]


@router.post("/{project_id}/notes", response_model=ProjectNoteRead, status_code=status.HTTP_201_CREATED)
def create_note(project_id: int, payload: ProjectNoteCreate, db: Session = Depends(get_db)) -> ProjectNoteRead:
    _get_project_or_404(project_id, db)
    note = ProjectNote(
        project_id=project_id,
        title=payload.title,
        content_md=payload.content_md,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return ProjectNoteRead.model_validate(note)


@router.patch("/{project_id}/notes/{note_id}", response_model=ProjectNoteRead)
def update_note(project_id: int, note_id: int, payload: ProjectNoteUpdate, db: Session = Depends(get_db)) -> ProjectNoteRead:
    _get_project_or_404(project_id, db)
    note = db.query(ProjectNote).filter(ProjectNote.id == note_id, ProjectNote.project_id == project_id).first()
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Note {note_id} not found")
    if payload.title is not None:
        note.title = payload.title
    if payload.content_md is not None:
        note.content_md = payload.content_md
    note.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(note)
    return ProjectNoteRead.model_validate(note)


@router.delete("/{project_id}/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(project_id: int, note_id: int, db: Session = Depends(get_db)) -> None:
    _get_project_or_404(project_id, db)
    note = db.query(ProjectNote).filter(ProjectNote.id == note_id, ProjectNote.project_id == project_id).first()
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Note {note_id} not found")
    db.delete(note)
    db.commit()


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/stats", response_model=ProjectStats)
def get_project_stats(project_id: int, db: Session = Depends(get_db)) -> ProjectStats:
    _get_project_or_404(project_id, db)
    dataset_ids = _project_dataset_ids(project_id, db)

    ds_count = len(dataset_ids)
    run_count = 0
    success_run_count = 0
    report_count = 0
    pipeline_breakdown: dict[str, int] = {}
    storage_bytes = 0

    if dataset_ids:
        run_count = db.query(func.count(Run.id)).filter(Run.dataset_id.in_(dataset_ids)).scalar() or 0
        success_run_count = (
            db.query(func.count(Run.id))
            .filter(Run.dataset_id.in_(dataset_ids), Run.status == "success")
            .scalar() or 0
        )
        report_count = (
            db.query(func.count(Report.id))
            .filter(Report.dataset_id.in_(dataset_ids))
            .scalar() or 0
        )

        # Pipeline breakdown: join Run → Pipeline to get manifest id (stored as Pipeline.name)
        rows = (
            db.query(Pipeline.name, func.count(Run.id))
            .join(Run, Run.pipeline_id == Pipeline.id)
            .filter(Run.dataset_id.in_(dataset_ids))
            .group_by(Pipeline.name)
            .all()
        )
        pipeline_breakdown = {name: count for name, count in rows}

        # Estimate storage from output dirs
        for run in db.query(Run.output_dir).filter(Run.dataset_id.in_(dataset_ids)).all():
            if run.output_dir:
                try:
                    for root, _, files in os.walk(run.output_dir):
                        storage_bytes += sum(
                            os.path.getsize(os.path.join(root, f))
                            for f in files
                            if not os.path.islink(os.path.join(root, f))
                        )
                except OSError:
                    pass

    note_count = db.query(func.count(ProjectNote.id)).filter(ProjectNote.project_id == project_id).scalar() or 0

    return ProjectStats(
        dataset_count=ds_count,
        run_count=run_count,
        success_run_count=success_run_count,
        report_count=report_count,
        note_count=note_count,
        pipeline_breakdown=pipeline_breakdown,
        storage_bytes=storage_bytes,
    )


# ── Timeline ──────────────────────────────────────────────────────────────────

@router.get("/{project_id}/timeline", response_model=list[TimelineEvent])
def get_timeline(
    project_id: int,
    limit: int = Query(default=50, le=200),
    db: Session = Depends(get_db),
) -> list[TimelineEvent]:
    _get_project_or_404(project_id, db)
    dataset_ids = _project_dataset_ids(project_id, db)
    events: list[dict[str, Any]] = []

    # Datasets imported
    for ds in db.query(Dataset).filter(Dataset.project_id == project_id).all():
        events.append({
            "event_type": "dataset_imported",
            "label": f"Dataset imported: {ds.name or Path(ds.path).name}",
            "details": {"dataset_id": ds.id, "path": ds.path},
            "timestamp": ds.created_at.isoformat(),
        })

    if dataset_ids:
        # Runs
        for run in db.query(Run).filter(Run.dataset_id.in_(dataset_ids)).all():
            pipeline = db.get(Pipeline, run.pipeline_id)
            pipeline_name = pipeline.name if pipeline else "Unknown"
            ds = db.get(Dataset, run.dataset_id)
            ds_name = ds.name if ds else f"Dataset {run.dataset_id}"

            events.append({
                "event_type": "run_created",
                "label": f"Pipeline launched: {pipeline_name} on {ds_name}",
                "details": {"run_id": run.id, "pipeline": pipeline_name, "status": run.status},
                "timestamp": run.created_at.isoformat(),
            })
            if run.finished_at and run.status in ("success", "failed"):
                events.append({
                    "event_type": f"run_{run.status}",
                    "label": f"Pipeline {'completed' if run.status == 'success' else 'failed'}: {pipeline_name}",
                    "details": {"run_id": run.id, "pipeline": pipeline_name, "status": run.status},
                    "timestamp": run.finished_at.isoformat(),
                })

        # Reports
        for rep in db.query(Report).filter(Report.dataset_id.in_(dataset_ids)).all():
            ds = db.get(Dataset, rep.dataset_id)
            ds_name = ds.name if ds else f"Dataset {rep.dataset_id}"
            events.append({
                "event_type": "report_generated",
                "label": f"Study report generated for {ds_name}",
                "details": {"report_id": rep.id, "dataset_id": rep.dataset_id, "status": rep.status},
                "timestamp": rep.created_at.isoformat(),
            })

    # Notes
    for note in db.query(ProjectNote).filter(ProjectNote.project_id == project_id).all():
        events.append({
            "event_type": "note_created",
            "label": f"Note added: {note.title}",
            "details": {"note_id": note.id, "title": note.title},
            "timestamp": note.created_at.isoformat(),
        })

    events.sort(key=lambda e: e["timestamp"], reverse=True)
    return [TimelineEvent(**e) for e in events[:limit]]


# ── Publication status ────────────────────────────────────────────────────────

@router.get("/{project_id}/publication-status", response_model=PublicationStatus)
def get_publication_status(project_id: int, db: Session = Depends(get_db)) -> PublicationStatus:
    _get_project_or_404(project_id, db)
    dataset_ids = _project_dataset_ids(project_id, db)

    checklist: list[PublicationCheckItem] = []

    # Has datasets
    checklist.append(PublicationCheckItem(
        key="has_datasets",
        label="Datasets assigned to project",
        done=len(dataset_ids) > 0,
        detail=f"{len(dataset_ids)} dataset(s)" if dataset_ids else "Assign datasets to this project",
    ))

    validated_count = 0
    qc_count = 0
    preprocessing_count = 0
    analysis_count = 0
    report_count = 0
    note_count = 0

    ANALYSIS_PIPELINES = {
        "functional-connectivity", "seed-based-connectivity",
        "group-functional-connectivity", "connectome-graph-analysis",
        "statistical-map-explorer", "atlas-roi-extraction", "alff-falff",
    }
    PREPROCESSING_PIPELINES = {"fmriprep", "import-fmriprep-derivatives", "fastsurfer", "synthstrip", "brainchop"}

    if dataset_ids:
        validated_count = (
            db.query(func.count(Dataset.id))
            .filter(Dataset.project_id == project_id, Dataset.validation_status == "valid")
            .scalar() or 0
        )
        qc_count = (
            db.query(func.count(Run.id))
            .join(Pipeline, Run.pipeline_id == Pipeline.id)
            .filter(Run.dataset_id.in_(dataset_ids), Run.status == "success", Pipeline.name == "mriqc")
            .scalar() or 0
        )
        preprocessing_count = (
            db.query(func.count(Run.id))
            .join(Pipeline, Run.pipeline_id == Pipeline.id)
            .filter(
                Run.dataset_id.in_(dataset_ids),
                Run.status == "success",
                Pipeline.name.in_(PREPROCESSING_PIPELINES),
            )
            .scalar() or 0
        )
        analysis_count = (
            db.query(func.count(Run.id))
            .join(Pipeline, Run.pipeline_id == Pipeline.id)
            .filter(
                Run.dataset_id.in_(dataset_ids),
                Run.status == "success",
                Pipeline.name.in_(ANALYSIS_PIPELINES),
            )
            .scalar() or 0
        )
        report_count = (
            db.query(func.count(Report.id))
            .filter(Report.dataset_id.in_(dataset_ids), Report.status == "success")
            .scalar() or 0
        )

    note_count = (
        db.query(func.count(ProjectNote.id))
        .filter(ProjectNote.project_id == project_id)
        .scalar() or 0
    )

    checklist.append(PublicationCheckItem(
        key="bids_validated",
        label="BIDS dataset validated",
        done=validated_count > 0,
        detail=f"{validated_count} validated dataset(s)" if validated_count else "Run BIDS Validator",
    ))
    checklist.append(PublicationCheckItem(
        key="qc_complete",
        label="Image quality control (MRIQC)",
        done=qc_count > 0,
        detail=f"{qc_count} QC run(s)" if qc_count else "Run MRIQC on your dataset",
    ))
    checklist.append(PublicationCheckItem(
        key="preprocessing_done",
        label="Preprocessing pipeline completed",
        done=preprocessing_count > 0,
        detail=f"{preprocessing_count} preprocessing run(s)" if preprocessing_count else "Run fMRIPrep, FastSurfer, or SynthStrip",
    ))
    checklist.append(PublicationCheckItem(
        key="analysis_done",
        label="Analysis pipeline completed",
        done=analysis_count > 0,
        detail=f"{analysis_count} analysis run(s)" if analysis_count else "Run connectivity, graph analysis, or statistical map explorer",
    ))
    checklist.append(PublicationCheckItem(
        key="report_generated",
        label="Study report generated",
        done=report_count > 0,
        detail=f"{report_count} report(s)" if report_count else "Generate a study report from the dataset page",
    ))
    checklist.append(PublicationCheckItem(
        key="notes_added",
        label="Project notes documenting methods decisions",
        done=note_count > 0,
        detail=f"{note_count} note(s)" if note_count else "Add notes to document your methods decisions",
    ))
    checklist.append(PublicationCheckItem(
        key="manuscript_ready",
        label="Manuscript export generated",
        done=report_count > 0 and analysis_count > 0,
        detail="Use 'Export Manuscript' to generate a methods draft" if not (report_count > 0 and analysis_count > 0) else "Export available",
    ))

    done = sum(1 for c in checklist if c.done)
    pct = round(done / len(checklist) * 100) if checklist else 0

    return PublicationStatus(checklist=checklist, completion_pct=pct)


# ── Search ────────────────────────────────────────────────────────────────────

@router.get("/{project_id}/search")
def search_project(
    project_id: int,
    q: str = Query(default="", min_length=1),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _get_project_or_404(project_id, db)
    dataset_ids = _project_dataset_ids(project_id, db)
    term = f"%{q.lower()}%"

    results: dict[str, list[dict]] = {"datasets": [], "runs": [], "notes": [], "reports": []}

    # Datasets
    for ds in db.query(Dataset).filter(Dataset.project_id == project_id).all():
        if q.lower() in (ds.name or "").lower() or q.lower() in ds.path.lower():
            results["datasets"].append({"id": ds.id, "name": ds.name, "path": ds.path})

    if dataset_ids:
        # Runs (search pipeline name + params)
        for run in db.query(Run).filter(Run.dataset_id.in_(dataset_ids)).all():
            pipeline = db.get(Pipeline, run.pipeline_id)
            pipeline_name = pipeline.name if pipeline else ""
            params_text = (run.params_json or "").lower()
            if q.lower() in pipeline_name.lower() or q.lower() in params_text:
                results["runs"].append({
                    "id": run.id,
                    "pipeline": pipeline_name,
                    "status": run.status,
                    "created_at": run.created_at.isoformat(),
                    "dataset_id": run.dataset_id,
                })

        # Reports
        for rep in db.query(Report).filter(Report.dataset_id.in_(dataset_ids)).all():
            ds = db.get(Dataset, rep.dataset_id)
            ds_name = ds.name if ds else ""
            if q.lower() in ds_name.lower() or q.lower() in "report":
                results["reports"].append({
                    "id": rep.id,
                    "dataset_id": rep.dataset_id,
                    "dataset_name": ds_name,
                    "status": rep.status,
                    "created_at": rep.created_at.isoformat(),
                })

    # Notes
    for note in db.query(ProjectNote).filter(ProjectNote.project_id == project_id).all():
        if q.lower() in note.title.lower() or q.lower() in note.content_md.lower():
            results["notes"].append({
                "id": note.id,
                "title": note.title,
                "snippet": note.content_md[:200],
                "updated_at": note.updated_at.isoformat(),
            })

    total = sum(len(v) for v in results.values())
    return {"query": q, "total": total, "results": results}


# ── Manuscript export ─────────────────────────────────────────────────────────

@router.get("/{project_id}/manuscript")
def export_manuscript(project_id: int, db: Session = Depends(get_db)) -> dict[str, str]:
    proj = _get_project_or_404(project_id, db)
    dataset_ids = _project_dataset_ids(project_id, db)

    lines: list[str] = []
    now = datetime.now(UTC).strftime("%Y-%m-%d")

    lines += [
        f"# {proj.title}",
        "",
        f"*Generated by Neuravian · {now}*",
        "",
    ]

    if proj.institution or proj.lab or proj.pi_name:
        lines.append("## Affiliations")
        if proj.pi_name:
            lines.append(f"- Principal Investigator: {proj.pi_name}")
        if proj.lab:
            lines.append(f"- Laboratory: {proj.lab}")
        if proj.institution:
            lines.append(f"- Institution: {proj.institution}")
        collaborators = _parse_json_list(proj.collaborators_json)
        if collaborators:
            lines.append(f"- Collaborators: {', '.join(collaborators)}")
        lines.append("")

    if proj.description:
        lines += ["## Abstract", "", proj.description, ""]

    # Datasets section
    lines.append("## Data")
    lines.append("")
    if dataset_ids:
        datasets = db.query(Dataset).filter(Dataset.project_id == project_id).all()
        for ds in datasets:
            lines.append(f"### {ds.name or Path(ds.path).name}")
            lines.append(f"- Path: `{ds.path}`")
            lines.append(f"- Validation status: {ds.validation_status}")
            if ds.bids_version:
                lines.append(f"- BIDS version: {ds.bids_version}")
            if ds.indexed_metadata:
                try:
                    meta = json.loads(ds.indexed_metadata)
                    if meta.get("subjects"):
                        lines.append(f"- Subjects: {len(meta['subjects'])}")
                    if meta.get("sessions"):
                        lines.append(f"- Sessions: {len(meta['sessions'])}")
                    if meta.get("tasks"):
                        lines.append(f"- Tasks: {', '.join(meta['tasks'])}")
                except Exception:
                    pass
            lines.append("")
    else:
        lines.append("*No datasets assigned to this project.*")
        lines.append("")

    # Methods section — list all pipelines used
    lines.append("## Methods")
    lines.append("")
    if dataset_ids:
        runs = (
            db.query(Run)
            .filter(Run.dataset_id.in_(dataset_ids), Run.status == "success")
            .order_by(Run.finished_at)
            .all()
        )
        pipeline_runs: dict[str, list[Run]] = {}
        for run in runs:
            pipeline = db.get(Pipeline, run.pipeline_id)
            pname = pipeline.name if pipeline else "unknown"
            pipeline_runs.setdefault(pname, []).append(run)

        if pipeline_runs:
            for pname, pruns in pipeline_runs.items():
                run = pruns[-1]  # most recent successful run
                pipeline = db.get(Pipeline, run.pipeline_id)
                lines.append(f"### {pname}")
                lines.append(f"Version: {run.pipeline_version}")
                if run.params_json:
                    try:
                        params = json.loads(run.params_json)
                        param_lines = [f"  - {k}: {v}" for k, v in params.items() if not str(k).startswith("_")]
                        if param_lines:
                            lines.append("Parameters:")
                            lines.extend(param_lines)
                    except Exception:
                        pass
                lines.append("")
        else:
            lines.append("*No successful pipeline runs recorded.*")
            lines.append("")
    else:
        lines.append("*No datasets or runs recorded.*")
        lines.append("")

    # Notes section
    notes = db.query(ProjectNote).filter(ProjectNote.project_id == project_id).order_by(ProjectNote.created_at).all()
    if notes:
        lines.append("## Research Notes")
        lines.append("")
        for note in notes:
            lines.append(f"### {note.title}")
            lines.append(note.content_md)
            lines.append("")

    # References placeholder
    lines += [
        "## References",
        "",
        "*References are generated from the Neuravian Citation Studio. Open the Methods Studio for each dataset to export a formatted bibliography.*",
        "",
    ]

    manuscript = "\n".join(lines)
    return {"content": manuscript, "filename": f"{proj.title.replace(' ', '_')}_manuscript_{now}.md"}
