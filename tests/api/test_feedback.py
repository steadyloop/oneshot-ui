"""Skip, Hidden and Restore work when postings exist only in the jobs database."""

import os
from pathlib import Path
import unittest
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import httpx

from api.app import create_app
from api.auth import session_account
from api.config import Settings
from api.tracker.store import PostgresRepository


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class FeedbackDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_split_database_skip_reason_hidden_restore_and_account_scoping(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        root = Path(__file__).resolve().parents[2]
        schema_root = Path(os.environ.get("XJOBSCORE_SCHEMA_ROOT", root.parent / "xjobscore"))
        if not (schema_root / "frontend.sql").is_file():
            self.skipTest("xjobscore/frontend.sql checkout required")
        setup = await asyncpg.connect(dsn)
        schemas = ["feedback_jobs_" + uuid4().hex, "feedback_accounts_" + uuid4().hex]
        pools = []
        try:
            for schema in schemas:
                await setup.execute(f"CREATE SCHEMA {schema}; SET search_path TO {schema}")
                await setup.execute((schema_root / "frontend.sql").read_text())
                pools.append(await asyncpg.create_pool(dsn, min_size=1, max_size=4, server_settings={"search_path": schema}))
            jobs, personal = pools
            await jobs.execute("""
                INSERT INTO company(id,name) OVERRIDING SYSTEM VALUE VALUES(9,'Acme');
                INSERT INTO job_posting(id,source,source_key,company_id,title,content_hash,job_type)
                VALUES(79,'test','79',9,'Jobs-only intern','hash','intern');
            """)
            migration = (root / "migrations/20261009_feedback_split_database.sql").read_text()
            await personal.execute(migration)
            await personal.execute(migration)
            self.assertEqual(await personal.fetchval("SELECT count(*) FROM job_posting"), 0)
            account, other_account = uuid4(), uuid4()
            await personal.execute("INSERT INTO account(id) VALUES($1),($2)", account, other_account)
            repo = PostgresRepository("", account_id=account, pool=personal, jobs_pool=jobs)
            app = create_app(Settings(dsn=""), repository=repo)
            app.state.repository = repo
            app.dependency_overrides[session_account] = lambda: account
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.put("/api/jobs/79/feedback", json={"kind": "skip"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["job_id"], 79)
                self.assertEqual((await repo.list_jobs())["total"], 0)
                response = await client.put("/api/jobs/79/feedback", json={"kind": "skip", "skip_reason": "location"})
                self.assertEqual(response.status_code, 200)
                hidden = (await client.get("/api/feedback")).json()
                self.assertEqual(hidden["total"], 1)
                self.assertEqual(hidden["hidden"][0]["skip_reason"], "location")
                self.assertEqual(hidden["hidden"][0]["job"]["title"], "Jobs-only intern")
                other = repo.for_account(other_account)
                self.assertEqual((await other.list_feedback())["total"], 0)
                self.assertEqual((await other.list_jobs())["total"], 1)
                self.assertFalse(await other.delete_feedback(79))
                self.assertEqual(await jobs.fetchval("SELECT count(*) FROM job_feedback"), 0)
                self.assertEqual((await client.delete("/api/jobs/79/feedback")).status_code, 204)
                self.assertEqual((await repo.list_jobs())["total"], 1)
                self.assertEqual((await client.put("/api/jobs/999/feedback", json={"kind": "skip"})).status_code, 404)
                self.assertEqual(await personal.fetchval("SELECT count(*) FROM job_feedback"), 0)
        finally:
            for pool in pools:
                await pool.close()
            await setup.execute("SET search_path TO public")
            for schema in schemas:
                await setup.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            await setup.close()
