"""Google sign-in: the OIDC exchange, the account store, and the session gate.

The authorization-code flow is hand-rolled over ``httpx`` rather than pulled from
an OAuth library. The step libraries earn their keep on — verifying an
``id_token`` signature against Google's JWKS — is not required here: the token
arrives over a direct server-to-server TLS POST to Google's token endpoint, never
through the browser, so it is trusted by transport (OIDC Core 3.1.3.7). Reading
the profile from the userinfo endpoint avoids JWT parsing altogether.

Identity lives in ``account``: ``google_sub`` is the stable key (it survives an
email change), and ``email`` records the verified address from Google.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode
from uuid import UUID, uuid4

import asyncpg
import httpx
from fastapi import HTTPException, Request

AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

SESSION_ACCOUNT_KEY = "account_id"
SESSION_STATE_KEY = "oauth_state"
COMPANY_EDITOR_EMAIL = "msg.shkim@gmail.com"

_TIMEOUT = httpx.Timeout(10.0)


class OAuthError(Exception):
    """Google refused the exchange, or returned something unusable."""


def redirect_uri(public_url: str) -> str:
    return f"{public_url.rstrip('/')}/api/auth/callback"


def authorization_url(*, client_id: str, public_url: str, state: str) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri(public_url),
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            # Without these two Google returns no refresh token and skips the
            # account chooser, which makes signing in as a second account
            # impossible to demonstrate without clearing cookies.
            "access_type": "online",
            "prompt": "select_account",
        }
    )
    return f"{AUTHORIZE_ENDPOINT}?{query}"


async def exchange_code(
    code: str,
    *,
    client_id: str,
    client_secret: str,
    public_url: str,
) -> str:
    """Trade the one-time code for an access token. Returns the access token."""
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri(public_url),
                "grant_type": "authorization_code",
            },
        )
    if response.status_code != 200:
        # Google puts the useful part in the body; the status alone is not enough
        # to tell redirect_uri_mismatch from an expired code.
        raise OAuthError(f"token exchange failed ({response.status_code}): {response.text}")
    token = response.json().get("access_token")
    if not token:
        raise OAuthError("token response carried no access_token")
    return token


async def fetch_userinfo(access_token: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.get(
            USERINFO_ENDPOINT,
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if response.status_code != 200:
        raise OAuthError(f"userinfo failed ({response.status_code})")
    return response.json()


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
    """The signed-in account, or None. Never raises — use for optional reads."""
    raw = request.session.get(SESSION_ACCOUNT_KEY)
    if not raw:
        return None
    try:
        return UUID(raw)
    except (ValueError, AttributeError, TypeError):
        # A tampered or stale cookie is treated as signed-out, not as an error.
        return None


def require_account(request: Request) -> UUID:
    """The signed-in account, or 401 for private workspace API routes."""
    account_id = current_account(request)
    if account_id is None:
        raise HTTPException(status_code=401, detail="Not signed in")
    return account_id


def can_edit_companies(profile: dict[str, Any] | None) -> bool:
    """Only the account's stored, Google-verified address grants access."""
    return bool(profile and str(profile.get("email") or "").strip().lower() == COMPANY_EDITOR_EMAIL)


async def require_company_editor(request: Request) -> UUID:
    account_id = require_account(request)
    profile = await request.app.state.auth_store.account_profile(account_id)
    if profile is None:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not signed in")
    if not can_edit_companies(profile):
        raise HTTPException(status_code=403, detail="Company editing is restricted to the administrator")
    return account_id


def session_account(request: Request) -> UUID:
    """FastAPI dependency for private workspace data.

    Signed-out application and resume workspaces live in the browser. The API
    therefore requires a real account for every persisted workspace request;
    falling back to the historical sentinel would make anonymous visitors share
    one writable database row.
    """
    return require_account(request)
