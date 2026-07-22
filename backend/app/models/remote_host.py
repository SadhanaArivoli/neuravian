from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RemoteHost(Base):
    __tablename__ = "remote_hosts"

    id: Mapped[int] = mapped_column(primary_key=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    hostname: Mapped[str] = mapped_column(String(253), nullable=False)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22, nullable=False)
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    # Path to the SSH private key file accessible to the backend process.
    # We store the path only — the key content is never written to the database.
    key_path: Mapped[str] = mapped_column(String(512), nullable=False)
    # Base directory on the remote host where Neuravian will stage run inputs/outputs.
    remote_work_root: Mapped[str] = mapped_column(String(512), nullable=False)
    # Optional Docker socket override (e.g. "unix:///var/run/docker.sock").
    # When null, Docker uses its default socket on the remote.
    docker_host: Mapped[str | None] = mapped_column(String(256))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(UTC))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
