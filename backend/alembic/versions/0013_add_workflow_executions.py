"""Add persisted mixed-location workflow executions and transfers."""

import sqlalchemy as sa

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def _validate_existing_table(
    inspector: sa.Inspector,
    table: str,
    expected_columns: set[str],
) -> None:
    columns = {column["name"] for column in inspector.get_columns(table)}
    if columns != expected_columns:
        raise RuntimeError(
            f"Cannot repair workflow migration drift: {table} columns do not "
            f"match the known 0013 schema (found: {sorted(columns)})"
        )
    primary_key = set(
        inspector.get_pk_constraint(table).get("constrained_columns") or []
    )
    if primary_key != {"id"}:
        raise RuntimeError(
            "Cannot repair workflow migration drift: "
            f"{table}.id must be the primary key"
        )


def _validate_existing_workflow_tables(inspector: sa.Inspector) -> None:
    _validate_existing_table(
        inspector,
        "workflow_executions",
        {
            "id",
            "execution_uuid",
            "workflow_id",
            "idempotency_key",
            "status",
            "current_node_id",
            "remote_profile_id",
            "state_json",
            "revision",
            "return_sync_complete",
            "created_at",
            "updated_at",
        },
    )
    _validate_existing_table(
        inspector,
        "workflow_transfers",
        {
            "id",
            "execution_id",
            "artifact_key",
            "relative_path",
            "sha256",
            "size_bytes",
            "bytes_received",
            "status",
            "local_path",
            "updated_at",
        },
    )
    execution_indexes = {
        index["name"]: index for index in inspector.get_indexes("workflow_executions")
    }
    if (
        not execution_indexes.get("ix_workflow_executions_execution_uuid", {}).get(
            "unique"
        )
        or "ix_workflow_executions_workflow_id" not in execution_indexes
    ):
        raise RuntimeError(
            "Cannot repair workflow migration drift: workflow execution indexes "
            "do not match the known 0013 schema"
        )
    transfer_indexes = {
        index["name"] for index in inspector.get_indexes("workflow_transfers")
    }
    if "ix_workflow_transfers_execution_id" not in transfer_indexes:
        raise RuntimeError(
            "Cannot repair workflow migration drift: workflow transfer index is missing"
        )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    table_names = ("workflow_executions", "workflow_transfers")
    existing = {table for table in table_names if inspector.has_table(table)}
    if existing:
        if existing != set(table_names):
            raise RuntimeError(
                "Cannot repair workflow migration drift: workflow execution and "
                "transfer tables must either both exist or both be absent"
            )
        _validate_existing_workflow_tables(inspector)
        return

    op.create_table(
        "workflow_executions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("execution_uuid", sa.String(36), nullable=False),
        sa.Column(
            "workflow_id",
            sa.Integer(),
            sa.ForeignKey("saved_workflows.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("current_node_id", sa.String(256)),
        sa.Column("remote_profile_id", sa.String(128)),
        sa.Column("state_json", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "return_sync_complete",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "workflow_id", "idempotency_key", name="uq_workflow_execution_request"
        ),
    )
    op.create_index(
        "ix_workflow_executions_execution_uuid",
        "workflow_executions",
        ["execution_uuid"],
        unique=True,
    )
    op.create_index(
        "ix_workflow_executions_workflow_id", "workflow_executions", ["workflow_id"]
    )
    op.create_table(
        "workflow_transfers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "execution_id",
            sa.Integer(),
            sa.ForeignKey("workflow_executions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("artifact_key", sa.String(256), nullable=False),
        sa.Column("relative_path", sa.String(512), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("bytes_received", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("local_path", sa.Text()),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint(
            "execution_id", "artifact_key", name="uq_workflow_transfer_artifact"
        ),
    )
    op.create_index(
        "ix_workflow_transfers_execution_id", "workflow_transfers", ["execution_id"]
    )


def downgrade() -> None:
    op.drop_table("workflow_transfers")
    op.drop_table("workflow_executions")
