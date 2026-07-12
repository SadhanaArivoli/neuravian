"""Add pdf_path column to reports table.

Revision ID: 0010
Revises: 0009
Create Date: 2026-07-11
"""

from alembic import op
import sqlalchemy as sa

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("pdf_path", sa.String(1024), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "pdf_path")
