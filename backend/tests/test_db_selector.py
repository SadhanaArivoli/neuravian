"""
Tests for the database compatibility selector (app.core.db_selector).

Covers all five scenarios documented in db_selector.py:
  - fresh Neuravian install (neither DB present)
  - legacy NeuroForge upgrade (only neuroforge.db present)
  - post-rename migration (both present; neuravian.db empty, neuroforge.db populated)
  - both databases populated (conflict — deterministic tie-break)
  - only neuravian.db present (standard path)
"""

import os
import sqlite3
from pathlib import Path

import pytest

from app.core.db_selector import _LEGACY_DB, _NEW_DB, DbSelection, select_database


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db(path: Path, *, tables: list[str] | None = None, rows: int = 0) -> None:
    """Create a minimal SQLite database at *path*, optionally with data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        for table in (tables or []):
            conn.execute(f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY)")
            for _ in range(rows):
                conn.execute(f"INSERT INTO {table} DEFAULT VALUES")


def _populated_db(path: Path) -> None:
    """Create a database that passes the _is_populated check (>= 1 run row)."""
    _make_db(path, tables=["runs", "projects", "datasets"], rows=5)


def _empty_schema_db(path: Path) -> None:
    """Create a schema-only database (tables exist but no rows)."""
    _make_db(path, tables=["runs", "projects", "datasets"], rows=0)


# ---------------------------------------------------------------------------
# Scenario 1: fresh installation — neither database file is present
# ---------------------------------------------------------------------------

def test_fresh_install_selects_canonical(tmp_path: Path) -> None:
    """New installation: no DB files → select neuravian.db (to be created later)."""
    result = select_database(tmp_path)
    assert result.path == tmp_path / _NEW_DB
    assert result.compatibility_mode is False
    assert "new installation" in result.reason.lower() or "neuravian.db" in result.reason
    # Must NOT have created any file during detection.
    assert not (tmp_path / _NEW_DB).exists()
    assert not (tmp_path / _LEGACY_DB).exists()


# ---------------------------------------------------------------------------
# Scenario 2: legacy NeuroForge upgrade — only neuroforge.db present
# ---------------------------------------------------------------------------

def test_legacy_only_selects_legacy(tmp_path: Path) -> None:
    """NeuroForge upgrade: only neuroforge.db exists → use it."""
    _populated_db(tmp_path / _LEGACY_DB)
    result = select_database(tmp_path)
    assert result.path == tmp_path / _LEGACY_DB
    assert result.compatibility_mode is True
    assert "neuroforge" in result.reason.lower()


# ---------------------------------------------------------------------------
# Scenario 3: only neuravian.db present (standard new install with data)
# ---------------------------------------------------------------------------

def test_canonical_only_selects_canonical(tmp_path: Path) -> None:
    """Standard path: only neuravian.db exists → use it."""
    _populated_db(tmp_path / _NEW_DB)
    result = select_database(tmp_path)
    assert result.path == tmp_path / _NEW_DB
    assert result.compatibility_mode is False


# ---------------------------------------------------------------------------
# Scenario 4: post-rename migration — both present, neuravian.db empty
# ---------------------------------------------------------------------------

def test_both_present_canonical_empty_selects_legacy(tmp_path: Path) -> None:
    """Post-rename migration: neuravian.db is schema-only, neuroforge.db has data."""
    _populated_db(tmp_path / _LEGACY_DB)
    _empty_schema_db(tmp_path / _NEW_DB)
    result = select_database(tmp_path)
    assert result.path == tmp_path / _LEGACY_DB
    assert result.compatibility_mode is True
    assert "historical" in result.reason.lower() or "neuroforge" in result.reason.lower()


def test_both_present_legacy_empty_selects_canonical(tmp_path: Path) -> None:
    """Both present but only neuravian.db has data → use it."""
    _empty_schema_db(tmp_path / _LEGACY_DB)
    _populated_db(tmp_path / _NEW_DB)
    result = select_database(tmp_path)
    assert result.path == tmp_path / _NEW_DB
    assert result.compatibility_mode is False


# ---------------------------------------------------------------------------
# Scenario 5: both databases populated — conflict
# ---------------------------------------------------------------------------

def test_both_populated_conflict_selects_legacy_with_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Conflict: both databases have data → deterministic tie-break selects legacy; emits WARNING."""
    _populated_db(tmp_path / _LEGACY_DB)
    _populated_db(tmp_path / _NEW_DB)

    import logging
    with caplog.at_level(logging.WARNING, logger="app.core.db_selector"):
        result = select_database(tmp_path)

    assert result.path == tmp_path / _LEGACY_DB
    assert result.compatibility_mode is True
    # A warning must have been emitted.
    warning_messages = [r.message for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("conflict" in m.lower() or "both" in m.lower() for m in warning_messages), (
        f"Expected a conflict warning; got: {warning_messages}"
    )


# ---------------------------------------------------------------------------
# Non-destruction guarantee
# ---------------------------------------------------------------------------

def test_select_database_does_not_modify_files(tmp_path: Path) -> None:
    """select_database must never delete, rename, or mutate any database file."""
    legacy = tmp_path / _LEGACY_DB
    canonical = tmp_path / _NEW_DB
    _populated_db(legacy)
    _empty_schema_db(canonical)

    legacy_mtime_before = legacy.stat().st_mtime
    canonical_size_before = canonical.stat().st_size

    select_database(tmp_path)

    assert legacy.exists(), "legacy database was deleted"
    assert canonical.exists(), "canonical database was deleted"
    assert legacy.stat().st_mtime == legacy_mtime_before, "legacy database was modified"
    assert canonical.stat().st_size == canonical_size_before, "canonical database was modified"


# ---------------------------------------------------------------------------
# resolve_database_url — environment integration
# ---------------------------------------------------------------------------

def test_resolve_database_url_sets_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """resolve_database_url should publish its decision to DATABASE_URL."""
    _populated_db(tmp_path / _LEGACY_DB)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    # Clear any explicit DATABASE_URL so the selector is not bypassed.
    monkeypatch.setenv("DATABASE_URL", "sqlite:////app/data/neuravian.db")

    from app.core.db_selector import resolve_database_url
    url = resolve_database_url()

    assert url == f"sqlite:///{tmp_path / _LEGACY_DB}"
    assert os.environ["DATABASE_URL"] == url


def test_resolve_database_url_honours_explicit_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An operator-set DATABASE_URL that is not a known default must be respected."""
    custom_url = f"sqlite:///{tmp_path}/custom.db"
    monkeypatch.setenv("DATABASE_URL", custom_url)
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    from app.core.db_selector import resolve_database_url
    url = resolve_database_url()
    assert url == custom_url
