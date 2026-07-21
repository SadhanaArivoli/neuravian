"""Release-gate coverage for clean, normal, and drifted Alembic upgrades."""

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine

import app.models.dataset  # noqa: F401
import app.models.pipeline  # noqa: F401
import app.models.project  # noqa: F401
import app.models.report  # noqa: F401
import app.models.run  # noqa: F401
import app.models.workflow  # noqa: F401
from app.core.database import Base

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _alembic(
    database: Path, revision: str = "head", *, succeeds: bool = True
) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["DATABASE_URL"] = f"sqlite:///{database}"
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision],
        cwd=BACKEND_ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if succeeds and result.returncode != 0:
        pytest.fail(f"Alembic upgrade failed:\n{result.stdout}\n{result.stderr}")
    return result


def _revision(database: Path) -> str:
    with sqlite3.connect(database) as connection:
        row = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        return row[0]


def _columns(database: Path, table: str) -> set[str]:
    with sqlite3.connect(database) as connection:
        return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def _create_drifted_reports(database: Path, *, malformed: bool = False) -> None:
    with sqlite3.connect(database) as connection:
        if malformed:
            connection.execute(
                "CREATE TABLE reports (id INTEGER PRIMARY KEY, unexpected TEXT)"
            )
            return
    Base.metadata.create_all(create_engine(f"sqlite:///{database}"))
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            INSERT INTO datasets
                (id, path, name, validation_status)
            VALUES
                (9001, '/qualification', 'migration qualification', 'valid');
            INSERT INTO reports
                (id, dataset_id, status, html_path, created_at)
            VALUES
                (9002, 9001, 'complete', 'preserve-me.html',
                 '2026-07-20 00:00:00');
            """
        )


def test_clean_database_from_0001_upgrades_to_head(tmp_path: Path) -> None:
    database = tmp_path / "clean-0001.db"
    _alembic(database, "0001")
    _alembic(database)
    assert _revision(database) == "0013"


def test_normal_0008_database_upgrades_to_head(tmp_path: Path) -> None:
    database = tmp_path / "normal-0008.db"
    _alembic(database, "0008")
    _alembic(database)
    assert _revision(database) == "0013"
    assert "pdf_path" in _columns(database, "reports")


def test_drifted_0008_database_is_repaired_without_data_loss(tmp_path: Path) -> None:
    database = tmp_path / "drifted-0008.db"
    _alembic(database, "0008")
    _create_drifted_reports(database)

    _alembic(database)

    assert _revision(database) == "0013"
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT id, dataset_id, html_path FROM reports WHERE id = 9002"
        ).fetchone()
    assert row == (9002, 9001, "preserve-me.html")


def test_current_database_upgrade_is_a_no_op(tmp_path: Path) -> None:
    database = tmp_path / "current.db"
    _alembic(database)
    _alembic(database)
    assert _revision(database) == "0013"


def test_repeated_upgrade_invocation_is_idempotent(tmp_path: Path) -> None:
    database = tmp_path / "repeated.db"
    _alembic(database, "0008")
    _create_drifted_reports(database)
    _alembic(database)
    _alembic(database)
    assert _revision(database) == "0013"


def test_unknown_reports_schema_fails_safely(tmp_path: Path) -> None:
    database = tmp_path / "unknown-drift.db"
    _alembic(database, "0008")
    _create_drifted_reports(database, malformed=True)

    result = _alembic(database, succeeds=False)

    assert result.returncode != 0
    assert "Cannot repair reports migration drift" in result.stderr
    assert _revision(database) == "0008"
