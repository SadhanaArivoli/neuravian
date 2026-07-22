"""Regression coverage for the shared embedded HTML report design system."""

from pathlib import Path
from html.parser import HTMLParser
import html

import matplotlib.pyplot as plt
from PIL import Image
import pytest

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
    save_dark_figure,
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

    assert 'data-report-system="neuravian-report-system-v1"' in rendered
    assert 'name="neuravian-report-system"' in rendered
    assert 'id="neuravian-report-theme"' in rendered
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


def test_report_generators_do_not_bypass_publication_resolution() -> None:
    tools_dir = Path(__file__).parents[1] / "app" / "tools"
    for filename in TOOL_REPORT_GENERATORS:
        source = (tools_dir / filename).read_text(encoding="utf-8")
        direct_saves = [line for line in source.splitlines() if ".savefig(" in line]
        assert all("PUBLICATION_DPI" in line for line in direct_saves), filename


def test_tool_reports_use_curated_metadata_schemas() -> None:
    tools_dir = Path(__file__).parents[1] / "app" / "tools"
    for filename in TOOL_REPORT_GENERATORS:
        source = (tools_dir / filename).read_text(encoding="utf-8")
        assert "metadata.items()" not in source, filename


def test_theme_explicitly_colors_all_semantic_report_elements() -> None:
    rendered = document_shell("Contrast", "Semantic cascade audit", "<p>Text</p>")
    for element in ("h1", "h2", "h3", "p", "th", "td", "code", "pre", "a", "caption", "figcaption", "table", "figure"):
        assert f"html[data-report-system] {element}" in rendered, element


def test_dark_figure_save_has_opaque_nonwhite_corners(tmp_path: Path) -> None:
    fig, ax = plt.subplots(figsize=(3, 2))
    ax.plot([0, 1], [0, 1])
    output = tmp_path / "plot.png"
    save_dark_figure(fig, output, dpi=80)
    plt.close(fig)
    with Image.open(output).convert("RGB") as image:
        assert image.info.get("dpi", (0, 0))[0] >= 299
        corners = [image.getpixel((0, 0)), image.getpixel((image.width - 1, 0)), image.getpixel((0, image.height - 1)), image.getpixel((image.width - 1, image.height - 1))]
    assert all(max(pixel) < 245 for pixel in corners)


def test_safe_download_link_never_exposes_parent_path() -> None:
    link = download_link("Result", "/root/internal/output.csv")
    assert "/root/" not in link
    assert 'href="output.csv"' in link


def test_safe_display_values_redact_posix_and_windows_paths() -> None:
    rendered = key_value_table({
        "Private": "/private/tmp/study/sub-01.nii.gz",
        "Windows": r"C:\\research\\private\\sub-02.nii.gz",
        "Sentence": "Loaded /srv/neuravian/internal/result.tsv successfully",
        "Documentation": "https://example.org/neuroimaging/reporting",
    })
    assert "/private/" not in rendered and "C:\\" not in rendered and "/srv/" not in rendered
    assert "sub-01.nii.gz" in rendered and "sub-02.nii.gz" in rendered and "result.tsv" in rendered
    assert "https://example.org/neuroimaging/reporting" in rendered


def test_browser_computed_report_contrast_and_iframe_background() -> None:
    playwright = pytest.importorskip("playwright.sync_api")
    report = document_shell(
        "Browser contrast",
        "Embedded report",
        "<p>Readable paragraph</p>"
        + key_value_table({"Subject": "sub-01", "Input": "/app/data/private/input.nii.gz"})
        + '<p><a href="result.csv">Readable link</a></p>',
    )
    outer = (
        '<body style="margin:0;background:#050811">'
        '<iframe style="width:900px;height:700px;border:0;background:#090d18" srcdoc="'
        + html.escape(report, quote=True)
        + '"></iframe></body>'
    )
    with playwright.sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(outer)
        frame = page.frames[1]
        expected_light = "rgb(230, 237, 247)"
        colors = frame.locator("body").evaluate(
            "el => Object.fromEntries(['h1','p','th','td','a'].map(tag => "
            "[tag, getComputedStyle(el.querySelector(tag)).color]))"
        )
        assert colors["h1"] == expected_light
        assert colors["p"] == expected_light
        assert colors["th"] == expected_light
        assert colors["td"] == expected_light
        assert colors["a"] == "rgb(103, 232, 249)"
        assert frame.locator("body").evaluate("el => getComputedStyle(el).backgroundColor") == "rgb(9, 13, 24)"
        assert page.locator("iframe").evaluate("el => getComputedStyle(el).backgroundColor") == "rgb(9, 13, 24)"
        assert "/app/data/" not in frame.locator("body").inner_text()
        assert not frame.locator("html").evaluate("el => el.scrollWidth > el.clientWidth")
        browser.close()
