"""Add reports table.

Revision ID: 0009
Revises: 0008
"""

from alembic import op
import sqlalchemy as sa

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "reports",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("dataset_id", sa.Integer, sa.ForeignKey("datasets.id"), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="generating"),
        sa.Column("html_path", sa.String(1024), nullable=True),
        sa.Column("md_path", sa.String(1024), nullable=True),
        sa.Column("json_path", sa.String(1024), nullable=True),
        sa.Column("zip_path", sa.String(1024), nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("finished_at", sa.DateTime, nullable=True),
    )


def downgrade() -> None:
    op.drop_table("reports")
