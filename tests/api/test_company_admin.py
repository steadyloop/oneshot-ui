"""Administrator authorization and persistent company edit queue contracts."""

import base64
import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import httpx
from itsdangerous import TimestampSigner

from api.app import create_app
from api.config import Settings
from api.db import Db
from api.tracker.store import PostgresRepository

SECRET = "isolated-company-editor-test"


def cookie(account_id):
    data = base64.b64encode(json.dumps({"account_id": str(account_id)}).encode())
    return TimestampSigner(SECRET).sign(data).decode()


class AuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.account_id = uuid4()
        self.repo = SimpleNamespace(
            list_companies=AsyncMock(return_value={"companies": [], "total": 0}),
            update_company=AsyncMock(return_value={"id": 9, "name": "Updated"}),
        )
        self.repo.for_account = Mock(return_value=self.repo)
        self.auth = SimpleNamespace(account_profile=AsyncMock(return_value={
            "email": "msg.shkim@gmail.com", "name": "Admin", "picture_url": "",
        }))
        self.app = create_app(Settings(dsn="", session_secret=SECRET), repository=self.repo, auth_store=self.auth)
        self.app.state.repository = self.repo
        self.app.state.auth_store = self.auth
        self.pool = SimpleNamespace()
        self.app.state.db = Db(self.pool)
        self.addCleanup(patch.stopall)
        patch("api.companies.list_companies", self.repo.list_companies).start()
        patch("api.companies.update_company", self.repo.update_company).start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def assert_denied(self, expected):
        self.assertEqual((await self.client.get("/api/admin/companies")).status_code, expected)
        self.assertEqual((await self.client.patch("/api/admin/companies/9", json={"name": "Updated"})).status_code, expected)
        self.repo.list_companies.assert_not_awaited()
        self.repo.update_company.assert_not_awaited()

    async def test_guests_and_tampered_cookies_cannot_read_or_write(self):
        await self.assert_denied(401)
        self.client.cookies.set("oneshot_session", cookie(self.account_id) + "tampered")
        await self.assert_denied(401)
        self.auth.account_profile.assert_not_awaited()

    async def test_other_accounts_and_lookalike_addresses_are_denied(self):
        self.client.cookies.set("oneshot_session", cookie(self.account_id))
        for email in ("other@gmail.com", "msg.shkim@gmail.com.evil.example", "msg.shkim+admin@gmail.com"):
            self.auth.account_profile.return_value["email"] = email
            await self.assert_denied(403)
            self.assertFalse((await self.client.get("/api/auth/me")).json()["can_edit_companies"])

    async def test_allowed_account_can_list_and_patch_only_supported_fields(self):
        self.client.cookies.set("oneshot_session", cookie(self.account_id))
        self.auth.account_profile.return_value["email"] = "MSG.SHKIM@gmail.com"
        self.assertTrue((await self.client.get("/api/auth/me")).json()["can_edit_companies"])
        response = await self.client.get("/api/admin/companies", params={"q": "Acme", "limit": 25, "offset": 50})
        self.assertEqual(response.status_code, 200)
        self.repo.list_companies.assert_awaited_once_with(self.pool, q="Acme", limit=25, offset=50)
        response = await self.client.patch("/api/admin/companies/9", json={"name": " Updated ", "domain": "EXAMPLE.COM", "description": "", "tags": {"startup": True}})
        self.assertEqual(response.status_code, 200)
        self.repo.update_company.assert_awaited_once_with(self.pool, self.account_id, 9, {"name": "Updated", "domain": "example.com", "description": None, "tags": {"startup": True}})
        for body in ({}, {"id": 123}, {"name": " "}, {"name": None}, {"tags": []}, {"tags": None}, {"email": "msg.shkim@gmail.com"}):
            self.assertEqual((await self.client.patch("/api/admin/companies/9", json=body)).status_code, 422)
        self.assertEqual((await self.client.get("/api/admin/companies?limit=10000")).status_code, 422)

    async def test_deleted_accounts_are_treated_as_signed_out(self):
        self.client.cookies.set("oneshot_session", cookie(self.account_id))
        self.auth.account_profile.return_value = None
        await self.assert_denied(401)

    async def test_missing_company_and_duplicate_domain_have_useful_errors(self):
        self.client.cookies.set("oneshot_session", cookie(self.account_id))
        self.repo.update_company.return_value = None
        self.assertEqual((await self.client.patch("/api/admin/companies/9", json={"name": "Missing"})).status_code, 404)
        self.repo.update_company.side_effect = asyncpg.UniqueViolationError("duplicate")
        response = await self.client.patch("/api/admin/companies/9", json={"domain": "taken.com"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("already assigned", response.json()["detail"])


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_edits_merge_in_jobs_database_without_mutating_published_companies(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        schema = "company_editor_test_" + uuid4().hex
        setup = await asyncpg.connect(dsn)
        pool = None
        try:
            await setup.execute(f"CREATE SCHEMA {schema}; SET search_path TO {schema}")
            await setup.execute("CREATE TABLE company(id bigint PRIMARY KEY, name text NOT NULL, domain text UNIQUE, description text, tags jsonb NOT NULL DEFAULT '{}')")
            migration = (Path(__file__).resolve().parents[2] / "migrations/20261007_company_editor.sql").read_text()
            await setup.execute(migration)
            await setup.execute(migration)
            await setup.execute("INSERT INTO company(id,name,domain) VALUES(9,'Acme','acme.example'),(10,'Other','taken.example'),(11,'100% Co','percent.example')")
            pool = await asyncpg.create_pool(dsn, min_size=1, max_size=3, server_settings={"search_path": schema})
            repo = PostgresRepository("", pool=SimpleNamespace(), jobs_pool=pool).for_account(uuid4())
            self.assertEqual((await repo.list_companies(q="ACME"))["total"], 1)
            self.assertEqual((await repo.list_companies(q="%"))["total"], 1)
            self.assertEqual((await repo.list_companies(limit=1, offset=1))["companies"][0]["name"], "Acme")
            edited = await repo.update_company(9, {"name": "Edited", "tags": {"startup": True}})
            self.assertTrue(edited["sync_pending"])
            first_revision = await pool.fetchval("SELECT revision FROM company_edit WHERE company_id=9")
            edited = await repo.update_company(9, {"description": "New description", "domain": None})
            self.assertEqual(edited["name"], "Edited")
            self.assertEqual(edited["tags"], {"startup": True})
            self.assertIsNone(edited["domain"])
            self.assertNotEqual(first_revision, await pool.fetchval("SELECT revision FROM company_edit WHERE company_id=9"))
            self.assertEqual(await pool.fetchval("SELECT name FROM company WHERE id=9"), "Acme")
            self.assertEqual((await repo.list_companies(q="Edited"))["total"], 1)
            with self.assertRaises(asyncpg.UniqueViolationError):
                await repo.update_company(9, {"domain": "taken.example"})
            self.assertIsNone(await repo.update_company(999, {"name": "Missing"}))
        finally:
            if pool is not None:
                await pool.close()
            await setup.execute("SET search_path TO public")
            await setup.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            await setup.close()
