"""Public reads: the Discover feed, company logos and the feeds overview."""

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response

from ..auth import current_account
from ..db import pools
from . import feeds
from .listing import DEFAULT_JOB_TYPES, VALID_DEGREE_FIELDS, VALID_JOB_TYPES, list_jobs

router = APIRouter(prefix="/api")

# Logos are stored as the site served them; every format here renders in an <img>.
_LOGO_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x00\x00\x01\x00", "image/x-icon"),
)


def _logo_type(payload: bytes) -> str:
    if payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        return "image/webp"
    return next((kind for magic, kind in _LOGO_SIGNATURES if payload.startswith(magic)), "image/svg+xml")


@router.get("/jobs")
async def jobs(
    request: Request,
    job_type: list[str] = Query(default=[]),
    degree_field: list[str] = Query(default=[]),
    q: str = "",
    season: str = "",
    sort: str = "fresh",
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    exclude_job_id: list[int] = Query(default=[]),
) -> dict[str, Any]:
    for name, values, valid in (("job_type", job_type, VALID_JOB_TYPES), ("degree_field", degree_field, VALID_DEGREE_FIELDS)):
        unknown = [value for value in values if value not in valid]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown {name}: {unknown[0]}")
    # Signed out, tracking lives in the browser, which sends its own exclude_job_id.
    return await list_jobs(
        pools(request),
        current_account(request),
        # No type filter means the classified default, not everything.
        job_types=job_type or DEFAULT_JOB_TYPES,
        degree_fields=degree_field,
        q=q,
        season=season,
        sort=sort,
        limit=limit,
        offset=offset,
        exclude_job_ids=exclude_job_id,
    )


@router.get("/companies/{company_id}/logo")
async def company_logo(request: Request, company_id: int) -> Response:
    payload = await pools(request).jobs.fetchval("SELECT bytes FROM company_logo WHERE company_id = $1", company_id)
    if not payload:
        raise HTTPException(status_code=404, detail="No logo for that company")
    # A page asks for ~30 at once, and a logo only changes when a company rebrands.
    return Response(content=payload, media_type=_logo_type(payload), headers={"Cache-Control": "public, max-age=604800"})


@router.get("/source-coverage")
async def source_coverage(request: Request) -> dict[str, Any]:
    return await feeds.source_coverage(pools(request).jobs)


@router.get("/source-coverage/boards")
async def source_coverage_boards(request: Request) -> dict[str, Any]:
    return await feeds.board_map(pools(request).jobs)
