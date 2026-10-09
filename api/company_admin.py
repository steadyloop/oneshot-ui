"""Account-gated maintenance of the published company table."""

from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, model_validator

from .auth import require_company_editor

router = APIRouter(prefix="/api/admin/companies", tags=["company administration"])


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


def company_store(
    request: Request,
    account_id: UUID = Depends(require_company_editor),
) -> Any:
    return request.app.state.repository.for_account(account_id)


@router.get("")
async def companies(
    q: str = Query(default="", max_length=500),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    store: Any = Depends(company_store),
) -> dict[str, Any]:
    return await store.list_companies(q=q, limit=limit, offset=offset)


@router.patch("/{company_id}")
async def update_company(
    company_id: int,
    command: CompanyUpdate,
    store: Any = Depends(company_store),
) -> dict[str, Any]:
    try:
        result = await store.update_company(company_id, command.model_dump(exclude_unset=True))
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(status_code=409, detail="That domain is already assigned to another company") from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Company not found")
    return result
