from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.datasets import router as datasets_router
from app.api.health import router as health_router
from app.api.pipelines import router as pipelines_router
from app.api.runs import router as runs_router
from app.api.wizard import router as wizard_router
from app.core.config import settings
from app.core.database import SessionLocal


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.run import recover_interrupted_runs, seed_pipeline_registry
    with SessionLocal() as db:
        seed_pipeline_registry(db)
        await recover_interrupted_runs(db)
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
app.include_router(runs_router, prefix="/api")
app.include_router(wizard_router, prefix="/api")
