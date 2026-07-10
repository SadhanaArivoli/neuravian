"""Add remote_hosts table and remote_host_id on runs.

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "remote_hosts",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("display_name", sa.String(128), nullable=False),
        sa.Column("hostname", sa.String(253), nullable=False),
        sa.Column("ssh_port", sa.Integer, nullable=False, server_default="22"),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("key_path", sa.String(512), nullable=False),
        sa.Column("remote_work_root", sa.String(512), nullable=False),
        sa.Column("docker_host", sa.String(256), nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default="1"),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("updated_at", sa.DateTime, nullable=False),
    )

    # Track which host (if any) ran a given run
    op.add_column("runs", sa.Column("remote_host_id", sa.Integer, nullable=True))


def downgrade() -> None:
    op.drop_column("runs", "remote_host_id")
    op.drop_table("remote_hosts")
