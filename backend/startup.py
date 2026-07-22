"""
Container startup script.

Runs the database compatibility selector, then hands off to Alembic migrations
and the application server.  Must be executed as the container entrypoint so
that DATABASE_URL is resolved before any other Python module imports it.

Usage (from Dockerfile CMD):
    python startup.py
"""

import logging
import os
import subprocess
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("neuravian.startup")


def main() -> None:
    # Must import after basicConfig so the module logger inherits the handler.
    from app.core.db_selector import resolve_database_url

    db_url = resolve_database_url()
    log.info("Resolved DATABASE_URL: %s", db_url)

    # Run Alembic migrations.
    log.info("Running database migrations...")
    result = subprocess.run(
        ["alembic", "upgrade", "head"],
        env=os.environ.copy(),
    )
    if result.returncode != 0:
        log.error("Alembic migration failed with exit code %d", result.returncode)
        sys.exit(result.returncode)
    log.info("Migrations complete.")

    # Start the application server (replaces this process).
    log.info("Starting uvicorn...")
    os.execvpe(
        "uvicorn",
        ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"],
        os.environ,
    )


if __name__ == "__main__":
    main()
