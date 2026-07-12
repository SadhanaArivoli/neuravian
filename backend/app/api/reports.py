"""Study Report Studio API.

POST /api/datasets/{dataset_id}/reports              — generate a new report
GET  /api/datasets/{dataset_id}/reports              — list reports for a dataset
GET  /api/datasets/{dataset_id}/reports/compare      — compare two ready reports (?a=X&b=Y)
GET  /api/datasets/{dataset_id}/reports/{id}         — get report metadata
DELETE /api/datasets/{dataset_id}/reports/{id}       — delete a failed report
POST /api/datasets/{dataset_id}/reports/{id}/retry   — retry a failed report
GET  /api/datasets/{dataset_id}/reports/{id}/download/{format}
     format: html | md | json | zip | pdf
GET  /api/datasets/{dataset_id}/reports/{id}/view    — serve HTML inline (for iframe)
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
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

PDF_TIMEOUT_MS = 60_000  # 60-second hard timeout for headless Chromium


def _reports_root() -> Path:
    p = Path(settings.data_dir) / "reports"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _report_dir(report_id: int) -> Path:
    d = _reports_root() / str(report_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── PDF generation ─────────────────────────────────────────────────────────────

def _generate_pdf(html_path: Path, pdf_path: Path) -> str | None:
    """Render HTML to PDF using headless Chromium via Playwright.

    Returns an error string if PDF generation is unavailable or fails,
    or None on success.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return "Playwright not installed; PDF export unavailable."

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--no-sandbox", "--disable-setuid-sandbox"],
            )
            page = browser.new_page()
            page.goto(f"file://{html_path.resolve()}", timeout=PDF_TIMEOUT_MS)
            # Wait for content to be fully rendered
            page.wait_for_load_state("networkidle", timeout=PDF_TIMEOUT_MS)
            page.pdf(
                path=str(pdf_path),
                format="A4",
                print_background=True,
                margin={"top": "20mm", "bottom": "20mm", "left": "15mm", "right": "15mm"},
            )
            browser.close()
        return None
    except Exception as exc:
        return f"PDF generation failed: {exc}"


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

            # PDF via headless Chromium (non-fatal — stored as None on failure)
            pdf_path = out_dir / "study_report.pdf"
            pdf_err = _generate_pdf(html_path, pdf_path)
            if pdf_err:
                log.warning("Report %d: %s", report_id, pdf_err)
                pdf_path = None  # type: ignore[assignment]

            zip_path = build_supplement_zip(data, out_dir)

            report.html_path = str(html_path)
            report.md_path = str(md_path)
            report.json_path = str(json_path)
            report.zip_path = str(zip_path)
            report.pdf_path = str(pdf_path) if pdf_path else None
            report.status = "ready"
            report.finished_at = datetime.now(UTC)
            db.commit()
            log.info("Report %d generated successfully (pdf=%s)", report_id, bool(pdf_path))

        except Exception as exc:
            log.exception("Report %d generation failed", report_id)
            report.status = "failed"
            report.error_message = str(exc)
            report.finished_at = datetime.now(UTC)
            db.commit()


# ── Comparison logic ──────────────────────────────────────────────────────────

def _compare_reports(a: Report, b: Report) -> dict:
    """Diff two ready reports using their JSON data as source of truth."""

    def _load(r: Report) -> dict:
        if not r.json_path or not Path(r.json_path).exists():
            raise HTTPException(status_code=409, detail=f"Report {r.id} JSON not found on disk")
        return json.loads(Path(r.json_path).read_text(encoding="utf-8"))

    da = _load(a)
    db_ = _load(b)

    def _run_ids(d: dict) -> set[int]:
        return {r["run_id"] for r in d.get("runs", [])}

    def _by_pipeline(d: dict) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for r in d.get("runs", []):
            pid = r.get("pipeline_id", "")
            if pid not in result:
                result[pid] = r
        return result

    ids_a = _run_ids(da)
    ids_b = _run_ids(db_)
    added_run_ids = sorted(ids_b - ids_a)
    removed_run_ids = sorted(ids_a - ids_b)

    pipes_a = _by_pipeline(da)
    pipes_b = _by_pipeline(db_)
    all_pipes = sorted(set(pipes_a) | set(pipes_b))

    pipeline_diffs = []
    for pid in all_pipes:
        if pid in pipes_a and pid not in pipes_b:
            pipeline_diffs.append({"pipeline": pid, "change": "removed"})
        elif pid not in pipes_a and pid in pipes_b:
            pipeline_diffs.append({"pipeline": pid, "change": "added"})
        else:
            ra, rb = pipes_a[pid], pipes_b[pid]
            changes: dict[str, dict] = {}
            if ra.get("pipeline_version") != rb.get("pipeline_version"):
                changes["version"] = {"a": ra.get("pipeline_version"), "b": rb.get("pipeline_version")}
            if ra.get("artifact_count") != rb.get("artifact_count"):
                changes["artifact_count"] = {"a": ra.get("artifact_count"), "b": rb.get("artifact_count")}
            params_a = ra.get("params", {})
            params_b = rb.get("params", {})
            all_keys = sorted(set(params_a) | set(params_b))
            param_diffs = {}
            for k in all_keys:
                if params_a.get(k) != params_b.get(k):
                    param_diffs[k] = {"a": params_a.get(k), "b": params_b.get(k)}
            if param_diffs:
                changes["params"] = param_diffs
            if changes:
                pipeline_diffs.append({"pipeline": pid, "change": "modified", "details": changes})

    warnings_a = set(da.get("warnings", []))
    warnings_b = set(db_.get("warnings", []))

    art_a = len(da.get("artifacts", []))
    art_b = len(db_.get("artifacts", []))

    return {
        "report_a": {"id": a.id, "created_at": a.created_at.isoformat() if a.created_at else None, "total_runs": da.get("total_runs"), "success_runs": da.get("success_runs")},
        "report_b": {"id": b.id, "created_at": b.created_at.isoformat() if b.created_at else None, "total_runs": db_.get("total_runs"), "success_runs": db_.get("success_runs")},
        "runs": {"added": added_run_ids, "removed": removed_run_ids},
        "pipelines": pipeline_diffs,
        "warnings": {
            "added": sorted(warnings_b - warnings_a),
            "removed": sorted(warnings_a - warnings_b),
        },
        "artifacts": {
            "a": art_a,
            "b": art_b,
            "delta": art_b - art_a,
        },
    }


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

    t = threading.Thread(target=_generate_report, args=(report.id, dataset_id), daemon=True)
    t.start()

    return {
        "report_id": report.id,
        "dataset_id": dataset_id,
        "status": "generating",
        "created_at": report.created_at.isoformat(),
    }


@router.get("/datasets/{dataset_id}/reports/compare")
def compare_reports(
    dataset_id: int,
    a: int = Query(..., description="First report ID (older)"),
    b: int = Query(..., description="Second report ID (newer)"),
    db: Session = Depends(get_db),
) -> dict:
    """Structured diff between two ready reports from the same dataset."""
    dataset = db.get(Dataset, dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    ra = db.get(Report, a)
    rb = db.get(Report, b)
    for r, rid in ((ra, a), (rb, b)):
        if r is None or r.dataset_id != dataset_id:
            raise HTTPException(status_code=404, detail=f"Report {rid} not found for this dataset")
        if r.status != "ready":
            raise HTTPException(status_code=409, detail=f"Report {rid} is not ready (status: {r.status})")

    if a == b:
        raise HTTPException(status_code=400, detail="Cannot compare a report with itself")

    return _compare_reports(ra, rb)  # type: ignore[arg-type]


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


@router.delete("/datasets/{dataset_id}/reports/{report_id}", status_code=204)
def delete_report(dataset_id: int, report_id: int, db: Session = Depends(get_db)) -> None:
    """Delete a failed report and remove its files. Only failed reports may be deleted."""
    report = db.get(Report, report_id)
    if report is None or report.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    if report.status not in ("failed", "generating"):
        raise HTTPException(status_code=409, detail=f"Only failed or stuck reports can be deleted (status: {report.status})")

    # Remove files if they exist
    out_dir = _reports_root() / str(report_id)
    if out_dir.exists():
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)

    db.delete(report)
    db.commit()


@router.post("/datasets/{dataset_id}/reports/{report_id}/retry", status_code=202)
def retry_report(
    dataset_id: int,
    report_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict:
    """Retry a failed report. Resets status and re-runs generation."""
    report = db.get(Report, report_id)
    if report is None or report.dataset_id != dataset_id:
        raise HTTPException(status_code=404, detail=f"Report {report_id} not found")
    if report.status != "failed":
        raise HTTPException(status_code=409, detail=f"Only failed reports can be retried (status: {report.status})")

    report.status = "generating"
    report.error_message = None
    report.html_path = None
    report.md_path = None
    report.json_path = None
    report.zip_path = None
    report.pdf_path = None
    report.finished_at = None
    db.commit()

    t = threading.Thread(target=_generate_report, args=(report.id, dataset_id), daemon=True)
    t.start()

    return {
        "report_id": report.id,
        "dataset_id": dataset_id,
        "status": "generating",
    }


@router.get("/datasets/{dataset_id}/reports/{report_id}/download/{fmt}")
def download_report(
    dataset_id: int, report_id: int, fmt: str, db: Session = Depends(get_db)
):
    """Download a report in the requested format: html | md | json | zip | pdf."""
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
        "pdf":  (report.pdf_path,  "application/pdf", "study_report.pdf"),
    }
    if fmt not in path_map:
        raise HTTPException(status_code=400, detail=f"Unknown format '{fmt}'. Use: html, md, json, zip, pdf")

    file_path, media_type, filename = path_map[fmt]
    if not file_path:
        raise HTTPException(status_code=404, detail=f"{fmt} file not available (PDF may have failed to generate)")
    if not Path(file_path).exists():
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
        "pdf_path": r.pdf_path,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
    }
