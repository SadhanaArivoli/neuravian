from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str | None] = mapped_column(String(256))
    path: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)
    bids_version: Mapped[str | None] = mapped_column(String(32))
    validation_status: Mapped[str] = mapped_column(String(32), default="pending")
    validation_issues: Mapped[str | None] = mapped_column(Text)  # JSON blob
    indexed_metadata: Mapped[str | None] = mapped_column(Text)  # JSON blob
    dataset_hash: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC)
    )
