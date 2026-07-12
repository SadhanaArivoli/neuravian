"""Shared fMRIPrep nuisance-regressor selection for native functional tools."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

MOTION6 = ("trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z")
CONFOUND_STRATEGIES: dict[str, tuple[str, ...]] = {
    "none": (),
    "motion6": MOTION6,
    "motion6_wm_csf": MOTION6 + ("white_matter", "csf"),
    "motion6_wm_csf_global": MOTION6 + ("white_matter", "csf", "global_signal"),
}


@dataclass(frozen=True)
class ConfoundSelection:
    values: np.ndarray | None
    used: list[str]
    missing: list[str]


def select_confounds(path: Path | None, strategy: str, n_timepoints: int) -> ConfoundSelection:
    if strategy not in CONFOUND_STRATEGIES:
        raise ValueError(f"Unknown confound strategy '{strategy}'")
    requested = CONFOUND_STRATEGIES[strategy]
    if not requested:
        return ConfoundSelection(None, [], [])
    if path is None or not path.exists():
        return ConfoundSelection(None, [], list(requested))
    frame = pd.read_csv(path, sep="\t")
    if len(frame) != n_timepoints:
        raise ValueError(
            f"Confounds have {len(frame)} rows but BOLD has {n_timepoints} timepoints"
        )
    used = [column for column in requested if column in frame.columns]
    missing = [column for column in requested if column not in frame.columns]
    if missing:
        return ConfoundSelection(None, [], missing)
    values = (
        frame[used].replace([np.inf, -np.inf], np.nan).fillna(0.0).to_numpy(float)
    )
    return ConfoundSelection(values, used, [])
