"""Parse tqdm-style progress lines emitted by neuroimaging pipelines."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime

# Matches lines like:
#  27%|██▋       |  68/256 [2:54:08<8:03:20, 154.13s/it]
#   0%|          |   1/256 [02:34<10:57:21, 154.14s/it]
_TQDM_RE = re.compile(
    r"(\d+)%\|.*?\|\s*(\d+)/(\d+)\s*\[([\d:]+)<([\d:]+),\s*([\d.]+)s/(\w+)\]"
)


def _parse_hms(s: str) -> int:
    """Convert MM:SS or H:MM:SS (or HH:MM:SS) string to integer seconds."""
    parts = s.split(":")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    elif len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    return 0


@dataclass
class ParsedProgress:
    percent: int
    current: int
    total: int
    elapsed_seconds: int
    eta_seconds: int
    rate: float
    rate_unit: str
    last_updated: str  # ISO 8601 UTC


def parse_tqdm_line(line: str) -> ParsedProgress | None:
    """Return a ParsedProgress if *line* contains a tqdm progress bar, else None."""
    m = _TQDM_RE.search(line)
    if not m:
        return None
    percent, current, total, elapsed_str, eta_str, rate_str, rate_unit = m.groups()
    return ParsedProgress(
        percent=int(percent),
        current=int(current),
        total=int(total),
        elapsed_seconds=_parse_hms(elapsed_str),
        eta_seconds=_parse_hms(eta_str),
        rate=float(rate_str),
        rate_unit=rate_unit,
        last_updated=datetime.now(UTC).isoformat(),
    )
