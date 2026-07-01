"""add run execution columns

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-30
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("runs", sa.Column("command_preview", sa.Text, nullable=True))
    op.add_column("runs", sa.Column("output_dir", sa.String(1024), nullable=True))
    op.add_column("runs", sa.Column("error_message", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "error_message")
    op.drop_column("runs", "output_dir")
    op.drop_column("runs", "command_preview")
