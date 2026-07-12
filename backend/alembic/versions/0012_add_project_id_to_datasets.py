"""Add project_id FK to datasets table.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-12
"""

from alembic import op
import sqlalchemy as sa

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "datasets",
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True),
    )


def downgrade() -> None:
    op.drop_column("datasets", "project_id")
