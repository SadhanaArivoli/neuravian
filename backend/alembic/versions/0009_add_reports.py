"""Add reports table.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_BASE_COLUMNS = {
    "id",
    "dataset_id",
    "status",
    "html_path",
    "md_path",
    "json_path",
    "zip_path",
    "error_message",
    "created_at",
    "finished_at",
}


def _validate_existing_reports_table(inspector: sa.Inspector) -> None:
    """Accept only the schemas produced by revisions 0009 or 0010.

    An older application startup path called ``Base.metadata.create_all`` and
    could create the current reports table while Alembic was still stamped at
    0008. Preserve that data, but refuse to guess when the existing table has
    any other shape.
    """
    columns = {column["name"]: column for column in inspector.get_columns("reports")}
    names = set(columns)
    if names not in (_BASE_COLUMNS, _BASE_COLUMNS | {"pdf_path"}):
        raise RuntimeError(
            "Cannot repair reports migration drift: existing columns do not "
            f"match the known 0009/0010 schema (found: {sorted(names)})"
        )

    required_not_null = {"id", "dataset_id", "status", "created_at"}
    if any(columns[name]["nullable"] for name in required_not_null):
        raise RuntimeError(
            "Cannot repair reports migration drift: required reports columns "
            "must be NOT NULL"
        )

    primary_key = set(
        inspector.get_pk_constraint("reports").get("constrained_columns") or []
    )
    if primary_key != {"id"}:
        raise RuntimeError(
            "Cannot repair reports migration drift: reports.id must be the primary key"
        )

    foreign_keys = inspector.get_foreign_keys("reports")
    has_dataset_fk = any(
        fk.get("referred_table") == "datasets"
        and fk.get("constrained_columns") == ["dataset_id"]
        and fk.get("referred_columns") == ["id"]
        for fk in foreign_keys
    )
    if not has_dataset_fk:
        raise RuntimeError(
            "Cannot repair reports migration drift: reports.dataset_id must "
            "reference datasets.id"
        )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("reports"):
        _validate_existing_reports_table(inspector)
        return

    op.create_table(
        "reports",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "dataset_id", sa.Integer, sa.ForeignKey("datasets.id"), nullable=False
        ),
        sa.Column("status", sa.String(32), nullable=False, server_default="generating"),
        sa.Column("html_path", sa.String(1024), nullable=True),
        sa.Column("md_path", sa.String(1024), nullable=True),
        sa.Column("json_path", sa.String(1024), nullable=True),
        sa.Column("zip_path", sa.String(1024), nullable=True),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.Column("finished_at", sa.DateTime, nullable=True),
    )


def downgrade() -> None:
    op.drop_table("reports")
