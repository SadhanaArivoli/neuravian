from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(Integer, ForeignKey("datasets.id"), nullable=False)
    pipeline_id: Mapped[int] = mapped_column(Integer, ForeignKey("pipelines.id"), nullable=False)
    pipeline_version: Mapped[str] = mapped_column(String(32), nullable=False)
    container_digest: Mapped[str | None] = mapped_column(String(128))
    params_json: Mapped[str | None] = mapped_column(Text)  # JSON blob of user params
    status: Mapped[str] = mapped_column(String(32), default="pending")
    command_preview: Mapped[str | None] = mapped_column(Text)
    output_dir: Mapped[str | None] = mapped_column(String(1024))
    error_message: Mapped[str | None] = mapped_column(Text)
    progress_json: Mapped[str | None] = mapped_column(Text)  # JSON ProgressUpdate
    # Workflow lineage — set when this run was launched from a Run Next recommendation
    source_run_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("runs.id"), nullable=True)
    source_artifacts_json: Mapped[str | None] = mapped_column(Text)  # JSON lineage blob
    # Remote execution — null means local Docker/native
    remote_host_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Cancel signal: set to True to request graceful stop of running/queued run
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    logs: Mapped[list["RunLog"]] = relationship("RunLog", back_populates="run")
    provenance_events: Mapped[list["ProvenanceEvent"]] = relationship(
        "ProvenanceEvent", back_populates="run"
    )


class RunLog(Base):
    __tablename__ = "run_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, ForeignKey("runs.id"), nullable=False)
    log_file_path: Mapped[str | None] = mapped_column(String(1024))
    error_signatures_detected: Mapped[str | None] = mapped_column(Text)  # JSON array

    run: Mapped["Run"] = relationship("Run", back_populates="logs")


class ProvenanceEvent(Base):
    __tablename__ = "provenance_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(Integer, ForeignKey("runs.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[str | None] = mapped_column(Text)  # JSON blob
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))

    run: Mapped["Run"] = relationship("Run", back_populates="provenance_events")
