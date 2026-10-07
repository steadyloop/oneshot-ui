"""Feed metrics use real closure signals, Pacific days and canonical jobs."""

import asyncio
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

import asyncpg

from api.feed_activity import ACTIVITY_SQL, FeedActivityCache, activity_payload
from api.repository import PostgresRepository


class CacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_header_and_footer_use_the_same_active_aggregate(self):
        class Pool:
            async def fetchrow(self, sql):
                return {"payload": {"board_map": {"providers": [], "totals": {"boards": 0}}}, "computed_at": None}

        repo = PostgresRepository("", pool=Pool())
        activity = activity_payload([
            {"job_type": "intern", "provider": "greenhouse", "total": 7,
             "student_roles": 5, "appeared": 1, "closed": 2},
        ], datetime.now(timezone.utc))
        with patch.object(repo._feed_activity_cache, "get", new=AsyncMock(return_value=activity)):
            result = await repo.board_map()
        self.assertEqual(result["totals"]["active_postings"], 7)
        self.assertEqual(result["totals"]["active_postings"], result["classification"]["total"])

    async def test_concurrent_accounts_share_the_query_and_roll_over_at_midnight(self):
        class Pool:
            calls = []

            async def fetch(self, sql, start, end, **kwargs):
                self.calls.append((start, end))
                await asyncio.sleep(0)
                return []

        pool = Pool()
        repo = PostgresRepository("", pool=pool)
        self.assertIs(repo.for_account(repo.account_id)._feed_activity_cache, repo._feed_activity_cache)
        cache = repo._feed_activity_cache
        with patch("api.feed_activity.datetime") as clock:
            clock.now.return_value = datetime(2026, 10, 7, 6, 59, tzinfo=timezone.utc)
            results = await asyncio.gather(*(cache.get(pool) for _ in range(4)))
            self.assertEqual(len(pool.calls), 1)
            self.assertEqual(pool.calls[0][0].isoformat(), "2026-10-06T00:00:00-07:00")
            self.assertEqual(results[0]["today_breakdown"]["total"], 0)
            clock.now.return_value = datetime(2026, 10, 7, 7, 1, tzinfo=timezone.utc)
            await cache.get(pool)
            self.assertEqual(len(pool.calls), 2)
            self.assertEqual(pool.calls[1][0].isoformat(), "2026-10-07T00:00:00-07:00")

    async def test_aggregate_failure_preserves_the_existing_board_snapshot(self):
        class Pool:
            async def fetchrow(self, sql):
                return {"payload": {"board_map": {"providers": [], "totals": {"added_today": 17}}}, "computed_at": None}

            async def fetch(self, *args, **kwargs):
                raise TimeoutError("query timed out")

        repo = PostgresRepository("", pool=Pool())
        with self.assertLogs("api.repository", level="WARNING"):
            result = await repo.board_map()
        self.assertEqual(result["totals"]["added_today"], 17)
        self.assertNotIn("disappeared_today", result["totals"])
        self.assertNotIn("classification", result)


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class AggregateTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_window_deduplication_and_closure_channels(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        conn = await asyncpg.connect(dsn)
        transaction = conn.transaction()
        await transaction.start()
        try:
            # Temporary tables shadow public tables, and all changes roll back.
            await conn.execute("""
                CREATE TEMP TABLE job_posting (
                    id bigint, dup_group_id bigint, job_type text, status text,
                    source text DEFAULT 'ats_a:test',
                    locations jsonb DEFAULT '[]', posted_at timestamptz,
                    first_seen_at timestamptz, ats_closed_at timestamptz,
                    linked_dead_at timestamptz, paged_closed_at timestamptz,
                    missing_since timestamptz
                );
                CREATE TEMP TABLE job_posting_dup_group (
                    id bigint, primary_posting_id bigint, state text
                );
                INSERT INTO job_posting_dup_group VALUES
                    (1, 1, 'confirmed'), (2, 3, 'confirmed'), (3, 5, 'rejected');
                INSERT INTO job_posting (id, dup_group_id, job_type, status, first_seen_at) VALUES
                    (1, 1, 'intern', 'active', '2026-10-07 07:00Z'),
                    (2, 1, 'intern', 'active', '2026-10-07 08:00Z'),
                    (3, 2, 'coop', 'closed', '2026-10-06 12:00Z'),
                    (4, 2, 'coop', 'active', '2026-10-07 09:00Z'),
                    (5, 3, 'student', 'active', '2026-10-07 08:00Z'),
                    (6, 3, 'student', 'active', '2026-10-07 08:00Z'),
                    (7, NULL, NULL, 'closed', '2026-10-06 12:00Z'),
                    (8, NULL, 'research', 'closed', '2026-10-06 12:00Z'),
                    (9, NULL, 'new_grad', 'active', '2026-10-07 06:59Z'),
                    (10, NULL, 'intern', 'active', '2026-10-07 13:00Z'),
                    (11, NULL, NULL, 'closed', '2026-10-06 12:00Z'),
                    (12, NULL, 'student', 'closed', '2026-10-06 12:00Z'),
                    (13, NULL, 'research', 'closed', '2026-10-06 12:00Z');
                UPDATE job_posting SET ats_closed_at = '2026-10-07 08:00Z' WHERE id IN (3, 7);
                -- A second closure observation today must not recount an old closure.
                UPDATE job_posting SET ats_closed_at = '2026-10-06 12:00Z',
                    paged_closed_at = '2026-10-07 09:00Z' WHERE id = 8;
                -- Disappearance alone is not evidence of closure.
                UPDATE job_posting SET missing_since = '2026-10-07 08:00Z' WHERE id = 11;
                UPDATE job_posting SET paged_closed_at = '2026-10-07 08:00Z' WHERE id = 12;
                UPDATE job_posting SET linked_dead_at = '2026-10-07 08:00Z' WHERE id = 13;
                UPDATE job_posting SET locations = '[{"country":"CA"}]' WHERE id = 9;
                UPDATE job_posting SET source = 'ats_b:duplicate' WHERE id = 2;
                UPDATE job_posting SET source = 'ats_b:fallback' WHERE id = 4;
                UPDATE job_posting SET source = 'ats_c:rejected' WHERE id = 6;
                UPDATE job_posting SET source = 'ats_d:foreign' WHERE id = 9;
            """)
            start = datetime(2026, 10, 7, 7, tzinfo=timezone.utc)
            now = datetime(2026, 10, 7, 12, tzinfo=timezone.utc)
            result = activity_payload(await conn.fetch(ACTIVITY_SQL, start, now), now)
            detail = result["today_breakdown"]
            self.assertEqual(detail["total"], 4)
            self.assertEqual(detail["types"]["intern"], 1)
            self.assertEqual(detail["types"]["coop"], 1)
            self.assertEqual(detail["types"]["student"], 2)
            self.assertEqual(detail["disappeared"]["total"], 3)
            self.assertEqual(detail["disappeared"]["types"]["coop"], 0)
            self.assertEqual(detail["disappeared"]["types"]["research"], 1)
            self.assertEqual(result["classification"], {"total": 7, "student_roles": 5})
            self.assertEqual(result["provider_discover_counts"], {"ats_a": 3, "ats_b": 1, "ats_c": 1, "ats_d": 0})
        finally:
            await transaction.rollback()
            await conn.close()
