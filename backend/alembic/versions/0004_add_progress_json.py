"""Add progress_json column to runs table.

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-06
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("progress_json", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "progress_json")
