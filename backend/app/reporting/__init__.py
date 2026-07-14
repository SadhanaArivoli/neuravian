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
]
