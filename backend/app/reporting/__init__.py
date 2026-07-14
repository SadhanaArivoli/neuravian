"""Shared HTML report design system for NeuroForge-generated reports."""

from app.reporting.components import (
    citation_block,
    data_table,
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
from app.reporting.html import document_shell, safe_display_value
from app.reporting.plots import PUBLICATION_DPI, apply_dark_figure, save_dark_figure

__all__ = [
    "citation_block",
    "data_table",
    "document_shell",
    "download_link",
    "figure_block",
    "footer",
    "info_box",
    "key_value_table",
    "metadata_grid",
    "methods_block",
    "safe_display_value",
    "statistics_cards",
    "warning_box",
    "apply_dark_figure",
    "PUBLICATION_DPI",
    "save_dark_figure",
]
