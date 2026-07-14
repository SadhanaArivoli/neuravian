"""Document shell and privacy-safe human-facing value formatting."""

from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any

from app.reporting.theme import REPORT_CSS, REPORT_SYSTEM_MARKER

_ABS_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|/).+")
_EMBEDDED_PATH = re.compile(r"(?<![\w.:/])(?:[A-Za-z]:[\\/]|/)(?:[^\s,;<>]+[\\/])+[^\s,;<>]+")


def safe_display_value(value: Any) -> str:
    """Escape a value and reduce absolute filesystem paths to safe filenames."""
    if value is None or value == "":
        return "—"
    text = str(value)
    if _ABS_PATH.match(text):
        text = Path(text.replace("\\", "/")).name or "local data"
    else:
        text = _EMBEDDED_PATH.sub(
            lambda match: Path(match.group(0).replace("\\", "/")).name or "local data",
            text,
        )
    return html.escape(text, quote=True)


def document_shell(title: str, subtitle: str, body: str, *, footer_html: str = "") -> str:
    """Wrap report content in the shared, self-contained embedded/print shell."""
    return f"""<!DOCTYPE html>
<html lang="en" data-report-system="{REPORT_SYSTEM_MARKER}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="neuroforge-report-system" content="{REPORT_SYSTEM_MARKER}"/>
<title>{safe_display_value(title)}</title>
<style id="neuroforge-report-theme">{REPORT_CSS}</style>
</head>
<body><main class="nf-page">
<header class="nf-header"><div class="nf-kicker">NeuroForge report</div>
<h1>{safe_display_value(title)}</h1><div class="nf-subtitle">{safe_display_value(subtitle)}</div></header>
{body}
{footer_html}
</main></body></html>"""
