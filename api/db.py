"""Connection pools, and the small helpers every query module shares."""

import json
from dataclasses import dataclass
from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import Request


class Db:
    """The accounts database, and the jobs database when JOBS_DATABASE_URL splits it off."""

    def __init__(self, pool: Any, jobs: Any = None) -> None:
        self.pool = pool
        self.jobs = pool if jobs is None else jobs


async def connect(dsn: str, jobs_dsn: str = "") -> Db:
    if not dsn:
        raise RuntimeError("No PostgreSQL DSN. Set DATABASE_URL.")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=8)
    if not jobs_dsn or jobs_dsn == dsn:
        return Db(pool)
    try:
        return Db(pool, await asyncpg.create_pool(jobs_dsn, min_size=1, max_size=8))
    except BaseException:
        await pool.close()
        raise


async def close(db: Db) -> None:
    if db.jobs is not db.pool:
        await db.jobs.close()
    await db.pool.close()


def pools(request: Request) -> Db:
    return request.app.state.db


@dataclass(frozen=True)
class Scoped:
    """Queries that only ever read or write one account's rows."""

    pool: Any
    account_id: UUID


def iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, date) else value


def json_as(value: Any, kind: type) -> Any:
    """A jsonb value (asyncpg returns it as text) decoded as `kind`, else an empty `kind`."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return kind()
    return value if isinstance(value, kind) else kind()


def ilike(text: str) -> str:
    """An ILIKE pattern matching `text` literally: %, _ and the backslash escape are escaped."""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
