"""Wizard API — DICOM Mapping Wizard endpoints.

Implements the scout step: runs dcm2bids_helper in a Docker container,
parses the emitted sidecar JSONs, applies lightweight heuristics to
classify each series, and returns structured metadata to the UI.

No config.json is generated here. No dcm2bids execution is launched.
No dataset files are modified (DICOM dir is mounted read-only).
"""

from __future__ import annotations

import json
import logging
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.execution.docker_executor import from_host_path, to_host_path

log = logging.getLogger(__name__)
router = APIRouter(tags=["wizard"])

_DCM2BIDS_IMAGE = "unfmontreal/dcm2bids:3.2.0"

# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class ScoutRequest(BaseModel):
    dicom_path: str
    participant_id: str
    session_id: str | None = None


class SeriesClassification(BaseModel):
    modality: str
    confidence: str          # "high" | "medium" | "low"
    reason: str
    suggested_datatype: str | None = None
    suggested_suffix: str | None = None
    skip_recommended: bool = False


class DiscoveredSeries(BaseModel):
    series_number: int | None
    acquisition_time: str | None
    series_description: str | None
    protocol_name: str | None
    image_type: list[str] | None
    tr: float | None                 # RepetitionTime in seconds
    te: float | None                 # EchoTime in seconds
    inversion_time: float | None
    flip_angle: float | None
    echo_number: int | None
    phase_encoding_direction: str | None
    manufacturer: str | None
    manufacturers_model_name: str | None
    magnetic_field_strength: float | None
    slice_thickness: float | None
    raw_sidecar: dict[str, Any]      # Full sidecar JSON — shown in advanced mode only
    classification: SeriesClassification


class ScoutResponse(BaseModel):
    series: list[DiscoveredSeries]
    dicom_path: str
    participant_id: str
    session_id: str | None
    helper_log: str


# ---------------------------------------------------------------------------
# Heuristics
# ---------------------------------------------------------------------------

def _contains(text: str | None, *patterns: str) -> bool:
    if not text:
        return False
    lower = text.lower()
    return any(p.lower() in lower for p in patterns)


def _classify(sidecar: dict[str, Any]) -> SeriesClassification:
    desc = sidecar.get("SeriesDescription") or ""
    proto = sidecar.get("ProtocolName") or ""
    image_type = sidecar.get("ImageType") or []
    if isinstance(image_type, str):
        image_type = [image_type]

    tr = sidecar.get("RepetitionTime")
    te = sidecar.get("EchoTime")
    inv = sidecar.get("InversionTime")
    echo_num = sidecar.get("EchoNumber")

    # Helpers
    is_derived = "DERIVED" in [str(t).upper() for t in image_type]
    is_phase = "P" in [str(t).upper() for t in image_type]

    combined = f"{desc} {proto}"

    # ── Localizer / Scout ───────────────────────────────────────────────────
    if _contains(combined, "localizer", "scout", "aascout", "survey", "phoenix",
                 "screen save", "mrsave"):
        return SeriesClassification(
            modality="Localizer",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches a known localizer pattern.',
            suggested_datatype=None,
            suggested_suffix=None,
            skip_recommended=True,
        )

    # ── T1w: MPRAGE / MP2RAGE / SPGR / BRAVO ───────────────────────────────
    if _contains(combined, "mprage", "mp2rage", "t1w", "t1_", "t1-", "bravo",
                 "fspgr", "spgr", "vibe", "3dt1", "3d_t1"):
        return SeriesClassification(
            modality="Structural MRI (T1w)",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches a T1-weighted pattern.',
            suggested_datatype="anat",
            suggested_suffix="T1w",
        )

    # ── T2w ─────────────────────────────────────────────────────────────────
    if _contains(combined, "t2w", "t2_", "t2-", "tse", "fse", "rare",
                 "3dt2", "3d_t2"):
        if _contains(combined, "flair"):
            pass  # Fall through to FLAIR block
        else:
            return SeriesClassification(
                modality="Structural MRI (T2w)",
                confidence="high",
                reason=f'SeriesDescription "{desc}" matches a T2-weighted pattern.',
                suggested_datatype="anat",
                suggested_suffix="T2w",
            )

    # ── FLAIR ────────────────────────────────────────────────────────────────
    if _contains(combined, "flair"):
        return SeriesClassification(
            modality="FLAIR",
            confidence="high",
            reason=f'SeriesDescription "{desc}" contains "FLAIR".',
            suggested_datatype="anat",
            suggested_suffix="FLAIR",
        )

    # ── Diffusion MRI ────────────────────────────────────────────────────────
    if _contains(combined, "dwi", "dti", "dmri", "diffusion", "hardi", "dki",
                 "noddi", "qsi"):
        return SeriesClassification(
            modality="Diffusion MRI",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches a diffusion imaging pattern.',
            suggested_datatype="dwi",
            suggested_suffix="dwi",
        )

    # ── Fieldmap ─────────────────────────────────────────────────────────────
    if _contains(combined, "fieldmap", "field_map", "field-map", "fmap",
                 "b0map", "b0_map", "gre_field", "phasediff", "phase_diff"):
        if is_phase:
            suffix = "phasediff"
        else:
            suffix = "magnitude1"
        return SeriesClassification(
            modality="Fieldmap",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches a fieldmap pattern.',
            suggested_datatype="fmap",
            suggested_suffix=suffix,
        )

    # ── T2* / SWI / GRE ─────────────────────────────────────────────────────
    if _contains(combined, "t2star", "swi", "swan", "venous", "susceptibility"):
        return SeriesClassification(
            modality="T2* / SWI",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches a T2* or SWI pattern.',
            suggested_datatype="anat",
            suggested_suffix="T2starw",
        )

    # ── Perfusion / ASL ──────────────────────────────────────────────────────
    if _contains(combined, "asl", "pcasl", "pasl", "casl", "perfusion"):
        return SeriesClassification(
            modality="Arterial Spin Labeling (ASL)",
            confidence="high",
            reason=f'SeriesDescription "{desc}" matches an ASL/perfusion pattern.',
            suggested_datatype="perf",
            suggested_suffix="asl",
        )

    # ── fMRI: resting-state ──────────────────────────────────────────────────
    if _contains(combined, "rest", "resting", "rsfmri", "rs-fmri", "rs_fmri"):
        return SeriesClassification(
            modality="Resting-state fMRI",
            confidence="high",
            reason=f'SeriesDescription "{desc}" contains a resting-state fMRI keyword.',
            suggested_datatype="func",
            suggested_suffix="bold",
        )

    # ── fMRI: task ───────────────────────────────────────────────────────────
    if _contains(combined, "bold", "fmri", "epi", "func", "task"):
        return SeriesClassification(
            modality="Task fMRI",
            confidence="high",
            reason=f'SeriesDescription "{desc}" contains a functional MRI keyword.',
            suggested_datatype="func",
            suggested_suffix="bold",
        )

    # ── fMRI by TR heuristic (short TR = functional) ─────────────────────────
    if tr is not None and float(tr) < 3.0:
        if _contains(combined, "sbref", "single-band", "singleband"):
            return SeriesClassification(
                modality="fMRI Reference (SBRef)",
                confidence="medium",
                reason=f"Short TR ({tr}s) and name suggests a single-band reference volume.",
                suggested_datatype="func",
                suggested_suffix="sbref",
            )
        return SeriesClassification(
            modality="fMRI (inferred from TR)",
            confidence="medium",
            reason=f"TR={tr}s is shorter than 3 s, suggesting a functional EPI acquisition.",
            suggested_datatype="func",
            suggested_suffix="bold",
        )

    # ── Inversion recovery (by InversionTime only) ───────────────────────────
    if inv is not None and float(inv) > 0:
        return SeriesClassification(
            modality="Inversion Recovery",
            confidence="medium",
            reason=f"InversionTime={inv}s detected — likely a T1-weighted inversion recovery sequence.",
            suggested_datatype="anat",
            suggested_suffix="T1w",
        )

    # ── Derived / post-processed ─────────────────────────────────────────────
    if is_derived:
        return SeriesClassification(
            modality="Derived / Post-processed",
            confidence="medium",
            reason="ImageType contains DERIVED — this is likely a processed output (ADC map, MIP, etc.).",
            skip_recommended=True,
        )

    # ── Unknown ──────────────────────────────────────────────────────────────
    return SeriesClassification(
        modality="Unknown",
        confidence="low",
        reason=f'No known imaging pattern matched SeriesDescription "{desc}".',
    )


# ---------------------------------------------------------------------------
# Sidecar parsing
# ---------------------------------------------------------------------------

def _parse_sidecars(helper_dir: Path) -> list[DiscoveredSeries]:
    """Parse all JSON sidecars emitted by dcm2bids_helper."""
    json_files = sorted(helper_dir.glob("*.json"))
    series: list[DiscoveredSeries] = []

    for jf in json_files:
        try:
            raw = json.loads(jf.read_text())
        except Exception as exc:
            log.warning("Failed to parse sidecar %s: %s", jf.name, exc)
            continue

        def _float(key: str) -> float | None:
            v = raw.get(key)
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None

        def _int(key: str) -> int | None:
            v = raw.get(key)
            try:
                return int(v) if v is not None else None
            except (TypeError, ValueError):
                return None

        image_type = raw.get("ImageType")
        if isinstance(image_type, str):
            image_type = [image_type]

        classification = _classify(raw)

        series.append(DiscoveredSeries(
            series_number=_int("SeriesNumber"),
            acquisition_time=raw.get("AcquisitionTime"),
            series_description=raw.get("SeriesDescription"),
            protocol_name=raw.get("ProtocolName"),
            image_type=image_type,
            tr=_float("RepetitionTime"),
            te=_float("EchoTime"),
            inversion_time=_float("InversionTime"),
            flip_angle=_float("FlipAngle"),
            echo_number=_int("EchoNumber"),
            phase_encoding_direction=raw.get("PhaseEncodingDirection"),
            manufacturer=raw.get("Manufacturer"),
            manufacturers_model_name=raw.get("ManufacturersModelName"),
            magnetic_field_strength=_float("MagneticFieldStrength"),
            slice_thickness=_float("SliceThickness"),
            raw_sidecar=raw,
            classification=classification,
        ))

    # Sort by SeriesNumber then AcquisitionTime
    series.sort(key=lambda s: (s.series_number or 9999, s.acquisition_time or ""))
    return series


# ---------------------------------------------------------------------------
# Scout endpoint
# ---------------------------------------------------------------------------

@router.post("/wizard/dcm2bids/scout", response_model=ScoutResponse)
def scout_dicom(body: ScoutRequest) -> ScoutResponse:
    """Run dcm2bids_helper on a DICOM directory and return discovered series.

    The DICOM directory is mounted read-only. No output dataset is written.
    A temporary directory receives the helper's sidecar JSONs, which are
    parsed and discarded when the request completes.
    """
    # ── Resolve the DICOM path ──────────────────────────────────────────────
    # User provides a host path; we need:
    #   - container-internal path (accessible to backend) for existence checks
    #   - host path (accessible to Docker daemon) for volume mounts
    container_dicom_path = from_host_path(body.dicom_path)
    if not Path(container_dicom_path).exists():
        raise HTTPException(
            status_code=400,
            detail=f"DICOM directory not found: {body.dicom_path}",
        )
    if not Path(container_dicom_path).is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Path is not a directory: {body.dicom_path}",
        )

    host_dicom_path = to_host_path(container_dicom_path)

    # ── Create a temp output directory (backend-accessible) ─────────────────
    import os
    data_dir = os.environ.get("DATA_DIR", "./data")
    tmp_base = Path(data_dir) / "wizard_tmp"
    tmp_base.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=tmp_base, prefix="scout_") as tmp_str:
        tmp_output = Path(tmp_str)
        host_output = to_host_path(str(tmp_output))

        # ── Run dcm2bids_helper via Docker SDK ───────────────────────────────
        import docker as _docker

        log.info(
            "Scout: docker run %s dcm2bids_helper -d /dicom -o /output "
            "(dicom=%s output=%s)",
            _DCM2BIDS_IMAGE, host_dicom_path, host_output,
        )
        t0 = time.monotonic()

        try:
            client = _docker.from_env()
            container = client.containers.run(
                _DCM2BIDS_IMAGE,
                entrypoint="dcm2bids_helper",
                command=["-d", "/dicom", "-o", "/output"],
                volumes={
                    host_dicom_path: {"bind": "/dicom", "mode": "ro"},
                    host_output: {"bind": "/output", "mode": "rw"},
                },
                platform="linux/amd64",
                detach=True,
                remove=False,
            )
            exit_code = container.wait(timeout=300)["StatusCode"]
            helper_log = container.logs(stdout=True, stderr=True).decode("utf-8", errors="replace")
            container.remove()
        except _docker.errors.ContainerError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"dcm2bids_helper container error: {exc}",
            )
        except _docker.errors.ImageNotFound:
            raise HTTPException(
                status_code=503,
                detail=f"Docker image {_DCM2BIDS_IMAGE} not found. Pull it with: docker pull {_DCM2BIDS_IMAGE}",
            )
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=f"Docker error: {exc}",
            )

        elapsed = time.monotonic() - t0
        log.info("Scout finished in %.1fs, exit=%d", elapsed, exit_code)

        # dcm2bids_helper exits 0 on success; non-zero is still often partial
        if exit_code != 0 and not any(tmp_output.rglob("*.json")):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"dcm2bids_helper failed (exit {exit_code}). "
                    f"Log: {helper_log[-1000:]}"
                ),
            )

        # ── Parse sidecars ───────────────────────────────────────────────────
        # Helper writes to: <output>/tmp_dcm2bids/helper/
        helper_dir = tmp_output / "tmp_dcm2bids" / "helper"
        if not helper_dir.exists():
            # Fallback: search entire output tree
            json_files = list(tmp_output.rglob("*.json"))
            if not json_files:
                raise HTTPException(
                    status_code=422,
                    detail="No sidecar JSON files produced. The folder may contain no convertible DICOMs.",
                )
            helper_dir = tmp_output

        series = _parse_sidecars(helper_dir)

    return ScoutResponse(
        series=series,
        dicom_path=body.dicom_path,
        participant_id=body.participant_id,
        session_id=body.session_id,
        helper_log=helper_log,
    )
