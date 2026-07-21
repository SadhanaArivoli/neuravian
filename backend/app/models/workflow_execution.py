from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class WorkflowExecution(Base):
    __tablename__ = "workflow_executions"
    __table_args__ = (UniqueConstraint("workflow_id", "idempotency_key", name="uq_workflow_execution_request"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    execution_uuid: Mapped[str] = mapped_column(String(36), unique=True, nullable=False, index=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("saved_workflows.id", ondelete="CASCADE"), nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="planned")
    current_node_id: Mapped[str | None] = mapped_column(String(256))
    remote_profile_id: Mapped[str | None] = mapped_column(String(128))
    state_json: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    return_sync_complete: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))


class WorkflowTransfer(Base):
    __tablename__ = "workflow_transfers"
    __table_args__ = (UniqueConstraint("execution_id", "artifact_key", name="uq_workflow_transfer_artifact"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    execution_id: Mapped[int] = mapped_column(ForeignKey("workflow_executions.id", ondelete="CASCADE"), nullable=False, index=True)
    artifact_key: Mapped[str] = mapped_column(String(256), nullable=False)
    relative_path: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    bytes_received: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    local_path: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))
