from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(primary_key=True)
    dataset_id: Mapped[int] = mapped_column(Integer, ForeignKey("datasets.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="generating")
    # Relative paths inside the report directory (data/reports/{id}/)
    html_path: Mapped[str | None] = mapped_column(String(1024))
    md_path: Mapped[str | None] = mapped_column(String(1024))
    json_path: Mapped[str | None] = mapped_column(String(1024))
    zip_path: Mapped[str | None] = mapped_column(String(1024))
    pdf_path: Mapped[str | None] = mapped_column(String(1024))
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
