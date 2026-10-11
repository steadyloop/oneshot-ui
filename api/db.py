"""Connection pools, and the small helpers every query module shares."""

import json
from typing import Any

from fastapi import Request


class Db:
    """The accounts database, and the jobs database when JOBS_DATABASE_URL splits it off."""

    def __init__(self, pool: Any, jobs: Any = None) -> None:
        self.pool = pool
        self.jobs = pool if jobs is None else jobs


def pools(request: Request) -> Db:
    return request.app.state.db


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
