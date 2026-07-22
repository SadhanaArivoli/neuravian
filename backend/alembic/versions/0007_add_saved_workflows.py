"""Add saved_workflows table.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_workflows",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("dataset_id", sa.Integer, sa.ForeignKey("datasets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("tags_json", sa.Text, nullable=True),
        sa.Column("state_json", sa.Text, nullable=False),
        sa.Column("schema_version", sa.String(32), nullable=False, server_default="neuravian-workflow-v1"),
        sa.Column("is_template", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("is_favorite", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("is_archived", sa.Boolean, nullable=False, server_default="0"),
        sa.Column("template_source_id", sa.Integer, sa.ForeignKey("saved_workflows.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("saved_workflows")
