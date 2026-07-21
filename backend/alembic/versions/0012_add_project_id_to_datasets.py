"""Add project_id FK to datasets table.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-12
"""

import sqlalchemy as sa

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("datasets")}
    if "project_id" in columns:
        indexes = {index["name"] for index in inspector.get_indexes("datasets")}
        if "ix_datasets_project_id" not in indexes:
            raise RuntimeError(
                "Cannot repair dataset migration drift: datasets.project_id exists "
                "without ix_datasets_project_id"
            )
        return

    # SQLite doesn't support ADD COLUMN with FK constraints via ALTER TABLE.
    # Use batch mode (copy-and-move) to add project_id without a formal FK constraint.
    # The application-level model enforces the relationship.
    with op.batch_alter_table("datasets") as batch_op:
        batch_op.add_column(sa.Column("project_id", sa.Integer(), nullable=True))
        batch_op.create_index("ix_datasets_project_id", ["project_id"])


def downgrade() -> None:
    with op.batch_alter_table("datasets") as batch_op:
        batch_op.drop_index("ix_datasets_project_id")
        batch_op.drop_column("project_id")
