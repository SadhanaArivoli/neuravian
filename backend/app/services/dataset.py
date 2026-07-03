import hashlib
import json
import logging
import os
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.dataset import Dataset
from app.schemas.dataset import (
    DatasetCreate,
    DatasetRead,
    DatasetSummary,
    IndexedMetadata,
    ValidationIssue,
    ValidationIssues,
)
from app.services.bids_patterns import run_pattern_checks

logger = logging.getLogger(__name__)

_CONTAINER_DATASETS_PATH = Path("/host-data")

# Suffixes to ignore when reporting invalid BIDS filenames (not every file needs to be BIDS)
_NON_BIDS_SUFFIXES = {".json", ".tsv", ".txt", ".md", ".bvec", ".bval", ".gz"}


def _compute_manifest_hash(root: Path) -> str:
    """SHA-256 over sorted (rel_path, size, mtime) tuples for all files.

    Fast (no file content read), detects additions/deletions/replacements.
    mtime is truncated to integer seconds to avoid float precision noise.
    """
    entries: list[str] = []
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()
        stat = f.stat()
        entries.append(f"{rel}\t{stat.st_size}\t{int(stat.st_mtime)}")
    return hashlib.sha256("\n".join(entries).encode()).hexdigest()


def _translate_host_path(path: Path) -> Path:
    """
    If HOST_DATASETS_MOUNT is set and the given path starts with that prefix,
    rewrite it to the container-side /host-data equivalent so users can paste
    their normal Mac paths without knowing about Docker volume mounts.
    """
    if not settings.host_datasets_mount:
        return path
    host_mount = Path(settings.host_datasets_mount)
    try:
        relative = path.relative_to(host_mount)
        return _CONTAINER_DATASETS_PATH / relative
    except ValueError:
        return path


def _validate_with_bids_validator(root: Path) -> list[str]:
    """Return list of relative paths that fail BIDS filename validation."""
    from bids_validator import BIDSValidator  # type: ignore[import]

    validator = BIDSValidator()
    invalid: list[str] = []
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            abs_path = Path(dirpath) / fname
            rel = "/" + str(abs_path.relative_to(root))
            if not validator.is_bids(rel):
                # Only flag files that look like they're trying to be BIDS
                if "sub-" in fname or fname in (
                    "dataset_description.json",
                    "participants.tsv",
                    "README",
                    "CHANGES",
                ):
                    invalid.append(str(abs_path.relative_to(root)))
    return invalid


def _index_with_pybids(root: Path) -> IndexedMetadata:
    """Run pybids layout and return structured metadata."""
    from bids import BIDSLayout  # type: ignore[import]

    desc_path = root / "dataset_description.json"
    name: str | None = None
    bids_version: str | None = None
    if desc_path.exists():
        try:
            desc = json.loads(desc_path.read_text())
            name = desc.get("Name")
            bids_version = desc.get("BIDSVersion")
        except Exception:
            pass

    try:
        layout = BIDSLayout(str(root), validate=False)
        subjects = layout.get_subjects()
        sessions = layout.get_sessions()
        tasks = layout.get_tasks()
        files = layout.get()
        datatypes = sorted(
            {f.get_entities().get("datatype", "") for f in files} - {""}
        )
        # Filter suffixes to imaging/data suffixes only
        raw_suffixes = sorted(
            {f.get_entities().get("suffix", "") for f in files} - {""}
        )
        imaging_suffixes = [
            s for s in raw_suffixes if s not in ("description", "participants", "scans")
        ]
        file_count = len(files)
    except Exception as exc:
        logger.warning("pybids indexing failed: %s", exc)
        subjects = sessions = tasks = datatypes = imaging_suffixes = []
        file_count = 0

    return IndexedMetadata(
        name=name,
        bids_version=bids_version,
        subjects=subjects,
        sessions=sessions,
        tasks=tasks,
        datatypes=datatypes,
        suffixes=imaging_suffixes,
        file_count=file_count,
    )


class DatasetService:
    def __init__(self, db: Session) -> None:
        self._db = db

    def register_path(self, path: str) -> DatasetRead:
        return self.register(DatasetCreate(path=path))

    def register(self, payload: DatasetCreate) -> DatasetRead:
        raw = Path(payload.path)
        root = _translate_host_path(raw).resolve()

        if not root.exists():
            # Give a helpful message that names both the received path and
            # the container path so the user can diagnose mount issues.
            detail = f"Path does not exist: {payload.path}"
            if root != raw.resolve():
                detail += f" (looked for it inside the container at {root})"
            raise FileNotFoundError(detail)
        if not root.is_dir():
            raise NotADirectoryError(f"Path is not a directory: {root}")

        # Reject duplicate registrations
        existing = (
            self._db.query(Dataset).filter(Dataset.path == str(root)).first()
        )
        if existing is not None:
            raise ValueError(f"Dataset already registered (id={existing.id})")

        name = root.name
        dataset = Dataset(
            name=name,
            path=str(root),
            validation_status="indexing",
        )
        self._db.add(dataset)
        self._db.flush()  # get id without committing

        try:
            # 1. bids-validator file sweep
            invalid_files = _validate_with_bids_validator(root)

            # 2. Pattern-based checks
            pattern_errors, pattern_warnings = run_pattern_checks(root)

            # 3. Build issues list
            issues_errors = list(pattern_errors)
            issues_warnings = list(pattern_warnings)

            if invalid_files:
                issues_warnings.append(
                    {
                        "code": "INVALID_BIDS_FILENAME",
                        "message": f"{len(invalid_files)} file(s) have names that don't match any BIDS pattern",
                        "friendly": (
                            f"{len(invalid_files)} file(s) in your dataset have names that "
                            "don't follow the BIDS naming convention. These files will be "
                            "ignored by BIDS-aware tools."
                        ),
                        "fix_hint": (
                            "Check the filenames listed below against the BIDS specification "
                            "(bids-specification.readthedocs.io). Common causes: missing "
                            "entity labels, wrong suffix, or extra characters in the name."
                        ),
                        "files": invalid_files[:20],
                    }
                )

            has_errors = bool(issues_errors)
            validation_status = "invalid" if has_errors else (
                "warning" if issues_warnings else "valid"
            )

            validation_issues = ValidationIssues(
                errors=[ValidationIssue(**e) for e in issues_errors],
                warnings=[ValidationIssue(**w) for w in issues_warnings],
            )

            # 4. pybids indexing
            metadata = _index_with_pybids(root)

            dataset.validation_status = validation_status
            dataset.bids_version = metadata.bids_version
            dataset.validation_issues = validation_issues.model_dump_json()
            dataset.indexed_metadata = metadata.model_dump_json()
            dataset.dataset_hash = _compute_manifest_hash(root)

        except Exception as exc:
            logger.error("Dataset registration failed for %s: %s", root, exc)
            dataset.validation_status = "error"
            self._db.commit()
            raise

        self._db.commit()
        self._db.refresh(dataset)
        return self._to_read(dataset)

    def list_all(self) -> list[DatasetSummary]:
        rows = self._db.query(Dataset).order_by(Dataset.created_at.desc()).all()
        return [self._to_summary(d) for d in rows]

    def get_by_id(self, dataset_id: int) -> DatasetRead:
        dataset = self._db.get(Dataset, dataset_id)
        if dataset is None:
            raise KeyError(f"Dataset {dataset_id} not found")
        return self._to_read(dataset)

    # ------------------------------------------------------------------ #
    # Helpers                                                              #
    # ------------------------------------------------------------------ #

    def _to_read(self, d: Dataset) -> DatasetRead:
        issues = (
            ValidationIssues.model_validate_json(d.validation_issues)
            if d.validation_issues
            else None
        )
        meta = (
            IndexedMetadata.model_validate_json(d.indexed_metadata)
            if d.indexed_metadata
            else None
        )
        return DatasetRead(
            id=d.id,
            name=d.name,
            path=d.path,
            bids_version=d.bids_version,
            validation_status=d.validation_status,
            validation_issues=issues,
            indexed_metadata=meta,
            created_at=d.created_at,
            updated_at=d.updated_at,
        )

    def _to_summary(self, d: Dataset) -> DatasetSummary:
        subject_count = 0
        if d.indexed_metadata:
            try:
                meta = json.loads(d.indexed_metadata)
                subject_count = len(meta.get("subjects", []))
            except Exception:
                pass
        return DatasetSummary(
            id=d.id,
            name=d.name,
            path=d.path,
            validation_status=d.validation_status,
            bids_version=d.bids_version,
            subject_count=subject_count,
            created_at=d.created_at,
        )
