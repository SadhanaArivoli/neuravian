"""Parse manifest-declared or tqdm progress from pipeline log lines."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

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


def parse_progress_line(
    line: str,
    progress_contract: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Return normalized progress using the manifest's declared strategy.

    Regex patterns use named groups (``percent``, ``current``, ``total``, and
    ``stage`` by default). Staged progress maps matched milestones to cumulative
    weights. The existing tqdm parser remains the backward-compatible default.
    """
    config = progress_contract or {"strategy": "tqdm"}
    strategy = config.get("strategy", "tqdm")
    if strategy == "none":
        return None
    if strategy == "tqdm":
        parsed = parse_tqdm_line(line)
        return asdict(parsed) if parsed else None
    if strategy == "regex":
        for rule in config.get("patterns", []):
            match = re.search(rule["pattern"], line)
            if not match:
                continue
            groups = match.groupdict()
            result: dict[str, Any] = {
                "last_updated": datetime.now(UTC).isoformat(),
            }
            for field in ("percent", "current", "total", "stage"):
                group_name = rule.get(f"{field}_group", field)
                value = groups.get(group_name)
                if value is not None:
                    result[field] = int(value) if field != "stage" else value
            if "percent" not in result and result.get("total"):
                result["percent"] = round(
                    result.get("current", 0) * 100 / result["total"]
                )
            return result
        return None
    if strategy == "stages":
        stages = config.get("stages", [])
        total_weight = sum(float(item["weight"]) for item in stages)
        completed = 0.0
        for item in stages:
            if re.search(item["pattern"], line):
                completed += float(item["weight"])
                return {
                    "percent": round(completed * 100 / total_weight),
                    "stage": item["id"],
                    "stage_label": item["label"],
                    "last_updated": datetime.now(UTC).isoformat(),
                }
            completed += float(item["weight"])
        return None
    return None
