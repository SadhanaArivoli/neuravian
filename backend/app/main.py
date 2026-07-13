from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.datasets import router as datasets_router
from app.api.health import router as health_router
from app.api.plugins import router as plugins_router
from app.api.projects import router as projects_router
from app.api.pipelines import router as pipelines_router
from app.api.remote_hosts import router as remote_hosts_router
from app.api.reports import router as reports_router
from app.api.runs import router as runs_router
from app.api.wizard import router as wizard_router
from app.api.workflows import router as workflows_router
from app.core.config import settings
from app.core.database import SessionLocal


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.plugin_loader import load_all_plugins
    from app.services.run import recover_interrupted_runs, seed_pipeline_registry
    from app.services.execution_queue import start_processor
    # Plugins must be discovered before the pipeline registry is built
    # so plugin pipelines and artifact types are merged in.
    load_all_plugins()
    with SessionLocal() as db:
        seed_pipeline_registry(db)
        await recover_interrupted_runs(db)
    start_processor()
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router, prefix="/api")
app.include_router(datasets_router, prefix="/api")
app.include_router(pipelines_router, prefix="/api")
app.include_router(plugins_router, prefix="/api")
app.include_router(remote_hosts_router, prefix="/api")
app.include_router(reports_router, prefix="/api")
app.include_router(runs_router, prefix="/api")
app.include_router(wizard_router, prefix="/api")
app.include_router(workflows_router, prefix="/api")
app.include_router(projects_router, prefix="/api")
