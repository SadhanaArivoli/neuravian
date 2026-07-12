"""Study Report Studio API.

POST /api/datasets/{dataset_id}/reports          — generate a new report
GET  /api/datasets/{dataset_id}/reports          — list reports for a dataset
GET  /api/datasets/{dataset_id}/reports/{id}     — get report metadata
GET  /api/datasets/{dataset_id}/reports/{id}/download/{format}
     format: html | md | json | zip
"""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models.dataset import Dataset
from app.models.report import Report
from app.services.report_engine import (
    build_supplement_zip,
    collect_report_data,
    render_html,
    render_json,
    render_markdown,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["reports"])

# Derive report storage root from DATA_ROOT setting (same convention as runs)
def _reports_root() -> Path:
    p = Path(settings.data_dir) / "reports"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _report_dir(report_id: int) -> Path:
    d = _reports_root() / str(report_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── Background generation ─────────────────────────────────────────────────────

def _generate_report(report_id: int, dataset_id: int) -> None:
    """Runs in a background thread: generate all report files and update DB."""
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        report = db.get(Report, report_id)
        if report is None:
            log.error("Report %d not found in DB", report_id)
            return
        try:
            data = collect_report_data(dataset_id=dataset_id, report_id=report_id, db=db)
            out_dir = _report_dir(report_id)

            html_content = render_html(data)
            md_content = render_markdown(data)
            json_content = render_json(data)

            html_path = out_dir / "study_report.html"
            md_path = out_dir / "study_report.md"
            json_path = out_dir / "study_report.json"

            html_path.write_text(html_content, encoding="utf-8")
            md_path.write_text(md_content, encoding="utf-8")
            json_path.write_text(json_content, encoding="utf-8")

            zip_path = build_supplement_zip(data, out_dir)

            report.html_path = str(html_path)
            report.md_path = str(md_path)
            report.json_path = str(json_path)
            report.zip_path = str(zip_path)
            report.status = "ready"
            report.finished_at = datetime.now(UTC)
            db.commit()
            log.info("Report %d generated successfully", report_id)

        except Exception as exc:
            log.exception("Report %d generation failed", report_id)
            report.status = "failed"
            report.error_message = str(exc)
            report.finished_at = datetime.now(UTC)
            db.commit()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/datasets/{dataset_id}/reports", status_code=202)
def generate_report(
    dataset_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict:
    """Start report generation. Returns immediately with report_id."""
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    report = Report(dataset_id=dataset_id, status="generating")
    db.add(report)
    db.commit()
    db.refresh(report)

    # Spawn in a background thread (not asyncio, avoids SQLAlchemy session issues)
    t = threading.Thread(target=_generate_report, args=(report.id, dataset_id), daemon=True)
    t.start()

    return {
        "report_id": report.id,
        "dataset_id": dataset_id,
        "status": "generating",
        "created_at": report.created_at.isoformat(),
    }


@router.get("/datasets/{dataset_id}/reports")
def list_reports(dataset_id: int, db: Session = Depends(get_db)) -> list[dict]:
    """List all reports for a dataset, newest first."""
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    reports = (
        db.query(Report)
        .filter(Report.dataset_id == dataset_id)
        .order_by(Report.created_at.desc())
        .all()
    )
    return [_report_dict(r) for r in reports]


@router.get("/datasets/{dataset_id}/reports/{report_id}")
def get_report(dataset_id: int, report_id: int, db: Session = Depends(get_db)) -> dict:
    """Get report metadata and status."""
    report = db.get(Report, report_id)
    if report is None or report.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    return _report_dict(report)


@router.get("/datasets/{dataset_id}/reports/{report_id}/download/{fmt}")
def download_report(
    dataset_id: int, report_id: int, fmt: str, db: Session = Depends(get_db)
):
    """Download a report in the requested format: html | md | json | zip."""
    report = db.get(Report, report_id)
    if report is None or report.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    if report.status != "ready":
        raise HTTPException(status_code=409, detail=f"Report is not ready (status: {report.status})")

    path_map = {
        "html": (report.html_path, "text/html", "study_report.html"),
        "md":   (report.md_path,   "text/markdown", "study_report.md"),
        "json": (report.json_path, "application/json", "study_report.json"),
        "zip":  (report.zip_path,  "application/zip", "supplementary_materials.zip"),
    }
    if fmt not in path_map:
        raise HTTPException(status_code=400, detail=f"Unknown format '{fmt}'. Use: html, md, json, zip")

    file_path, media_type, filename = path_map[fmt]
    if not file_path or not Path(file_path).exists():
        raise HTTPException(status_code=404, detail=f"{fmt} file not found on disk")

    return FileResponse(
        path=file_path,
        media_type=media_type,
        filename=filename,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/datasets/{dataset_id}/reports/{report_id}/view", response_class=HTMLResponse)
def view_report_html(
    dataset_id: int, report_id: int, db: Session = Depends(get_db)
) -> HTMLResponse:
    """Serve the HTML report inline (for embedding in an iframe)."""
    report = db.get(Report, report_id)
    if report is None or report.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    if report.status != "ready":
        raise HTTPException(status_code=409, detail=f"Report not ready (status: {report.status})")
    if not report.html_path or not Path(report.html_path).exists():
        raise HTTPException(status_code=404, detail="HTML file not found on disk")

    content = Path(report.html_path).read_text(encoding="utf-8")
    return HTMLResponse(content=content)


def _report_dict(r: Report) -> dict:
    return {
        "id": r.id,
        "dataset_id": r.dataset_id,
        "status": r.status,
        "error_message": r.error_message,
        "html_path": r.html_path,
        "md_path": r.md_path,
        "json_path": r.json_path,
        "zip_path": r.zip_path,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }
