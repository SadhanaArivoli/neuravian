"""Top-level pytest configuration for backend tests.

Ensures the SQLite database used by the FastAPI lifespan (SessionLocal)
has all ORM tables created before any test runs. The lifespan calls
seed_pipeline_registry(db) via SessionLocal() directly — it bypasses
the get_db override used by individual test fixtures — so the tables
must exist in the shared engine before the lifespan fires.
"""
import pytest

# Import every ORM model to register its table with Base.metadata.
# Order matters for foreign-key references.
from app.models.project import Project, ProjectNote  # noqa: F401
from app.models.dataset import Dataset  # noqa: F401
from app.models.pipeline import Pipeline  # noqa: F401
from app.models.run import Run, RunLog, ProvenanceEvent  # noqa: F401
from app.models.report import Report  # noqa: F401
from app.models.workflow import SavedWorkflow  # noqa: F401
from app.models.workflow_execution import WorkflowExecution, WorkflowTransfer  # noqa: F401

try:
    from app.models.remote_host import RemoteHost  # noqa: F401
except ImportError:
    pass

from app.core.database import Base, engine


def pytest_configure(config: pytest.Config) -> None:
    """Create all ORM tables in the shared engine before test collection."""
    Base.metadata.create_all(engine)
