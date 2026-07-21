"""Add pdf_path column to reports table.

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-11
"""

import sqlalchemy as sa

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("reports")
    }
    if "pdf_path" in columns:
        return
    op.add_column("reports", sa.Column("pdf_path", sa.String(1024), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "pdf_path")
