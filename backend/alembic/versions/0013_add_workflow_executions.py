"""Add persisted mixed-location workflow executions and transfers."""

from alembic import op
import sqlalchemy as sa

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workflow_executions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("execution_uuid", sa.String(36), nullable=False),
        sa.Column("workflow_id", sa.Integer(), sa.ForeignKey("saved_workflows.id", ondelete="CASCADE"), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("current_node_id", sa.String(256)),
        sa.Column("remote_profile_id", sa.String(128)),
        sa.Column("state_json", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("return_sync_complete", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("workflow_id", "idempotency_key", name="uq_workflow_execution_request"),
    )
    op.create_index("ix_workflow_executions_execution_uuid", "workflow_executions", ["execution_uuid"], unique=True)
    op.create_index("ix_workflow_executions_workflow_id", "workflow_executions", ["workflow_id"])
    op.create_table(
        "workflow_transfers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("execution_id", sa.Integer(), sa.ForeignKey("workflow_executions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("artifact_key", sa.String(256), nullable=False),
        sa.Column("relative_path", sa.String(512), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("bytes_received", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("local_path", sa.Text()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("execution_id", "artifact_key", name="uq_workflow_transfer_artifact"),
    )
    op.create_index("ix_workflow_transfers_execution_id", "workflow_transfers", ["execution_id"])


def downgrade() -> None:
    op.drop_table("workflow_transfers")
    op.drop_table("workflow_executions")
