"""Shared fMRIPrep nuisance-regressor selection for native functional tools."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

MOTION6 = ("trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z")
MOTION6_DERIV = tuple(f"{p}_derivative1" for p in MOTION6)
MOTION6_SQ = tuple(f"{p}_power2" for p in MOTION6)
MOTION6_DERIV_SQ = tuple(f"{p}_derivative1_power2" for p in MOTION6)
MOTION24 = MOTION6 + MOTION6_DERIV + MOTION6_SQ + MOTION6_DERIV_SQ
WM_CSF = ("white_matter", "csf")
GSR = ("global_signal",)

# Canonical strategy names — listed in the UI in this order.
CONFOUND_STRATEGIES: dict[str, tuple[str, ...]] = {
    "none": (),
    "motion6": MOTION6,
    "motion24": MOTION24,
    "motion6_wm_csf": MOTION6 + WM_CSF,
    "motion6_wm_csf_gsr": MOTION6 + WM_CSF + GSR,
    # Legacy alias kept for runs created before the rename.
    "motion6_wm_csf_global": MOTION6 + WM_CSF + GSR,
}

GSR_STRATEGIES: frozenset[str] = frozenset({"motion6_wm_csf_gsr", "motion6_wm_csf_global"})


def strategy_includes_gsr(strategy: str) -> bool:
    """Return True when the strategy includes global signal regression."""
    return strategy in GSR_STRATEGIES


@dataclass(frozen=True)
class ConfoundSelection:
    values: np.ndarray | None
    used: list[str]
    missing: list[str]
    strategy: str = "none"
    n_regressors: int = 0
    global_signal_included: bool = False


def select_confounds(
    path: Path | None,
    strategy: str,
    n_timepoints: int,
    *,
    strict: bool = False,
) -> ConfoundSelection:
    """Select confound regressors for a given strategy.

    Parameters
    ----------
    path:
        Path to the fMRIPrep confounds TSV, or None if no file exists.
    strategy:
        One of the keys in CONFOUND_STRATEGIES.
    n_timepoints:
        Expected number of rows in the confounds TSV. Mismatches are always
        an error regardless of the strict flag.
    strict:
        When True and required columns are missing from the TSV, raise
        ValueError so the user knows their chosen strategy could not be
        applied. Default is False (lenient) so that ALFF, ReHo, and other
        callers retain their existing graceful-skip behavior. Pass
        strict=True explicitly from FC to enforce confound correctness.
    """
    if strategy not in CONFOUND_STRATEGIES:
        raise ValueError(
            f"Unknown confound strategy '{strategy}'. "
            f"Valid strategies: {', '.join(CONFOUND_STRATEGIES)}"
        )
    requested = CONFOUND_STRATEGIES[strategy]
    gsr = strategy_includes_gsr(strategy)

    if not requested:
        return ConfoundSelection(
            values=None, used=[], missing=[],
            strategy=strategy, n_regressors=0, global_signal_included=False,
        )

    if path is None or not path.exists():
        if strict and requested:
            raise ValueError(
                f"Confound strategy '{strategy}' requires {len(requested)} columns "
                "but no confounds TSV was found. Either run fMRIPrep to generate "
                "confounds or use confound-strategy=none."
            )
        return ConfoundSelection(
            values=None, used=[], missing=list(requested),
            strategy=strategy, n_regressors=0, global_signal_included=gsr,
        )

    frame = pd.read_csv(path, sep="\t")
    if len(frame) != n_timepoints:
        raise ValueError(
            f"Confounds TSV has {len(frame)} rows but BOLD has {n_timepoints} timepoints."
        )

    used = [col for col in requested if col in frame.columns]
    missing = [col for col in requested if col not in frame.columns]

    if missing and strict:
        raise ValueError(
            f"Confound strategy '{strategy}' requires columns that are absent "
            f"from the confounds TSV: {missing}. "
            "Use a less aggressive strategy or check your fMRIPrep outputs."
        )

    if not used:
        return ConfoundSelection(
            values=None, used=[], missing=missing,
            strategy=strategy, n_regressors=0, global_signal_included=gsr,
        )

    values = (
        frame[used].replace([np.inf, -np.inf], np.nan).fillna(0.0).to_numpy(float)
    )
    return ConfoundSelection(
        values=values,
        used=used,
        missing=missing,
        strategy=strategy,
        n_regressors=len(used),
        global_signal_included="global_signal" in used,
    )
