"""Exercise ATS search against PostgreSQL using rolled-back temporary tables."""

import asyncio
import os
import unittest
from urllib.parse import urlsplit

import asyncpg

from api.tracker.store import PostgresRepository


class SerialPool:
    """Serialize concurrent repository reads on the isolated test connection."""

    def __init__(self, connection):
        self.connection = connection
        self.lock = asyncio.Lock()

    async def fetch(self, *args):
        async with self.lock:
            return await self.connection.fetch(*args)

    async def fetchval(self, *args):
        async with self.lock:
            return await self.connection.fetchval(*args)

    async def fetchrow(self, *args):
        async with self.lock:
            return await self.connection.fetchrow(*args)


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class ATSSearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_sources_deduplication_counts_and_existing_search(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        connection = await asyncpg.connect(dsn)
        transaction = connection.transaction()
        await transaction.start()
        try:
            await connection.execute("""
                CREATE TEMP TABLE company (id bigint PRIMARY KEY, name text);
                CREATE TEMP TABLE company_logo (company_id bigint, bytes bytea);
                CREATE TEMP TABLE job_posting_dup_group (
                    id bigint PRIMARY KEY, primary_posting_id bigint, state text
                );
                CREATE TEMP TABLE job_posting (
                    id bigint PRIMARY KEY, company_id bigint DEFAULT 1,
                    source text, title text DEFAULT 'Intern',
                    status text DEFAULT 'active', job_type text DEFAULT 'intern',
                    dup_group_id bigint, locations jsonb DEFAULT '[]',
                    attributes jsonb DEFAULT '{}', remote text, part_time boolean,
                    job_domain text, source_url text,
                    apply_url text DEFAULT 'https://example.com/job',
                    posted_at timestamptz, first_seen_at timestamptz DEFAULT now(),
                    last_seen_at timestamptz
                );
                INSERT INTO company VALUES (1, 'Acme');
                INSERT INTO job_posting_dup_group VALUES
                    (1, 1, 'confirmed'), (2, 7, 'rejected'), (3, 9, 'confirmed');
                INSERT INTO job_posting (id, source, dup_group_id) VALUES
                    (1, 'greenhouse:acme', 1),
                    (2, 'workday:acme', 1), (3, 'workday:mirror', 1),
                    (4, 'lever:closed', 1),
                    (5, 'workday-list:acme', NULL),
                    (6, 'greenhouse:tenant-only-workday', NULL),
                    (7, 'greenhouse:rejected', 2), (8, 'lever:rejected', 2),
                    (9, 'greenhouse:closed-primary', 3),
                    (10, 'ashby:fallback', 3), (11, 'workday:alternate', 3);
                UPDATE job_posting SET status = 'closed' WHERE id IN (4, 9);
                UPDATE job_posting SET job_type = 'coop', title = 'Fall Co-op' WHERE id = 5;
                UPDATE job_posting SET attributes = '{"skills":["python"]}' WHERE id = 1;
                UPDATE job_posting SET first_seen_at = now() - interval '1 day' WHERE id = 11;
            """)
            repository = PostgresRepository("", pool=SerialPool(connection))

            async def listing(**filters):
                return await repository.list_jobs(hide_tracked=False, sort="company", **filters)

            cases = (
                ("  WoRkDaY  ", {1, 5, 10}),
                ("greenhouse", {1, 6, 7}),
                ("lever", {8}),
                ("ashby", {10}),
                ("tenant-only", set()),
                ("w%", set()),
                ("_", set()),
                ("python", {1}),
                ("Fall Co-op", {5}),
                ("Acme", {1, 5, 6, 7, 8, 10}),
                ("", {1, 5, 6, 7, 8, 10}),
            )
            for query, expected in cases:
                with self.subTest(query=query):
                    result = await listing(q=query)
                    self.assertEqual({job["id"] for job in result["jobs"]}, expected)
                    self.assertEqual(result["total"], len(expected))
                    self.assertEqual(sum(result["job_type_counts"].values()), len(expected))

            result = await listing(q="workday", job_types=["intern"])
            self.assertEqual({job["id"] for job in result["jobs"]}, {1, 10})
            self.assertEqual(result["total"], 2)
            self.assertEqual(result["job_type_counts"]["intern"], 2)
            self.assertEqual(result["job_type_counts"]["coop"], 1)
            self.assertEqual(result["jobs"][0]["source"], "greenhouse:acme")

            result = await listing(q="workday", limit=1, offset=1)
            self.assertEqual([job["id"] for job in result["jobs"]], [1])
            self.assertEqual(result["total"], 3)

            result = await listing(q="workday", exclude_job_ids=[2])
            self.assertEqual({job["id"] for job in result["jobs"]}, {5, 10})
            result = await listing(q="workday", season="fall")
            self.assertEqual([job["id"] for job in result["jobs"]], [5])
        finally:
            await transaction.rollback()
            await connection.close()
