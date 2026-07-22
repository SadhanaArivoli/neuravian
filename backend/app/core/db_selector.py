"""
Database compatibility selector for the NeuroForge → Neuravian migration.

On startup, inspects the data directory and applies deterministic rules to
select the correct SQLite database file.  No data is ever deleted, renamed,
or overwritten; this module is read-only with respect to database files.

Environment variable: DATA_DIR (default /app/data)
The selected database path is written to the DATABASE_URL environment variable
so that downstream code (Alembic, SQLAlchemy) picks it up automatically when
loaded after this module runs.
"""

from __future__ import annotations

import logging
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

# Canonical name for new Neuravian installations.
_NEW_DB = "neuravian.db"
# Legacy name from the NeuroForge era.
_LEGACY_DB = "neuroforge.db"

# A database is considered "populated" when it has at least this many rows
# in any of the key content tables.  This prevents treating a freshly
# migrated (schema-only) database as historical.
_POPULATED_TABLES = ("runs", "projects", "datasets")
_POPULATED_THRESHOLD = 1


@dataclass(frozen=True)
class DbSelection:
    path: Path
    reason: str
    compatibility_mode: bool
    """True when we fell back to the legacy NeuroForge database name."""


def _row_count(db_path: Path, table: str) -> int:
    """Return row count for *table* in *db_path*, or 0 on any error."""
    try:
        with sqlite3.connect(db_path) as conn:
            cur = conn.execute(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
            row = cur.fetchone()
            return row[0] if row else 0
    except Exception:
        return 0


def _is_populated(db_path: Path) -> bool:
    """Return True if the database contains meaningful user data."""
    for table in _POPULATED_TABLES:
        if _row_count(db_path, table) >= _POPULATED_THRESHOLD:
            return True
    return False


def select_database(data_dir: Path) -> DbSelection:
    """
    Apply the compatibility selection rules and return a DbSelection.

    Rules (evaluated in order):
    1. Only legacy exists            → use legacy (NeuroForge upgrade path).
    2. Only canonical exists         → use canonical.
    3. Neither exists                → canonical will be created on first use.
    4. Both exist, canonical empty   → use legacy (post-rename migration).
    5. Both exist, both populated    → use legacy; emit WARNING (no auto-merge).
    6. Both exist, legacy empty      → use canonical.
    """
    legacy = data_dir / _LEGACY_DB
    canonical = data_dir / _NEW_DB

    legacy_exists = legacy.exists()
    canonical_exists = canonical.exists()

    if legacy_exists and not canonical_exists:
        return DbSelection(
            path=legacy,
            reason="only neuroforge.db present — NeuroForge upgrade path",
            compatibility_mode=True,
        )

    if canonical_exists and not legacy_exists:
        return DbSelection(
            path=canonical,
            reason="only neuravian.db present — standard path",
            compatibility_mode=False,
        )

    if not legacy_exists and not canonical_exists:
        return DbSelection(
            path=canonical,
            reason="neither database exists — new installation; neuravian.db will be created",
            compatibility_mode=False,
        )

    # Both exist — inspect content.
    legacy_populated = _is_populated(legacy)
    canonical_populated = _is_populated(canonical)

    if legacy_populated and not canonical_populated:
        return DbSelection(
            path=legacy,
            reason=(
                "both databases present; neuravian.db is empty while neuroforge.db "
                "contains historical records — using neuroforge.db to preserve data"
            ),
            compatibility_mode=True,
        )

    if canonical_populated and not legacy_populated:
        return DbSelection(
            path=canonical,
            reason=(
                "both databases present; neuroforge.db is empty while neuravian.db "
                "contains records — using neuravian.db"
            ),
            compatibility_mode=False,
        )

    if legacy_populated and canonical_populated:
        # Deterministic tie-break: prefer the legacy database (older = more history).
        # Emit a prominent warning so an operator can investigate.
        log.warning(
            "DATABASE CONFLICT: both neuroforge.db and neuravian.db contain data. "
            "Automatic merging is not supported. Selecting neuroforge.db to preserve "
            "historical records. To resolve: manually consolidate the databases and "
            "remove neuroforge.db, or set DATABASE_URL explicitly in docker-compose.yml."
        )
        return DbSelection(
            path=legacy,
            reason=(
                "both databases populated — conflict; selected neuroforge.db "
                "(older history) per deterministic tie-break rule. Manual review required."
            ),
            compatibility_mode=True,
        )

    # Both exist, neither populated — prefer canonical (fresh state).
    return DbSelection(
        path=canonical,
        reason="both databases present but neither has data — using neuravian.db",
        compatibility_mode=False,
    )


def resolve_database_url() -> str:
    """
    Determine the correct SQLite database URL, log the decision, and return it.

    Reads DATA_DIR from the environment (default /app/data).
    If DATABASE_URL is already set to a non-default value, it is honoured
    verbatim so operators can always override via explicit configuration.
    """
    explicit_url = os.environ.get("DATABASE_URL", "")
    default_urls = {
        "sqlite:////app/data/neuravian.db",
        "sqlite:////app/data/neuroforge.db",
        # relative default from config.py
        "sqlite:///./neuravian.db",
    }
    if explicit_url and explicit_url not in default_urls:
        log.info("DATABASE_URL is explicitly set to %r — skipping compatibility selector", explicit_url)
        return explicit_url

    data_dir = Path(os.environ.get("DATA_DIR", "/app/data"))
    selection = select_database(data_dir)
    url = f"sqlite:///{selection.path}"

    log.info(
        "Database selector: selected %s | reason: %s | compatibility_mode: %s",
        selection.path,
        selection.reason,
        selection.compatibility_mode,
    )
    if selection.compatibility_mode:
        log.info(
            "Database compatibility mode is ACTIVE — running on legacy neuroforge.db. "
            "This is expected after a NeuroForge → Neuravian upgrade."
        )

    # Publish to the environment so Alembic and other subprocesses inherit it.
    os.environ["DATABASE_URL"] = url
    return url
