"""Add projects and project_notes tables.

Revision ID: 0011
Revises: 0010
Create Date: 2026-07-12
"""

import sqlalchemy as sa

from alembic import op

revision = "0011"
down_revision = "0010"
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
            f"Cannot repair project migration drift: {table} columns do not "
            f"match the known 0011 schema (found: {sorted(columns)})"
        )
    primary_key = set(
        inspector.get_pk_constraint(table).get("constrained_columns") or []
    )
    if primary_key != {"id"}:
        raise RuntimeError(
            f"Cannot repair project migration drift: {table}.id must be the primary key"
        )


def _validate_existing_project_tables(inspector: sa.Inspector) -> None:
    _validate_existing_table(
        inspector,
        "projects",
        {
            "id",
            "title",
            "description",
            "institution",
            "lab",
            "pi_name",
            "collaborators_json",
            "tags_json",
            "status",
            "created_at",
            "updated_at",
        },
    )
    _validate_existing_table(
        inspector,
        "project_notes",
        {"id", "project_id", "title", "content_md", "created_at", "updated_at"},
    )
    foreign_keys = inspector.get_foreign_keys("project_notes")
    if not any(
        fk.get("referred_table") == "projects"
        and fk.get("constrained_columns") == ["project_id"]
        and fk.get("referred_columns") == ["id"]
        for fk in foreign_keys
    ):
        raise RuntimeError(
            "Cannot repair project migration drift: project_notes.project_id "
            "must reference projects.id"
        )


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {
        table for table in ("projects", "project_notes") if inspector.has_table(table)
    }
    if existing:
        if existing != {"projects", "project_notes"}:
            raise RuntimeError(
                "Cannot repair project migration drift: projects and project_notes "
                "must either both exist or both be absent"
            )
        _validate_existing_project_tables(inspector)
        return

    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("institution", sa.String(256), nullable=True),
        sa.Column("lab", sa.String(256), nullable=True),
        sa.Column("pi_name", sa.String(256), nullable=True),
        sa.Column("collaborators_json", sa.Text(), nullable=True),
        sa.Column("tags_json", sa.Text(), nullable=True),
        sa.Column("status", sa.String(64), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "project_notes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("title", sa.String(512), nullable=False),
        sa.Column("content_md", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("project_notes")
    op.drop_table("projects")
