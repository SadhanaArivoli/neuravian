"""Add workflow lineage columns to runs table.

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-09
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # source_run_id: optional reference to the upstream run (SQLite doesn't enforce
    # FK constraints from ALTER TABLE, so we add the column without a constraint;
    # the ORM-level ForeignKey still provides relationship traversal in Python)
    op.add_column("runs", sa.Column("source_run_id", sa.Integer, nullable=True))
    # source_artifacts_json: JSON blob, schema-ready for future multiple inputs
    # Current shape: single object with upstream_run_id, upstream_pipeline_id,
    # upstream_pipeline_display_name, artifact_type, artifact_label,
    # injected_param, injected_path
    op.add_column("runs", sa.Column("source_artifacts_json", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "source_artifacts_json")
    op.drop_column("runs", "source_run_id")
