"""Administrator edits to the published company table, queued for xjobscore to apply."""

import asyncio
import json
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from .auth import require_company_editor
from .company_profile import company_website
from .db import ilike, json_as, pools
from .errors import found

router = APIRouter(prefix="/api/admin/companies", tags=["company administration"])

# The editor shows pending edits; Discover keeps the published row until
# xjobscore applies the queue before its next snapshot.
EFFECTIVE = """
    SELECT c.id,
        CASE WHEN e.changes ? 'name' THEN e.changes->>'name' ELSE c.name END AS name,
        CASE WHEN e.changes ? 'domain' THEN e.changes->>'domain' ELSE c.domain END AS domain,
        CASE WHEN e.changes ? 'description' THEN e.changes->>'description' ELSE c.description END AS description,
        CASE WHEN e.changes ? 'tags' THEN e.changes->'tags' ELSE c.tags END AS tags,
        (e.company_id IS NOT NULL) AS sync_pending, e.sync_error
    FROM company c LEFT JOIN company_edit e ON e.company_id = c.id
"""


class CompanyUpdate(BaseModel):
    model_config = {"extra": "forbid", "str_strip_whitespace": True}

    name: str | None = Field(default=None, min_length=1, max_length=500)
    domain: str | None = Field(default=None, max_length=253)
    description: str | None = Field(default=None, max_length=8000)
    tags: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_update(self) -> "CompanyUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one company field is required")
        for field in ("name", "tags"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        if self.domain is not None:
            self.domain = self.domain.lower() or None
        if self.description == "":
            self.description = None
        return self


def _company(row: Any) -> dict[str, Any]:
    tags = json_as(row["tags"], dict)
    return {**dict(row), "tags": tags, "website": company_website(row["domain"], tags)}


async def list_companies(pool: Any, *, q: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    q = q.strip()
    source = f"({EFFECTIVE}) AS effective WHERE ($1 = '' OR name ILIKE $2 OR domain ILIKE $2 OR tags->'company_resolution'->>'website' ILIKE $2 OR id::text = $1)"
    total, rows = await asyncio.gather(
        pool.fetchval(f"SELECT count(*) FROM {source}", q, ilike(q)),
        pool.fetch(f"SELECT * FROM {source} ORDER BY lower(name), id LIMIT $3 OFFSET $4", q, ilike(q), limit, offset),
    )
    return {"companies": [_company(row) for row in rows], "total": int(total)}


async def update_company(pool: Any, account_id: UUID, company_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
    async with pool.acquire() as connection, connection.transaction():
        if changes.get("domain") and await connection.fetchval(
            f"SELECT EXISTS (SELECT 1 FROM ({EFFECTIVE}) effective WHERE id <> $1 AND lower(domain) = lower($2))",
            company_id, changes["domain"],
        ):
            raise HTTPException(status_code=409, detail="That domain is already assigned to another company")
        queued = await connection.fetchval(
            """
            INSERT INTO company_edit(company_id, changes, edited_by, revision)
            SELECT id, $2::jsonb, $3, $4 FROM company WHERE id = $1
            ON CONFLICT (company_id) DO UPDATE
            SET changes = company_edit.changes || EXCLUDED.changes,
                edited_by = EXCLUDED.edited_by, revision = EXCLUDED.revision,
                updated_at = clock_timestamp(), sync_error = NULL
            RETURNING company_id
            """,
            company_id, json.dumps(changes), account_id, uuid4(),
        )
        if queued is None:
            return None
        return _company(await connection.fetchrow(EFFECTIVE + " WHERE c.id = $1", company_id))


@router.get("")
async def companies(
    request: Request,
    q: str = Query(default="", max_length=500),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    _: UUID = Depends(require_company_editor),
) -> dict[str, Any]:
    return await list_companies(pools(request).jobs, q=q, limit=limit, offset=offset)


@router.patch("/{company_id}")
async def update(
    request: Request,
    company_id: int,
    command: CompanyUpdate,
    account_id: UUID = Depends(require_company_editor),
) -> dict[str, Any]:
    changes = command.model_dump(exclude_unset=True)
    try:
        return found(await update_company(pools(request).jobs, account_id, company_id, changes), "Company not found")
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="That domain is already assigned to another company") from exc
