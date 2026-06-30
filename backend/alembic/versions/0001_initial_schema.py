"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-06-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "datasets",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("path", sa.String(1024), nullable=False, unique=True),
        sa.Column("bids_version", sa.String(32), nullable=True),
        sa.Column("validation_status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("indexed_metadata", sa.Text, nullable=True),
        sa.Column("dataset_hash", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "pipelines",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("version", sa.String(32), nullable=False),
        sa.Column("manifest_path", sa.String(1024), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "runs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("dataset_id", sa.Integer, sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column("pipeline_id", sa.Integer, sa.ForeignKey("pipelines.id"), nullable=False),
        sa.Column("pipeline_version", sa.String(32), nullable=False),
        sa.Column("container_digest", sa.String(128), nullable=True),
        sa.Column("params_json", sa.Text, nullable=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("started_at", sa.DateTime, nullable=True),
        sa.Column("finished_at", sa.DateTime, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "run_logs",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("run_id", sa.Integer, sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("log_file_path", sa.String(1024), nullable=True),
        sa.Column("error_signatures_detected", sa.Text, nullable=True),
    )

    op.create_table(
        "provenance_events",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("run_id", sa.Integer, sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("payload_json", sa.Text, nullable=True),
        sa.Column("timestamp", sa.DateTime, nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("provenance_events")
    op.drop_table("run_logs")
    op.drop_table("runs")
    op.drop_table("pipelines")
    op.drop_table("datasets")
