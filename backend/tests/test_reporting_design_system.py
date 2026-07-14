"""Regression coverage for the shared embedded HTML report design system."""

from pathlib import Path
from html.parser import HTMLParser

from app.reporting import (
    citation_block,
    document_shell,
    download_link,
    figure_block,
    footer,
    info_box,
    key_value_table,
    metadata_grid,
    methods_block,
    statistics_cards,
    warning_box,
)


TOOL_REPORT_GENERATORS = [
    "alff_falff.py",
    "regional_homogeneity.py",
    "functional_connectivity.py",
    "group_functional_connectivity.py",
    "seed_based_connectivity.py",
    "connectome_graph_analysis.py",
    "atlas_roi_extraction.py",
    "statistical_map_explorer.py",
    "nifti_inspector.py",
]


def test_shared_shell_is_dark_parseable_private_and_printable() -> None:
    body = (
        metadata_grid({"Source": "/app/data/derivatives/run-42/input.nii.gz"})
        + statistics_cards({"Mean": 1.25})
        + key_value_table({"Host input": "/Users/researcher/private/sub-01.nii.gz"})
        + warning_box("Warning", "Review this value")
        + info_box("Information", "Descriptive result")
        + figure_block("plot.png", "Plot", "Caption")
        + download_link("Download", "output.csv")
        + methods_block("A reproducible method")
        + citation_block(["Example citation"])
    )
    rendered = document_shell("Test report", "Embedded preview", body, footer_html=footer())
    parser = HTMLParser()
    parser.feed(rendered)

    assert 'data-report-system="neuroforge-report-system-v1"' in rendered
    assert 'name="neuroforge-report-system"' in rendered
    assert 'id="neuroforge-report-theme"' in rendered
    assert "background:#090d18" in rendered
    assert "color:#e6edf7" in rendered
    assert "color-scheme:dark" in rendered
    assert "@media print" in rendered
    assert "/app/data/" not in rendered
    assert "/Users/" not in rendered
    assert "input.nii.gz" in rendered and "sub-01.nii.gz" in rendered
    assert "<table>" in rendered and "<figure" in rendered and "<footer" in rendered


def test_every_first_party_tool_report_uses_shared_shell_without_inline_theme() -> None:
    tools_dir = Path(__file__).parents[1] / "app" / "tools"
    for filename in TOOL_REPORT_GENERATORS:
        source = (tools_dir / filename).read_text(encoding="utf-8")
        assert "document_shell(" in source, filename
        assert "<style" not in source.lower(), filename


def test_safe_download_link_never_exposes_parent_path() -> None:
    link = download_link("Result", "/root/internal/output.csv")
    assert "/root/" not in link
    assert 'href="output.csv"' in link
