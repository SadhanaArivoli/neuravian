"""Regression tests for Study Report Studio.

Tests cover:
- Report data collection (all fields populated)
- HTML rendering (key sections present)
- Markdown rendering (structure and content)
- JSON rendering (schema)
- Supplement ZIP (expected files)
- Citation registry (APA/BibTeX/Vancouver)
- Methods prose (template expansion)
- Software table (deduplication)
- Conditional sections (empty dataset, no runs, failed-only runs)
- API endpoints (generate, list, get, download)
- Report comparison eligibility (different timestamps)
"""

from __future__ import annotations

import json
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# ── Import the engine under test ──────────────────────────────────────────────

from app.services.report_engine import (
    ArtifactSummary,
    CitationEntry,
    FigureEmbed,
    ReportData,
    RunSummary,
    _build_citations,
    _build_methods_sections,
    _build_software_table,
    _format_apa,
    _format_bibtex,
    _format_vancouver,
    build_supplement_zip,
    render_html,
    render_json,
    render_markdown,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

def _make_run(
    run_id: int = 1,
    pipeline_id: str = "mriqc",
    display_name: str = "MRIQC",
    version: str = "24.0.2",
    status: str = "success",
    execution_type: str = "docker",
    container_image: str | None = "nipreps/mriqc:24.0.2",
    runtime_seconds: int | None = 54,
    params: dict[str, Any] | None = None,
    artifact_count: int = 3,
) -> RunSummary:
    return RunSummary(
        run_id=run_id,
        pipeline_id=pipeline_id,
        pipeline_display_name=display_name,
        pipeline_version=version,
        status=status,
        execution_type=execution_type,
        container_image=container_image,
        started_at="2026-07-12T00:00:00",
        finished_at="2026-07-12T00:00:54",
        runtime_seconds=runtime_seconds,
        params=params or {"participant_label": "sub-01"},
        artifact_count=artifact_count,
        output_dir="/data/derivatives/mriqc/1",
    )


def _make_report_data(
    runs: list[RunSummary] | None = None,
    artifacts: list[ArtifactSummary] | None = None,
    warnings: list[str] | None = None,
) -> ReportData:
    _runs = runs if runs is not None else [_make_run()]
    cits = _build_citations({r.pipeline_id for r in _runs})
    methods = _build_methods_sections(_runs, {})
    sw = _build_software_table(_runs)
    return ReportData(
        report_id=1,
        dataset_id=1,
        generated_at="2026-07-12T02:00:00+00:00",
        neuroforge_version="0.1.0",
        git_commit="abc1234",
        dataset_name="test-bids",
        dataset_path="/data/test-bids",
        dataset_bids_version="1.9.0",
        dataset_validation_status="valid",
        dataset_imported_at="2026-06-30T00:00:00",
        dataset_subjects=["sub-01", "sub-02"],
        dataset_sessions=[],
        dataset_modalities=["anat"],
        dataset_file_count=10,
        runs=_runs,
        total_runs=len(_runs),
        success_runs=sum(1 for r in _runs if r.status == "success"),
        failed_runs=sum(1 for r in _runs if r.status == "failed"),
        cancelled_runs=0,
        artifacts=artifacts or [],
        alff_falff_sections=[],
        figures=[],
        methods_sections=methods,
        software_table=sw,
        citations=cits,
        warnings=warnings or [],
    )


# ── Citation registry tests ───────────────────────────────────────────────────

class TestCitationRegistry:
    def test_alff_falff_citations_present(self):
        assert {c.key for c in _build_citations({"alff-falff"})} == {"alff", "falff"}
    def test_mriqc_citation_present(self):
        cits = _build_citations({"mriqc"})
        keys = {c.key for c in cits}
        assert "mriqc" in keys

    def test_unknown_pipeline_no_citation(self):
        cits = _build_citations({"unknown-pipeline-xyz"})
        assert cits == []

    def test_no_duplicate_citations(self):
        # nilearn covers multiple pipelines — should appear only once
        cits = _build_citations({"functional-connectivity", "seed-based-connectivity"})
        keys = [c.key for c in cits]
        assert len(keys) == len(set(keys))

    def test_apa_format_contains_doi(self):
        cit = _format_apa({"authors": "A B", "year": 2020, "title": "T", "journal": "J",
                           "doi": "10.1234/test"})
        assert "10.1234/test" in cit
        assert "(2020)" in cit

    def test_bibtex_format_has_author_field(self):
        bibtex = _format_bibtex({"key": "mriqc", "tool": "MRIQC",
                                  "authors": "A B", "year": 2020, "title": "T",
                                  "journal": "J", "doi": "10.x/y"})
        assert "author" in bibtex
        assert "@article" in bibtex

    def test_vancouver_format(self):
        result = _format_vancouver({"authors": "Smith J", "year": 2020, "title": "T",
                                     "journal": "J", "doi": "10.x", "volume": "5",
                                     "pages": "123"})
        assert "Smith J" in result
        assert "2020" in result
        assert "10.x" in result

    def test_rrid_included_in_citation_entry(self):
        cits = _build_citations({"mriqc"})
        mriqc_cit = next(c for c in cits if c.key == "mriqc")
        assert mriqc_cit.rrid == "SCR_022942"

    def test_fmriprep_citation_present_for_import(self):
        # import-fmriprep-derivatives should trigger fmriprep citation
        cits = _build_citations({"import-fmriprep-derivatives"})
        assert any(c.key == "fmriprep" for c in cits)

    def test_all_citations_have_doi(self):
        cits = _build_citations({"mriqc", "fmriprep", "brainchop", "bids-validator",
                                  "dcm2niix", "functional-connectivity", "fastsurfer"})
        for c in cits:
            assert c.doi, f"Citation {c.key} missing DOI"


# ── Methods prose tests ───────────────────────────────────────────────────────

class TestMethodsProse:
    def test_alff_methods_are_non_inferential(self):
        sections = _build_methods_sections([_make_run(pipeline_id="alff-falff", display_name="ALFF / fALFF")], {})
        assert "No inferential statistics" in sections[0]["text"]
    def test_mriqc_methods_contains_version(self):
        runs = [_make_run(pipeline_id="mriqc", version="24.0.2")]
        sections = _build_methods_sections(runs, {})
        assert any("24.0.2" in s["text"] for s in sections)

    def test_unknown_pipeline_no_methods(self):
        runs = [_make_run(pipeline_id="unknown-xyz")]
        sections = _build_methods_sections(runs, {})
        assert sections == []

    def test_no_duplicate_methods_for_same_pipeline(self):
        runs = [_make_run(pipeline_id="mriqc"), _make_run(run_id=2, pipeline_id="mriqc")]
        sections = _build_methods_sections(runs, {})
        pipeline_ids = [s["pipeline_id"] for s in sections]
        assert pipeline_ids.count("mriqc") == 1

    def test_multiple_pipelines_produce_multiple_sections(self):
        runs = [
            _make_run(pipeline_id="mriqc"),
            _make_run(run_id=2, pipeline_id="fmriprep", display_name="fMRIPrep"),
        ]
        sections = _build_methods_sections(runs, {})
        assert len(sections) == 2

    def test_functional_connectivity_methods_text(self):
        runs = [_make_run(pipeline_id="functional-connectivity",
                          display_name="Functional Connectivity")]
        sections = _build_methods_sections(runs, {})
        assert sections
        assert "Pearson" in sections[0]["text"] or "connectivity" in sections[0]["text"].lower()


# ── Software table tests ──────────────────────────────────────────────────────

class TestSoftwareTable:
    def test_deduplication_by_pipeline_id(self):
        runs = [_make_run(), _make_run(run_id=2)]  # both mriqc
        table = _build_software_table(runs)
        assert len(table) == 1

    def test_multiple_pipelines_in_table(self):
        runs = [
            _make_run(pipeline_id="mriqc"),
            _make_run(run_id=2, pipeline_id="fmriprep", display_name="fMRIPrep"),
        ]
        table = _build_software_table(runs)
        assert len(table) == 2

    def test_table_contains_version(self):
        runs = [_make_run(version="24.0.2")]
        table = _build_software_table(runs)
        assert table[0]["version"] == "24.0.2"

    def test_native_execution_recorded(self):
        runs = [_make_run(execution_type="native", container_image=None)]
        table = _build_software_table(runs)
        assert table[0]["execution"] == "native"
        assert table[0]["image"] == "—"


# ── HTML renderer tests ───────────────────────────────────────────────────────

class TestHtmlRenderer:
    def test_alff_section_consistent_across_exports(self, tmp_path: Path):
        data = _make_report_data(runs=[_make_run(pipeline_id="alff-falff", display_name="ALFF / fALFF")])
        data.alff_falff_sections = [{"run_id":58,"frequency_band":[0.01,0.08],"tr":1.0,"nyquist_frequency":0.5,"confound_strategy":"motion6","normalization":"none","runtime_seconds":1.2,"mask_voxel_count":42,"alff_statistics":{"mean":1.1},"falff_statistics":{"mean":0.2},"warnings":[]}]
        html = render_html(data); md = render_markdown(data); payload = json.loads(render_json(data))
        assert "0.01–0.08 Hz" in html and "0.01–0.08 Hz" in md
        assert payload["alff_falff_sections"][0]["confound_strategy"] == "motion6"
        for name, content in [("study_report.html",html),("study_report.md",md),("study_report.json",render_json(data))]: (tmp_path/name).write_text(content)
        archive = build_supplement_zip(data,tmp_path)
        with zipfile.ZipFile(archive) as zf:
            assert {"study_report.html","study_report.md","study_report.json"}.issubset(zf.namelist())

    def test_html_contains_dataset_name(self):
        data = _make_report_data()
        html = render_html(data)
        assert "test-bids" in html

    def test_html_contains_bids_version(self):
        html = render_html(_make_report_data())
        assert "1.9.0" in html

    def test_html_contains_run_count(self):
        html = render_html(_make_report_data())
        assert "1 run" in html.lower() or ">1<" in html  # 1 run from our fixture

    def test_html_contains_methods_section(self):
        html = render_html(_make_report_data())
        assert "Methods" in html

    def test_html_contains_citations(self):
        html = render_html(_make_report_data())
        assert "References" in html
        assert "doi.org" in html

    def test_html_contains_cover_metadata(self):
        html = render_html(_make_report_data())
        assert "NeuroForge Study Report" in html
        assert "abc1234" in html  # git commit

    def test_html_contains_reproducibility_checklist(self):
        html = render_html(_make_report_data())
        assert "Reproducibility" in html

    def test_html_contains_print_css(self):
        html = render_html(_make_report_data())
        assert "@media print" in html

    def test_html_contains_warning_when_failed_runs(self):
        runs = [_make_run(status="failed", artifact_count=0)]
        data = _make_report_data(runs=runs, warnings=["1 run(s) failed."])
        html = render_html(data)
        assert "failed" in html.lower()
        assert "⚠️" in html

    def test_html_no_figures_message_when_empty(self):
        data = _make_report_data()
        html = render_html(data)
        # No figures in fixture — should show empty message
        assert "No figures" in html

    def test_html_contains_figure_when_present(self):
        data = _make_report_data()
        data.figures = [FigureEmbed(
            caption="Test figure",
            alt="test",
            data_uri="data:image/png;base64,abc123",
            source_run_id=1,
            pipeline_id="mriqc",
        )]
        html = render_html(data)
        assert "data:image/png;base64,abc123" in html
        assert "Test figure" in html

    def test_html_is_valid_doctype(self):
        html = render_html(_make_report_data())
        assert html.strip().startswith("<!DOCTYPE html>")


# ── Markdown renderer tests ───────────────────────────────────────────────────

class TestMarkdownRenderer:
    def test_md_starts_with_heading(self):
        md = render_markdown(_make_report_data())
        assert md.startswith("# Study Report:")

    def test_md_contains_dataset_name(self):
        md = render_markdown(_make_report_data())
        assert "test-bids" in md

    def test_md_contains_pipeline_table(self):
        md = render_markdown(_make_report_data())
        assert "| Pipeline |" in md
        assert "MRIQC" in md

    def test_md_contains_methods_section(self):
        md = render_markdown(_make_report_data())
        assert "## Methods" in md

    def test_md_contains_references(self):
        md = render_markdown(_make_report_data())
        assert "## References" in md
        assert "doi" in md.lower()

    def test_md_contains_reproducibility_footer(self):
        md = render_markdown(_make_report_data())
        assert "NeuroForge" in md
        assert "abc1234" in md  # git commit

    def test_md_no_warnings_when_clean(self):
        data = _make_report_data(warnings=[])
        md = render_markdown(data)
        assert "## Warnings" not in md

    def test_md_contains_warning_text(self):
        data = _make_report_data(warnings=["Test warning message"])
        md = render_markdown(data)
        assert "Test warning message" in md


# ── JSON renderer tests ───────────────────────────────────────────────────────

class TestJsonRenderer:
    def test_json_is_valid(self):
        data = _make_report_data()
        result = json.loads(render_json(data))
        assert isinstance(result, dict)

    def test_json_has_required_keys(self):
        result = json.loads(render_json(_make_report_data()))
        for key in ["report_id", "dataset_id", "generated_at", "neuroforge_version",
                     "runs", "artifacts", "citations", "methods_sections", "warnings"]:
            assert key in result, f"Missing key: {key}"

    def test_json_figures_stripped(self):
        data = _make_report_data()
        data.figures = [FigureEmbed("cap", "alt", "data:image/png;base64," + "A" * 1000, 1, "mriqc")]
        result = json.loads(render_json(data))
        for fig in result["figures"]:
            assert fig["data_uri"] == "[embedded in HTML]"

    def test_json_run_count_matches(self):
        result = json.loads(render_json(_make_report_data()))
        assert result["total_runs"] == 1

    def test_json_citations_have_apa(self):
        result = json.loads(render_json(_make_report_data()))
        for cit in result["citations"]:
            assert "apa" in cit
            assert len(cit["apa"]) > 10


# ── Supplement ZIP tests ──────────────────────────────────────────────────────

class TestSupplementZip:
    def test_zip_contains_expected_files(self, tmp_path: Path):
        data = _make_report_data()
        # Write report files first (as the generate flow does)
        (tmp_path / "study_report.html").write_text(render_html(data))
        (tmp_path / "study_report.md").write_text(render_markdown(data))
        (tmp_path / "study_report.json").write_text(render_json(data))

        zip_path = build_supplement_zip(data, tmp_path)
        assert zip_path.exists()

        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()

        assert "study_report.html" in names
        assert "study_report.md" in names
        assert "study_report.json" in names
        assert "pipeline_parameters.tsv" in names
        assert "references.bib" in names
        assert "provenance.json" in names

    def test_zip_provenance_is_valid_json(self, tmp_path: Path):
        data = _make_report_data()
        (tmp_path / "study_report.html").write_text("<html/>")
        (tmp_path / "study_report.md").write_text("# md")
        (tmp_path / "study_report.json").write_text("{}")
        zip_path = build_supplement_zip(data, tmp_path)
        with zipfile.ZipFile(zip_path) as zf:
            prov = json.loads(zf.read("provenance.json"))
        assert prov["schema"] == "neuroforge-provenance-v1"
        assert prov["report_id"] == 1
        assert isinstance(prov["runs"], list)

    def test_zip_bibtex_contains_entry(self, tmp_path: Path):
        data = _make_report_data()
        (tmp_path / "study_report.html").write_text("<html/>")
        (tmp_path / "study_report.md").write_text("# md")
        (tmp_path / "study_report.json").write_text("{}")
        zip_path = build_supplement_zip(data, tmp_path)
        with zipfile.ZipFile(zip_path) as zf:
            bibtex = zf.read("references.bib").decode()
        assert "@article" in bibtex or "@software" in bibtex

    def test_zip_parameters_tsv_has_header(self, tmp_path: Path):
        data = _make_report_data()
        (tmp_path / "study_report.html").write_text("<html/>")
        (tmp_path / "study_report.md").write_text("# md")
        (tmp_path / "study_report.json").write_text("{}")
        zip_path = build_supplement_zip(data, tmp_path)
        with zipfile.ZipFile(zip_path) as zf:
            tsv = zf.read("pipeline_parameters.tsv").decode()
        header = tsv.split("\n")[0]
        assert "run_id" in header
        assert "pipeline" in header
        assert "status" in header


# ── Conditional sections ──────────────────────────────────────────────────────

class TestConditionalSections:
    def test_empty_runs_no_pipeline_table(self):
        data = _make_report_data(runs=[])
        html = render_html(data)
        assert "No runs recorded" in html

    def test_no_runs_no_citations(self):
        data = _make_report_data(runs=[])
        assert data.citations == []

    def test_no_runs_no_methods(self):
        data = _make_report_data(runs=[])
        assert data.methods_sections == []

    def test_failed_run_excluded_from_success_count(self):
        runs = [_make_run(status="failed", artifact_count=0)]
        data = _make_report_data(runs=runs)
        assert data.success_runs == 0
        assert data.failed_runs == 1

    def test_validation_warning_when_invalid(self):
        data = _make_report_data()
        data.dataset_validation_status = "invalid"
        data.warnings = ["BIDS validation reported errors."]
        html = render_html(data)
        assert "BIDS validation" in html

    def test_no_figures_section_shows_empty_message(self):
        data = _make_report_data()
        data.figures = []
        html = render_html(data)
        assert "No figures produced" in html

    def test_no_artifacts_shows_empty_message(self):
        data = _make_report_data()
        data.artifacts = []
        html = render_html(data)
        assert "No resolved artifacts" in html



# ── Module-level imports for new tests ────────────────────────────────────────

from app.api.reports import _compare_reports, _generate_pdf, PDF_TIMEOUT_MS  # noqa: E402


# ── PDF generation ─────────────────────────────────────────────────────────────

class TestPdfGeneration:
    def test_generate_pdf_with_playwright_produces_valid_file(self, tmp_path):
        """End-to-end: playwright renders a minimal HTML to a valid PDF."""
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            pytest.skip("playwright not installed")

        html_file = tmp_path / "test.html"
        html_file.write_text(
            "<html><body><h1>NeuroForge Test</h1><p>PDF test.</p></body></html>"
        )
        pdf_file = tmp_path / "out.pdf"
        err = _generate_pdf(html_file, pdf_file)
        assert err is None, f"PDF generation failed: {err}"
        assert pdf_file.exists()
        assert pdf_file.stat().st_size > 1000
        assert pdf_file.read_bytes()[:4] == b"%PDF"

    def test_pdf_timeout_constant_is_sane(self):
        assert PDF_TIMEOUT_MS >= 10_000

    def test_generate_pdf_with_full_report_html(self, tmp_path):
        """PDF generation works on a full-size report HTML."""
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            pytest.skip("playwright not installed")

        data = _make_report_data()
        html_content = render_html(data)
        html_file = tmp_path / "report.html"
        html_file.write_text(html_content, encoding="utf-8")
        pdf_file = tmp_path / "report.pdf"
        err = _generate_pdf(html_file, pdf_file)
        assert err is None, f"Full-report PDF failed: {err}"
        assert pdf_file.stat().st_size > 10_000  # real reports are large
        assert pdf_file.read_bytes()[:4] == b"%PDF"


# ── Report comparison (unit tests — no app import) ───────────────────────────

class TestReportComparison:
    def _mock_report(self, rid, json_path):
        r = MagicMock()
        r.id = rid
        r.json_path = str(json_path)
        r.created_at = datetime(2026, 7, 12, tzinfo=UTC)
        return r

    def _write(self, path, runs, artifacts=None, warnings=None):
        path.write_text(json.dumps({
            "total_runs": len(runs),
            "success_runs": sum(1 for r in runs if r.get("status") == "success"),
            "runs": runs,
            "artifacts": artifacts or [],
            "warnings": warnings or [],
        }), encoding="utf-8")

    def test_identical_reports_no_diffs(self, tmp_path):
        run = {"run_id": 1, "pipeline_id": "mriqc", "pipeline_version": "24.0.2",
               "status": "success", "artifact_count": 3, "params": {}}
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [run])
        self._write(pb, [run])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert result["runs"]["added"] == []
        assert result["runs"]["removed"] == []
        assert result["pipelines"] == []
        assert result["warnings"]["added"] == []
        assert result["artifacts"]["delta"] == 0

    def test_added_run_detected(self, tmp_path):
        run_a = {"run_id": 1, "pipeline_id": "mriqc", "pipeline_version": "24.0.2",
                 "status": "success", "artifact_count": 3, "params": {}}
        run_b = {"run_id": 2, "pipeline_id": "fmriprep", "pipeline_version": "23.2.0",
                 "status": "success", "artifact_count": 5, "params": {}}
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [run_a])
        self._write(pb, [run_a, run_b])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert 2 in result["runs"]["added"]
        assert result["runs"]["removed"] == []

    def test_removed_run_detected(self, tmp_path):
        run = {"run_id": 1, "pipeline_id": "mriqc", "pipeline_version": "24.0.2",
               "status": "success", "artifact_count": 3, "params": {}}
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [run])
        self._write(pb, [])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert 1 in result["runs"]["removed"]
        assert result["runs"]["added"] == []

    def test_version_change_detected(self, tmp_path):
        run_a = {"run_id": 1, "pipeline_id": "mriqc", "pipeline_version": "24.0.1",
                 "status": "success", "artifact_count": 3, "params": {}}
        run_b = {**run_a, "pipeline_version": "24.0.2"}
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [run_a])
        self._write(pb, [run_b])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        modified = [p for p in result["pipelines"] if p["change"] == "modified"]
        assert len(modified) == 1
        assert modified[0]["details"]["version"]["a"] == "24.0.1"
        assert modified[0]["details"]["version"]["b"] == "24.0.2"

    def test_param_change_detected(self, tmp_path):
        run_a = {"run_id": 1, "pipeline_id": "mriqc", "pipeline_version": "24.0.2",
                 "status": "success", "artifact_count": 3,
                 "params": {"participant_label": "sub-01"}}
        run_b = {**run_a, "params": {"participant_label": "sub-02"}}
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [run_a])
        self._write(pb, [run_b])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        modified = [p for p in result["pipelines"] if p["change"] == "modified"]
        assert "participant_label" in modified[0]["details"]["params"]

    def test_warning_added(self, tmp_path):
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [], warnings=[])
        self._write(pb, [], warnings=["1 run(s) failed."])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert "1 run(s) failed." in result["warnings"]["added"]
        assert result["warnings"]["removed"] == []

    def test_warning_resolved(self, tmp_path):
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [], warnings=["1 run(s) failed."])
        self._write(pb, [], warnings=[])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert "1 run(s) failed." in result["warnings"]["removed"]

    def test_artifact_delta(self, tmp_path):
        pa, pb = tmp_path / "a.json", tmp_path / "b.json"
        self._write(pa, [], artifacts=[{}, {}])
        self._write(pb, [], artifacts=[{}, {}, {}])
        result = _compare_reports(self._mock_report(1, pa), self._mock_report(2, pb))
        assert result["artifacts"]["a"] == 2
        assert result["artifacts"]["b"] == 3
        assert result["artifacts"]["delta"] == 1


# ── Failed-report management (live backend via httpx) ─────────────────────────

import urllib.request  # noqa: E402
import urllib.error  # noqa: E402

BACKEND = "http://localhost:8000/api"


def _http(method: str, url: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class TestFailedReportManagementLive:
    """Hit the real running backend — skipped if backend is unreachable."""

    @pytest.fixture(autouse=True)
    def _require_backend(self):
        try:
            _http("GET", f"{BACKEND}/health")
        except Exception:
            pytest.skip("backend not reachable at localhost:8000")

    def test_delete_ready_report_returns_409(self):
        status, _ = _http("DELETE", f"{BACKEND}/datasets/1/reports/7")
        assert status == 409

    def test_retry_ready_report_returns_409(self):
        status, _ = _http("POST", f"{BACKEND}/datasets/1/reports/7/retry")
        assert status == 409

    def test_delete_nonexistent_report_returns_404(self):
        status, _ = _http("DELETE", f"{BACKEND}/datasets/1/reports/99999")
        assert status == 404

    def test_retry_nonexistent_report_returns_404(self):
        status, _ = _http("POST", f"{BACKEND}/datasets/1/reports/99999/retry")
        assert status == 404

    def test_compare_same_report_returns_400(self):
        status, _ = _http("GET", f"{BACKEND}/datasets/1/reports/compare?a=7&b=7")
        assert status == 400

    def test_compare_non_ready_report_returns_409(self):
        status, _ = _http("GET", f"{BACKEND}/datasets/1/reports/compare?a=2&b=7")
        assert status == 409

    def test_compare_two_ready_reports_returns_200(self):
        status, body = _http("GET", f"{BACKEND}/datasets/1/reports/compare?a=4&b=7")
        assert status == 200
        d = json.loads(body)
        assert "report_a" in d and "report_b" in d
        assert "runs" in d and "pipelines" in d and "artifacts" in d

    def test_pdf_download_returns_valid_pdf(self):
        status, body = _http("GET", f"{BACKEND}/datasets/1/reports/7/download/pdf")
        assert status == 200
        assert body[:4] == b"%PDF"

    def test_pdf_download_missing_for_old_report(self):
        status, _ = _http("GET", f"{BACKEND}/datasets/1/reports/4/download/pdf")
        assert status == 404
