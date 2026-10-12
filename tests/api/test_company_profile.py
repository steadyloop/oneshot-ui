"""Official websites remain available for separate companies sharing a domain."""

import json
import os
import unittest
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg

from api.companies import _company, list_companies
from api.company_profile import company_website
from db_fixtures import clone_tables


class CompanyWebsiteTests(unittest.TestCase):
    def test_shared_website_is_exposed_without_replacing_company_identity(self):
        row = {"id": 9, "name": "Subsidiary", "domain": None, "description": "Repairs vehicles.",
               "tags": {"company_resolution": {"website": "https://parent.example/collision-centers"}},
               "sync_pending": False, "sync_error": None}
        result = _company(row)
        self.assertEqual(result["website"], "https://parent.example/collision-centers")
        self.assertEqual(result["id"], 9)
        self.assertIsNone(result["domain"])

    def test_domain_fallback_and_unusable_research_urls(self):
        self.assertEqual(company_website("company.example", {}), "https://company.example")
        for url in ("javascript:alert(1)", "//other.example", "https://user:password@other.example",
                    "https://[", "https://other.example:invalid", "https://other.example/\n"):
            with self.subTest(url=url):
                tags = {"company_resolution": {"website": url}}
                self.assertEqual(company_website("company.example", tags), "https://company.example")
                self.assertIsNone(company_website(None, tags))
        self.assertIsNone(company_website(None, {"company_resolution": "malformed"}))


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class SharedWebsiteSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_finds_both_the_domain_owner_and_a_separate_shared_website_profile(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        schema = "company_website_test_" + uuid4().hex
        connection = await asyncpg.connect(dsn)
        pool = None
        try:
            await connection.execute(f"CREATE SCHEMA {schema}; SET search_path TO {schema}")
            await connection.execute("CREATE TABLE company(id bigint PRIMARY KEY, name text NOT NULL, domain text UNIQUE, description text, tags jsonb NOT NULL DEFAULT '{}')")
            await clone_tables(connection, "company_edit")
            await connection.execute("INSERT INTO company(id,name,domain) VALUES(1,'Parent','parent.example')")
            tags = {"company_resolution": {"website": "https://parent.example/collision-centers"}}
            await connection.execute("INSERT INTO company(id,name,tags) VALUES(2,'Collision Center',$1::jsonb)", json.dumps(tags))
            pool = await asyncpg.create_pool(dsn, min_size=1, max_size=3, server_settings={"search_path": schema})
            results = await list_companies(pool, q="parent.example")
            self.assertEqual(results["total"], 2)
            companies = {row["id"]: row for row in results["companies"]}
            self.assertEqual(companies[1]["website"], "https://parent.example")
            self.assertEqual(companies[2]["website"], tags["company_resolution"]["website"])
            self.assertIsNone(companies[2]["domain"])
        finally:
            if pool is not None:
                await pool.close()
            await connection.execute("SET search_path TO public")
            await connection.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            await connection.close()
