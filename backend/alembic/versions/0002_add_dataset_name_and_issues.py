"""add dataset name and validation_issues columns

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-30

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("datasets", sa.Column("name", sa.String(256), nullable=True))
    op.add_column("datasets", sa.Column("validation_issues", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("datasets", "validation_issues")
    op.drop_column("datasets", "name")
