"""Empty copies of the current local schema, used only in isolated database tests."""

SERVING_TABLES = (
    "account", "company", "company_logo", "company_edit", "job_posting",
    "job_posting_dup_group", "coverage_snapshot", "job_application",
    "job_application_event", "job_feedback", "resume_workspace", "resume_target",
    "resume_document",
)


def _identifier(value):
    return '"' + value.replace('"', '""') + '"'


async def clone_tables(connection, *tables):
    """Copy structure without FKs to real records or defaults using real sequences.

    Callers select a temporary schema first and roll it back or drop it afterward.
    LIKE preserves columns, checks and indexes but omits foreign keys; account
    scoping and split-database validation are exercised through the real API.
    """
    schema = await connection.fetchval("SELECT current_schema()")
    if schema == "public":
        raise ValueError("Database fixtures require an isolated schema")
    for table in tables:
        target = f"{_identifier(schema)}.{_identifier(table)}"
        await connection.execute(f"CREATE TABLE {target} (LIKE public.{_identifier(table)} INCLUDING ALL)")
        columns = await connection.fetch(
            "SELECT column_name, column_default FROM information_schema.columns "
            "WHERE table_schema=$1 AND table_name=$2 AND is_identity='NO'",
            schema, table,
        )
        # Identity columns already receive their own sequence; serial defaults do not.
        for column in columns:
            if not (column["column_default"] or "").startswith("nextval("):
                continue
            sequence = f"{_identifier(schema)}.{_identifier(table + '_' + column['column_name'] + '_fixture_seq')}"
            await connection.execute(f"CREATE SEQUENCE {sequence}")
            literal = sequence.replace("'", "''")
            await connection.execute(
                f"ALTER TABLE {target} ALTER COLUMN {_identifier(column['column_name'])} "
                f"SET DEFAULT nextval('{literal}'::regclass)"
            )
