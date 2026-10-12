"""Google sign-in, accounts, and the session gate.

The OIDC code flow is hand-rolled over httpx: the access token comes from a direct
server-to-server TLS call to Google, so it is trusted by transport (OIDC Core
3.1.3.7), and the profile is read from userinfo instead of a verified id_token.
Accounts are keyed by Google's stable `sub`, not by email.
"""

import secrets
from typing import Annotated, Any
from urllib.parse import urlencode
from uuid import UUID, uuid4

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, Response

from .db import pools

AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

SESSION_ACCOUNT_KEY = "account_id"
SESSION_STATE_KEY = "oauth_state"

_TIMEOUT = httpx.Timeout(10.0)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class OAuthError(Exception):
    """Google refused the exchange, or returned something unusable."""


def _redirect_uri(public_url: str) -> str:
    return f"{public_url.rstrip('/')}/api/auth/callback"


async def exchange_code(code: str, *, client_id: str, client_secret: str, public_url: str) -> str:
    """Trade the one-time code for an access token."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(TOKEN_ENDPOINT, data={
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": _redirect_uri(public_url),
            "grant_type": "authorization_code",
        })
    if response.status_code != 200:
        # The body tells redirect_uri_mismatch apart from an expired code.
        raise OAuthError(f"token exchange failed ({response.status_code}): {response.text}")
    token = response.json().get("access_token")
    if not token:
        raise OAuthError("token response carried no access_token")
    return token


async def fetch_userinfo(access_token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {access_token}"})
    if response.status_code != 200:
        raise OAuthError(f"userinfo failed ({response.status_code})")
    return response.json()


async def find_or_create_account(pool: Any, *, google_sub: str, email: str, name: str, picture_url: str) -> UUID:
    """Upsert on `sub`, refreshing the profile on every sign-in; returns the account id."""
    return await pool.fetchval(
        """
        INSERT INTO account (id, email, google_sub, name, picture_url)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (google_sub) DO UPDATE
        SET email = EXCLUDED.email, name = EXCLUDED.name, picture_url = EXCLUDED.picture_url
        RETURNING id
        """,
        uuid4(), email, google_sub, name, picture_url,
    )


async def account_profile(pool: Any, account_id: UUID) -> dict[str, Any] | None:
    row = await pool.fetchrow("SELECT email, name, picture_url FROM account WHERE id = $1", account_id)
    return None if row is None else dict(row)


class AuthStore:
    """Account lookups that run *before* an identity exists.

    Deliberately separate from ``PostgresRepository``, which is scoped to one
    account: these queries are how that account is discovered in the first place.
    """

    def __init__(self, dsn: str, *, pool: asyncpg.Pool | None = None) -> None:
        self.dsn = dsn
        self.pool = pool
        self._owns_pool = pool is None

    async def connect(self) -> None:
        if self.pool is not None:
            return
        if not self.dsn:
            raise RuntimeError(
                "No PostgreSQL DSN. Set DATABASE_URL."
            )
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)

    async def close(self) -> None:
        if self.pool is not None and self._owns_pool:
            await self.pool.close()
            self.pool = None

    def _ready(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("AuthStore.connect() has not been called")
        return self.pool

    async def find_or_create_account(
        self,
        *,
        google_sub: str,
        email: str,
        name: str,
        picture_url: str,
    ) -> UUID:
        """Upsert on ``google_sub`` and return the account id.

        The id is minted here rather than taken from Google: a ``sub`` is a
        numeric string and ``account.id`` is a uuid. Refreshing name and picture
        on every sign-in keeps the sidebar current for free.
        """
        row = await self._ready().fetchrow(
            """
            INSERT INTO account (id, email, google_sub, name, picture_url)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (google_sub) DO UPDATE
            SET email       = EXCLUDED.email,
                name        = EXCLUDED.name,
                picture_url = EXCLUDED.picture_url
            RETURNING id
            """,
            uuid4(),
            email,
            google_sub,
            name,
            picture_url,
        )
        return row["id"]

    async def account_profile(self, account_id: UUID) -> dict[str, Any] | None:
        row = await self._ready().fetchrow(
            "SELECT email, name, picture_url FROM account WHERE id = $1",
            account_id,
        )
        if row is None:
            return None
        return {
            "email": row["email"],
            "name": row["name"],
            "picture_url": row["picture_url"],
        }


def current_account(request: Request) -> UUID | None:
    """The signed-in account, or None; a tampered or stale cookie reads as signed out."""
    raw = request.session.get(SESSION_ACCOUNT_KEY)
    if not raw:
        return None
    try:
        return UUID(raw)
    except (ValueError, AttributeError, TypeError):
        return None


def require_account(request: Request) -> UUID:
    """The signed-in account, or 401. Signed-out workspaces live in the browser."""
    account_id = current_account(request)
    if account_id is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return account_id


Account = Annotated[UUID, Depends(require_account)]


async def _signed_in_profile(request: Request) -> tuple[UUID, dict[str, Any]]:
    account_id = require_account(request)
    store = getattr(request.app.state, "auth_store", None)
    profile = await store.account_profile(account_id) if store is not None else await account_profile(pools(request).pool, account_id)
    if profile is None:  # deleted while its cookie was still valid
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not signed in")
    return account_id, profile


def can_edit_companies(profile: dict[str, Any], editor_email: str) -> bool:
    """Only the account's stored, Google-verified address grants access."""
    allowed = editor_email.strip().lower()
    return bool(allowed) and str(profile.get("email") or "").strip().lower() == allowed


async def require_company_editor(request: Request) -> UUID:
    account_id, profile = await _signed_in_profile(request)
    if not can_edit_companies(profile, request.app.state.settings.company_editor_email):
        raise HTTPException(status_code=403, detail="Company editing is restricted to the administrator")
    return account_id


@router.get("/login")
async def login(request: Request) -> RedirectResponse:
    settings = request.app.state.settings
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(status_code=503, detail=(
            "Google sign-in is not configured. Set ONESHOT_GOOGLE_CLIENT_ID and ONESHOT_GOOGLE_CLIENT_SECRET."
        ))
    # CSRF defence: a state minted here, round-tripped through Google, compared on return.
    state = secrets.token_urlsafe(32)
    request.session[SESSION_STATE_KEY] = state
    query = urlencode({
        "client_id": settings.google_client_id,
        "redirect_uri": _redirect_uri(settings.public_url),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",  # lets a second account sign in without clearing cookies
    })
    return RedirectResponse(f"{AUTHORIZE_ENDPOINT}?{query}", status_code=307)


@router.get("/callback")
async def callback(request: Request, code: str = "", state: str = "", error: str = "") -> RedirectResponse:
    settings = request.app.state.settings
    expected = request.session.pop(SESSION_STATE_KEY, None)
    if error:  # Cancel on Google's consent screen
        return RedirectResponse("/login/?error=cancelled", status_code=303)
    if not code or not state or not expected or not secrets.compare_digest(state, expected):
        return RedirectResponse("/login/?error=bad_state", status_code=303)
    try:
        access_token = await exchange_code(
            code,
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            public_url=settings.public_url,
        )
        userinfo = await fetch_userinfo(access_token)
    except OAuthError:
        return RedirectResponse("/login/?error=exchange_failed", status_code=303)

    email = (userinfo.get("email") or "").lower()
    google_sub = userinfo.get("sub") or ""
    # Anyone can put any address on an unverified account.
    if not google_sub or not email or not userinfo.get("email_verified"):
        return RedirectResponse("/login/?error=unverified", status_code=303)
    store = getattr(request.app.state, "auth_store", None)
    identity = dict(
        google_sub=google_sub,
        email=email,
        name=userinfo.get("name") or email,
        picture_url=userinfo.get("picture") or "",
    )
    if store is not None:
        account_id = await store.find_or_create_account(**identity)
    else:
        account_id = await find_or_create_account(pools(request).pool, **identity)
    request.session[SESSION_ACCOUNT_KEY] = str(account_id)
    return RedirectResponse("/", status_code=303)


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=204)


@router.get("/me")
async def me(request: Request) -> dict[str, Any]:
    account_id, profile = await _signed_in_profile(request)
    return {
        **profile,
        "id": str(account_id),
        "can_edit_companies": can_edit_companies(profile, request.app.state.settings.company_editor_email),
        "discover_default_fields": [],
    }


# Existing dependency overrides continue to refer to the same session gate.
session_account = require_account
