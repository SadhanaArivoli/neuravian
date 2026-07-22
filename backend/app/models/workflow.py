from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class SavedWorkflow(Base):
    __tablename__ = "saved_workflows"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    dataset_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True)
    tags_json: Mapped[str | None] = mapped_column(Text)           # JSON array of strings
    state_json: Mapped[str] = mapped_column(Text, nullable=False)  # serialized WorkflowState
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False, default="neuravian-workflow-v1")
    is_template: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_favorite: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    template_source_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("saved_workflows.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))
