"""HTTP API and static client for the OneShot web app."""

import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .tracker.models import (
    ApplicationUpdate,
    ApplicationSubmit,
    ExternalApplicationCreate,
    JobFeedbackCommand,
)
from .auth import AuthStore, current_account, session_account
from .auth import router as auth_router
from .config import Settings, load_settings
from .db import Db
from .companies import router as company_admin_router
from .tracker.store import (
    DEFAULT_JOB_TYPES,
    LOCAL_ACCOUNT_ID,
    PostgresRepository,
    VALID_DEGREE_FIELDS,
    VALID_JOB_TYPES,
)
from .resume.routes import render_router, router as resume_router
from .resume.store import PostgresResumeStore


def _logo_media_type(payload: bytes) -> str:
    """Name the format the site served, since logos are stored verbatim.

    Sniffing beats a stored `mime` column here: every candidate format decodes
    in an `<img>` untouched, so the only thing a conversion step would buy is a
    resize, and the box is 40px either way.
    """
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        return "image/webp"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if payload.startswith(b"\x00\x00\x01\x00"):
        return "image/x-icon"
    return "image/svg+xml"


def create_app(
    settings: Settings | None = None,
    *,
    repository: Any | None = None,
    resume_store: Any | None = None,
    auth_store: Any | None = None,
) -> FastAPI:
    resolved = settings or load_settings()

    async def _open(component: Any) -> Any:
        connect = getattr(component, "connect", None)
        if callable(connect):
            await connect()
        return component

    async def _shut(component: Any) -> None:
        close = getattr(component, "close", None)
        if callable(close):
            await close()

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        store = await _open(repository or PostgresRepository(resolved.dsn, jobs_dsn=resolved.jobs_dsn or None))

        # Previously the resume store was constructed and never closed. That was
        # harmless for a SQLite file and a pool leak now that it holds one.
        # An injected repository means a test with no database, so a real store
        # is only built when nothing was injected at all.
        if resume_store is not None:
            resumes = await _open(resume_store)
        elif repository is None:
            # The resume workspace uses the same database and can share the
            # request pool. Opening a second pool doubled every cold start.
            resumes = await _open(
                PostgresResumeStore(resolved.dsn, pool=store._ready())
            )
        else:
            resumes = None

        # The account lookups run before an identity exists, so they cannot use
        # the per-account repository. They share its pool rather than opening a
        # second one; _owns_pool is False on that store, so close() is a no-op.
        # When a repository is injected the caller is a test with no database,
        # so an AuthStore is only built when one was injected explicitly.
        if auth_store is not None:
            auth = auth_store
        elif repository is None:
            auth = AuthStore(resolved.dsn, pool=store._ready())
        else:
            auth = None

        application.state.repository = store
        application.state.db = Db(store._ready(), store._jobs_ready())
        application.state.auth_store = auth
        application.state.resume_store = resumes
        try:
            yield
        finally:
            await _shut(store)
            await _shut(resumes)

    application = FastAPI(
        title="OneShot",
        version="0.2.0",
        lifespan=lifespan,
    )
    application.state.settings = resolved

    # The session is a signed cookie, so signing in stores no server-side row.
    # An unset secret falls back to a per-process random one: the app still runs
    # for local development and tests, and a restart simply signs everyone out —
    # which is the safe failure. A hardcoded default would be a published key.
    application.add_middleware(
        SessionMiddleware,
        secret_key=resolved.session_secret or secrets.token_urlsafe(32),
        session_cookie="oneshot_session",
        max_age=14 * 24 * 3600,
        same_site="lax",  # withholds the cookie from cross-site POST/PATCH/DELETE
        https_only=resolved.cookie_secure,
    )

    # Client and API share one origin, so CORS middleware is unnecessary.

    def public_store(request: Request) -> Any:
        """Scope public job reads without granting anonymous write access.

        Signed-in readers still hide their own tracked postings. Signed-out
        readers use an inert sentinel-scoped repository with account filtering
        disabled; private application and resume routes never use it.
        """
        account_id = current_account(request) or LOCAL_ACCOUNT_ID
        return request.app.state.repository.for_account(account_id)

    def account_store(
        request: Request,
        account_id: UUID = Depends(session_account),
    ) -> Any:
        """The private repository, scoped to a required signed-in account."""
        return request.app.state.repository.for_account(account_id)

    @application.get("/api/health")
    async def health() -> dict[str, bool]:
        # Public on purpose: the client calls this before anything else to tell
        # "server is down" from "you are signed out".
        return {"ok": True}

    @application.get("/api/jobs")
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
        store: Any = Depends(public_store),
    ) -> dict[str, Any]:
        unknown = [value for value in job_type if value not in VALID_JOB_TYPES]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown job_type: {unknown[0]}",
            )
        unknown_degree = [value for value in degree_field if value not in VALID_DEGREE_FIELDS]
        if unknown_degree:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown degree_field: {unknown_degree[0]}",
            )
        # No filter does not mean "everything": it means the classified default
        # scope. The unclassified pool is opt-in via an explicit parameter.
        return await store.list_jobs(
            job_types=job_type or list(DEFAULT_JOB_TYPES),
            degree_fields=degree_field,
            q=q,
            season=season,
            sort=sort,
            limit=limit,
            offset=offset,
            exclude_job_ids=exclude_job_id,
            # Guest tracking is browser-local, so the historical sentinel must
            # not hide jobs another anonymous visitor once added to it.
            hide_tracked=current_account(request) is not None,
        )

    @application.get("/api/companies/{company_id}/logo")
    async def company_logo(
        company_id: int, store: Any = Depends(public_store)
    ) -> Response:
        payload = await store.company_logo(company_id)
        if not payload:
            raise HTTPException(status_code=404, detail="No logo for that company")
        return Response(
            content=payload,
            media_type=_logo_media_type(payload),
            # A list page asks for ~30 of these at once and the bytes only move
            # when a company rebrands, so revalidating per view is pure cost.
            headers={"Cache-Control": "public, max-age=604800"},
        )

    @application.get("/api/source-coverage")
    async def source_coverage(store: Any = Depends(public_store)) -> dict[str, Any]:
        # Account-independent: source_coverage() never references account_id.
        return await store.source_coverage()

    @application.get("/api/source-coverage/boards")
    async def source_coverage_boards(store: Any = Depends(public_store)) -> dict[str, Any]:
        # Account-independent: board_map() never references account_id.
        return await store.board_map()

    @application.post("/api/jobs/{job_id}/applications")
    async def create_application_record(
        job_id: int,
        command: ApplicationSubmit = ApplicationSubmit(),
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        try:
            result = await store.create_application(job_id, submitted_at=command.submitted_at)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if result is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return result

    @application.put("/api/jobs/{job_id}/feedback")
    async def set_job_feedback(
        job_id: int,
        command: JobFeedbackCommand,
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        # PUT, not POST: the row is the posting's hidden state for this
        # account, so re-sending it (a skip gaining its reason) is a replace.
        result = await store.set_feedback(
            job_id,
            kind=command.kind,
            skip_reason=command.skip_reason,
            corrections=[
                correction.model_dump(by_alias=True)
                for correction in command.corrections
            ],
        )
        if result is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return result

    @application.delete("/api/jobs/{job_id}/feedback", status_code=204)
    async def delete_job_feedback(
        job_id: int,
        store: Any = Depends(account_store),
    ) -> Response:
        if not await store.delete_feedback(job_id):
            raise HTTPException(status_code=404, detail="Posting is not hidden")
        return Response(status_code=204)

    @application.get("/api/feedback")
    async def job_feedback(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        return await store.list_feedback(limit=limit, offset=offset)

    @application.post("/api/applications/external")
    async def create_external_application_record(
        command: ExternalApplicationCreate,
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        try:
            return await store.create_external_application(
                company=command.company,
                title=command.title,
                url=command.url,
                location=command.location,
                note=command.note,
                submitted_at=command.submitted_at,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @application.get("/api/applications")
    async def applications(store: Any = Depends(account_store)) -> dict[str, Any]:
        return await store.list_applications()

    @application.get("/api/applications/{application_id}")
    async def application_detail(
        application_id: int,
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        result = await store.get_application(application_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Application not found")
        return result

    @application.patch("/api/applications/{application_id}")
    async def update_application(
        application_id: int,
        command: ApplicationUpdate,
        store: Any = Depends(account_store),
    ) -> dict[str, Any]:
        try:
            result = await store.update_application(
                application_id,
                command.model_dump(exclude_unset=True),
            )
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if result is None:
            raise HTTPException(status_code=404, detail="Application not found")
        return result

    @application.delete("/api/applications/{application_id}", status_code=204)
    async def delete_application(
        application_id: int,
        store: Any = Depends(account_store),
    ) -> Response:
        if not await store.delete_application(application_id):
            raise HTTPException(status_code=404, detail="Application not found")
        return Response(status_code=204)

    application.include_router(auth_router)
    application.include_router(company_admin_router)
    # Rendering is public: a signed-out resume lives in the browser and is sent
    # in the request. Included first so its fixed /render/* paths are matched
    # before the gated router's parameterized ones.
    application.include_router(render_router)
    # The resume router carries its own required-account dependency.
    application.include_router(resume_router)

    # Serve the browser client (web/) when it is present; without it this is a pure JSON API.
    web = Path(resolved.static_dir)
    if web.is_dir():
        for url, folder in PAGES.items():
            application.add_api_route(url, _page(web / folder / "index.html"), include_in_schema=False)
        application.mount("/static", _Revalidated(directory=web), name="static")
    return application


class _Revalidated(StaticFiles):
    """Assets carry no version tags, so browsers revalidate them on each load."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Page URL -> folder in web/. Assets are referenced by absolute /static/ paths.
PAGES = {
    "/": "discover",
    "/application/": "applied",
    "/resume/": "resume",
    "/source-coverage/": "feeds",
    "/login/": "login",
}


def _page(file: Path):
    async def serve() -> FileResponse:
        return FileResponse(file, headers={"Cache-Control": "no-cache"})
    return serve


app = create_app()
