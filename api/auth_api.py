"""Sign-in routes.

Any Google account with a verified email address can sign in. Failed
authentication redirects to the login page with a reason.
"""

from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, Response

from .auth import (
    SESSION_ACCOUNT_KEY,
    SESSION_STATE_KEY,
    OAuthError,
    authorization_url,
    exchange_code,
    fetch_userinfo,
    require_account,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _settings(request: Request) -> Any:
    return request.app.state.settings


def _auth_store(request: Request) -> Any:
    return request.app.state.auth_store


@router.get("/login")
async def login(request: Request) -> RedirectResponse:
    settings = _settings(request)
    if not settings.google_client_id or not settings.google_client_secret:
        # Say so plainly. The alternative is redirecting to a Google page that
        # errors with no indication the fault is on this side.
        raise HTTPException(
            status_code=503,
            detail=(
                "Google sign-in is not configured. Set "
                "ONESHOT_GOOGLE_CLIENT_ID and "
                "ONESHOT_GOOGLE_CLIENT_SECRET."
            ),
        )
    # CSRF defence for the callback: a state we minted, round-tripped through
    # Google, and compared on return.
    state = secrets.token_urlsafe(32)
    request.session[SESSION_STATE_KEY] = state
    return RedirectResponse(
        authorization_url(
            client_id=settings.google_client_id,
            public_url=settings.public_url,
            state=state,
        ),
        status_code=307,
    )


@router.get("/callback")
async def callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
) -> RedirectResponse:
    settings = _settings(request)
    expected = request.session.pop(SESSION_STATE_KEY, None)

    if error:
        # The user pressed Cancel on Google's consent screen.
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

    # Two conditions, not one. An unverified address is an unproven claim, and
    # anyone can put any address on an unverified account.
    if not google_sub or not email or not userinfo.get("email_verified"):
        return RedirectResponse("/login/?error=unverified", status_code=303)

    account_id = await _auth_store(request).find_or_create_account(
        google_sub=google_sub,
        email=email,
        name=userinfo.get("name") or email,
        picture_url=userinfo.get("picture") or "",
    )
    request.session[SESSION_ACCOUNT_KEY] = str(account_id)
    return RedirectResponse("/", status_code=303)


@router.post("/logout", status_code=204)
async def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=204)


@router.get("/me")
async def me(request: Request) -> dict[str, Any]:
    account_id = require_account(request)
    profile = await _auth_store(request).account_profile(account_id)
    if profile is None:
        # The account was deleted while the cookie was still valid.
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not signed in")
    return profile
