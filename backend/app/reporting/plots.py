"""Shared dark-canvas policy for report figures written with Matplotlib."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from matplotlib.figure import Figure

DARK_FIGURE_BACKGROUND = "#090d18"
DARK_AXES_BACKGROUND = "#111827"
DARK_TEXT = "#e6edf7"
DARK_MUTED_TEXT = "#cbd5e1"
DARK_SPINE = "#526078"


def apply_dark_figure(fig: Figure) -> Figure:
    """Apply readable dark colors to the figure and every current axes."""
    fig.patch.set_facecolor(DARK_FIGURE_BACKGROUND)
    fig.patch.set_edgecolor(DARK_FIGURE_BACKGROUND)
    for ax in fig.axes:
        ax.set_facecolor(DARK_AXES_BACKGROUND)
        ax.title.set_color(DARK_TEXT)
        ax.xaxis.label.set_color(DARK_MUTED_TEXT)
        ax.yaxis.label.set_color(DARK_MUTED_TEXT)
        ax.tick_params(axis="both", colors=DARK_MUTED_TEXT)
        for spine in ax.spines.values():
            spine.set_color(DARK_SPINE)
        for text in ax.texts:
            if text.get_color() in (None, "black", "#000000", "k"):
                text.set_color(DARK_TEXT)
        legend = ax.get_legend()
        if legend is not None:
            legend.get_frame().set_facecolor(DARK_AXES_BACKGROUND)
            legend.get_frame().set_edgecolor(DARK_SPINE)
            for text in legend.get_texts():
                text.set_color(DARK_TEXT)
    for text in fig.texts:
        if text.get_color() in (None, "black", "#000000", "k"):
            text.set_color(DARK_TEXT)
    return fig


def save_dark_figure(fig: Figure, path: str | Path, **kwargs: Any) -> None:
    """Save an opaque dark figure so browser image backgrounds cannot turn white."""
    apply_dark_figure(fig)
    options: dict[str, Any] = {
        "facecolor": DARK_FIGURE_BACKGROUND,
        "edgecolor": DARK_FIGURE_BACKGROUND,
        "transparent": False,
    }
    options.update(kwargs)
    fig.savefig(path, **options)
