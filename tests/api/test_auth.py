"""Google sign-in accepts verified accounts and rejects invalid callbacks."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

from starlette.requests import Request

from api.auth import SESSION_ACCOUNT_KEY, SESSION_STATE_KEY
from api.auth import callback, me
from api.config import Settings


class SignInTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.account_id = uuid4()
        self.store = SimpleNamespace(
            find_or_create_account=AsyncMock(return_value=self.account_id)
        )
        self.request = Request({
            "type": "http",
            "session": {SESSION_STATE_KEY: "valid-state"},
            "app": SimpleNamespace(state=SimpleNamespace(
                settings=Settings(dsn=""), auth_store=self.store,
            )),
        })
        self.profile = {
            "sub": "google-account", "email": "New.User@gmail.com",
            "email_verified": True, "name": "New User",
        }

    async def sign_in(self, *, state="valid-state"):
        with (
            patch("api.auth.exchange_code", new=AsyncMock(return_value="token")),
            patch("api.auth.fetch_userinfo", new=AsyncMock(return_value=self.profile)),
        ):
            return await callback(self.request, code="code", state=state)

    async def test_new_verified_google_account_can_sign_in(self):
        response = await self.sign_in()
        self.assertEqual(response.headers["location"], "/")
        self.assertEqual(self.request.session[SESSION_ACCOUNT_KEY], str(self.account_id))
        self.store.find_or_create_account.assert_awaited_once_with(
            google_sub="google-account", email="new.user@gmail.com",
            name="New User", picture_url="",
        )

    async def test_incomplete_or_unverified_identity_is_rejected(self):
        for field, value in (("sub", ""), ("email", ""), ("email_verified", False)):
            with self.subTest(field=field):
                original = self.profile[field]
                self.profile[field] = value
                self.request.session[SESSION_STATE_KEY] = "valid-state"
                response = await self.sign_in()
                self.assertEqual(response.headers["location"], "/login/?error=unverified")
                self.assertNotIn(SESSION_ACCOUNT_KEY, self.request.session)
                self.profile[field] = original
        self.store.find_or_create_account.assert_not_awaited()

    async def test_invalid_oauth_state_is_rejected(self):
        response = await self.sign_in(state="wrong-state")
        self.assertEqual(response.headers["location"], "/login/?error=bad_state")
        self.assertNotIn(SESSION_ACCOUNT_KEY, self.request.session)
        self.store.find_or_create_account.assert_not_awaited()


class DiscoverDefaultTests(unittest.IsolatedAsyncioTestCase):
    async def test_defaults_are_scoped_to_account_id(self):
        for account_id, expected in (
            (UUID("6596ed23-6f1f-4c74-9072-48cb7fe198be"),
             ["med_device", "biotech", "clinical_affairs"]),
            (UUID("82d7f821-369e-45c1-9bb8-7e5a28d16eea"),
             ["finance", "software"]),
            (uuid4(), []),
        ):
            with self.subTest(account_id=account_id):
                # Matching email on another account must not receive the defaults.
                profile = {"email": "kaitlynituralde@gmail.com", "name": "Kaitlyn"}
                store = SimpleNamespace(account_profile=AsyncMock(return_value=profile))
                request = Request({
                    "type": "http",
                    "session": {SESSION_ACCOUNT_KEY: str(account_id)},
                    "app": SimpleNamespace(state=SimpleNamespace(auth_store=store)),
                })
                result = await me(request)
                self.assertEqual(result["id"], str(account_id))
                self.assertEqual(result["discover_default_fields"], expected)
