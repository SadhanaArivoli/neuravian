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
    # SQLite doesn't support ADD COLUMN with FK constraints via ALTER TABLE.
    # Use batch mode (copy-and-move) to add project_id without a formal FK constraint.
    # The application-level model enforces the relationship.
    with op.batch_alter_table("datasets") as batch_op:
        batch_op.add_column(
            sa.Column("project_id", sa.Integer(), nullable=True)
        )
        batch_op.create_index("ix_datasets_project_id", ["project_id"])


def downgrade() -> None:
    with op.batch_alter_table("datasets") as batch_op:
        batch_op.drop_index("ix_datasets_project_id")
        batch_op.drop_column("project_id")
