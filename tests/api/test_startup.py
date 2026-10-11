"""Exercise startup and HTTP routing without a database connection."""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx

from api.app import create_app
from api.config import Settings
from api.tracker.store import PostgresRepository


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_serves_pages_and_keeps_private_routes_gated(self):
        pool = SimpleNamespace(fetchrow=AsyncMock(return_value=None))
        app = create_app(Settings(dsn=""), repository=PostgresRepository("", pool=pool))
        async with app.router.lifespan_context(app):
            self.assertIs(app.state.db.pool, pool)
            self.assertIs(app.state.db.jobs, pool)
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                self.assertEqual((await client.get("/api/health")).json(), {"ok": True})
                for path in ("/", "/application/", "/resume/", "/source-coverage/", "/login/"):
                    with self.subTest(path=path):
                        response = await client.get(path)
                        self.assertEqual(response.status_code, 200)
                        self.assertIn("text/html", response.headers["content-type"])
                for path in ("/api/applications", "/api/resume/resumes", "/api/admin/companies", "/api/auth/me"):
                    with self.subTest(path=path):
                        self.assertEqual((await client.get(path)).status_code, 401)
        pool.fetchrow.assert_not_awaited()
