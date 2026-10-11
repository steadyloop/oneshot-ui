"""Local jobs and central personal data must remain separate."""
import asyncio
import os
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import asyncpg
import httpx

from api.app import create_app
from api.auth import session_account
from api.tracker.store import PostgresRepository
from api.taxonomy import SOFTWARE_FILTER
from api.resume.store import PostgresResumeStore
from api.config import Settings, load_settings
from db_fixtures import SERVING_TABLES, clone_tables


class Pool:
    def __init__(self, personal=False):
        self.personal = personal
        self.calls = []

    async def fetch(self, sql, *args):
        self.calls.append((sql,args))
        if self.personal:
            return [{'job_posting_id':77}]
        return []

    async def fetchval(self, sql, *args):
        self.calls.append((sql,args))
        return b'logo' if 'SELECT bytes' in sql else 0

    async def fetchrow(self, sql, *args):
        self.calls.append((sql,args))
        return dict.fromkeys(('intern','coop','student','new_grad','research'),0)


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_applied_route_reads_local_posting_and_saves_central_snapshot(self):
        connection = AsyncMock()
        connection.transaction = MagicMock()
        personal = MagicMock()
        personal.acquire.return_value.__aenter__.return_value = connection
        jobs = AsyncMock()
        jobs.fetchrow.return_value = {
            "id": 79, "title": "Local intern", "company_name": "Acme",
            "locations": [], "source_url": "https://acme.example/jobs/79",
            "apply_url": None, "dup_group_id": None, "collapsible": False,
        }
        connection.fetchrow.side_effect = [None, {
            "id": 123, "job_posting_id": 79, "company_snapshot": "Acme",
            "title_snapshot": "Local intern", "stage": "applied",
            "task_state": "waiting", "last_open_stage": "applied",
        }]
        connection.fetchval.side_effect = [None, 123]
        connection.fetch.return_value = []
        account = uuid4()
        repo = PostgresRepository('', account_id=account, pool=personal, jobs_pool=jobs)
        app = create_app(Settings(dsn=''), repository=repo)
        app.state.repository = repo
        app.dependency_overrides[session_account] = lambda: account
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/jobs/79/applications', json={'submitted_at': '2026-10-07'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['job_id'], 79)
            self.assertEqual(response.json()['title'], 'Local intern')
            jobs.fetchrow.assert_awaited_once()
            self.assertNotIn('FOR SHARE', jobs.fetchrow.call_args.args[0])
            for method in (connection.fetchrow, connection.fetchval, connection.fetch, connection.execute):
                for call in method.call_args_list:
                    self.assertNotIn('FROM job_posting', call.args[0])
            jobs.execute.assert_not_awaited()
            jobs.fetchrow.return_value = None
            connection.fetchval.reset_mock()
            self.assertEqual((await client.post('/api/jobs/999/applications')).status_code, 404)
            connection.fetchval.assert_not_awaited()

    async def test_personal_exclusions_come_from_neon_and_gold_filter_runs_locally(self):
        personal, jobs = Pool(True), Pool()
        repo = PostgresRepository('', pool=personal, jobs_pool=jobs)
        await repo.list_jobs(degree_fields=[SOFTWARE_FILTER])
        self.assertEqual(len(personal.calls),1)
        self.assertIn('job_application',personal.calls[0][0])
        sql = '\n'.join(call[0] for call in jobs.calls)
        self.assertIn('j.job_domain = ANY(',sql)
        self.assertNotIn('regexp_replace',sql)
        self.assertNotIn('SELECT 1 FROM job_application',sql)
        self.assertTrue(any([77] in args for _,args in jobs.calls))
        clone = repo.for_account(uuid4())
        self.assertIs(clone._ready(),personal)
        self.assertIs(clone._jobs_ready(),jobs)
        self.assertEqual(await clone.company_logo(9),b'logo')

    async def test_default_configuration_uses_one_pool(self):
        pool = Pool()
        repo = PostgresRepository('',pool=pool)
        await repo.list_jobs()
        self.assertIs(repo._jobs_ready(),repo._ready())
        self.assertTrue(any('SELECT 1 FROM job_application' in sql for sql,_ in pool.calls))

    async def test_skip_validates_jobs_and_writes_only_personal_feedback(self):
        account = uuid4()
        row = {"job_posting_id": 79, "kind": "skip", "corrections": "[]"}
        personal = AsyncMock()
        personal.fetchrow.return_value = row
        jobs = AsyncMock()
        jobs.fetchval.return_value = True
        repo = PostgresRepository('', account_id=account, pool=personal, jobs_pool=jobs)
        self.assertEqual((await repo.set_feedback(79, kind="skip"))["job_id"], 79)
        jobs.fetchval.assert_awaited_once_with(
            "SELECT EXISTS (SELECT 1 FROM job_posting WHERE id = $1)", 79
        )
        sql, *args = personal.fetchrow.call_args.args
        self.assertNotIn("FROM job_posting", sql)
        self.assertEqual(args[:3], [account, 79, "skip"])
        jobs.fetchrow.assert_not_awaited()
        jobs.fetchval.return_value = False
        personal.fetchrow.reset_mock()
        self.assertIsNone(await repo.set_feedback(999, kind="skip"))
        personal.fetchrow.assert_not_awaited()

    async def test_hidden_list_reads_feedback_centrally_and_postings_from_jobs(self):
        personal, jobs = AsyncMock(), AsyncMock()
        personal.fetch.return_value = [{"job_posting_id": 79, "kind": "skip", "corrections": "[]"}]
        personal.fetchval.return_value = 1
        jobs.fetch.return_value = [{"id": 79, "title": "Local intern", "company_name": "Acme"}]
        repo = PostgresRepository('', pool=personal, jobs_pool=jobs)
        result = await repo.list_feedback(limit=10, offset=2)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["hidden"][0]["job"]["title"], "Local intern")
        self.assertNotIn("JOIN job_posting", personal.fetch.call_args.args[0])
        self.assertEqual(jobs.fetch.call_args.args[1], [79])

    def test_jobs_dsn_is_optional_and_normalized(self):
        with patch('api.config.load_dotenv_files'), patch.dict(os.environ, {
            'DATABASE_URL':'postgresql://neon/db?sslmode=require',
            'JOBS_DATABASE_URL':'"postgresql:///xjobscore_frontend"',
        }):
            settings = load_settings()
            self.assertEqual(settings.jobs_dsn,'postgresql:/xjobscore_frontend')
            self.assertIn('neon',settings.dsn)


@unittest.skipUnless(os.environ.get('ONESHOT_TEST_DATABASE_URL'),'local test database not configured')
class SplitDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_application_and_resume_writes_only_use_central_database(self):
        dsn=os.environ['ONESHOT_TEST_DATABASE_URL']
        from urllib.parse import urlsplit
        self.assertIn(urlsplit(dsn).hostname,(None,'localhost','127.0.0.1','::1'))
        setup=await asyncpg.connect(dsn)
        names=['jobs_'+uuid4().hex,'personal_'+uuid4().hex]
        pools=[]
        try:
            for name in names:
                await setup.execute('CREATE SCHEMA '+name)
                await setup.execute('SET search_path TO '+name)
                await clone_tables(setup, *SERVING_TABLES)
                pool=await asyncpg.create_pool(dsn,min_size=1,max_size=4,server_settings={'search_path':name})
                pools.append(pool)
                await pool.execute("""
                    INSERT INTO company(id,name,domain) OVERRIDING SYSTEM VALUE VALUES(9,'Acme','acme.example');
                    INSERT INTO job_posting(id,source,source_key,company_id,title,content_hash,job_type,job_domain)
                    VALUES(77,'test','77',9,'Tracked intern','x','intern','software'),
                          (78,'test','78',9,'Finance intern','x','intern','finance'),
                          (79,'test','79',9,'New software intern','x','intern','software');
                """)
            local,central=pools
            # The new posting exists only locally; central has stale job data.
            await central.execute('DELETE FROM job_posting WHERE id=79')
            await central.execute("UPDATE job_posting SET title='Stale central title' WHERE id=78")
            account=uuid4()
            await central.execute('INSERT INTO account(id) VALUES($1)',account)
            await central.execute("INSERT INTO job_application(account_id,job_posting_id,company_snapshot,title_snapshot,stage) VALUES($1,77,'Acme','Tracked intern','applied')",account)
            repo=PostgresRepository('',account_id=account,pool=central,jobs_pool=local)
            listing=await repo.list_jobs(degree_fields=[SOFTWARE_FILTER])
            self.assertEqual([j['id'] for j in listing['jobs']],[79])
            application=await repo.create_application(79,submitted_at='2026-10-07')
            self.assertEqual(application['title'], 'New software intern')
            self.assertEqual(await central.fetchval('SELECT job_posting_id FROM job_application WHERE id=$1',application['id']),79)
            self.assertEqual(await central.fetchval('SELECT count(*) FROM job_application'),2)
            self.assertEqual(await local.fetchval('SELECT count(*) FROM job_application'),0)
            self.assertEqual((await repo.list_jobs(degree_fields=[SOFTWARE_FILTER]))['total'],0)
            again = await repo.create_application(79)
            self.assertEqual(again['id'], application['id'])
            self.assertTrue(again['already_exists'])
            # Repeated concurrent clicks create one record and one event.
            concurrent = await asyncio.gather(*(repo.create_application(78) for _ in range(4)))
            self.assertEqual(len({row['id'] for row in concurrent}), 1)
            self.assertEqual(concurrent[0]['title'], 'Finance intern')
            self.assertEqual(await central.fetchval('SELECT count(*) FROM job_application_event WHERE job_application_id=$1', concurrent[0]['id']), 1)
            # Duplicate-group identity also comes entirely from the jobs DB.
            group = uuid4()
            await local.execute("INSERT INTO job_posting_dup_group(id,primary_posting_id,state) VALUES($1,78,'confirmed')", group)
            await local.execute('UPDATE job_posting SET dup_group_id=$1 WHERE id IN (78,79)', group)
            other_account = uuid4()
            await central.execute('INSERT INTO account(id) VALUES($1)', other_account)
            other = repo.for_account(other_account)
            duplicates = await asyncio.gather(other.create_application(78), other.create_application(79))
            self.assertEqual(duplicates[0]['id'], duplicates[1]['id'])
            self.assertNotEqual(duplicates[0]['id'], application['id'])
            self.assertEqual(await central.fetchval('SELECT count(*) FROM job_application WHERE account_id=$1', other_account), 1)
            self.assertIsNone(await repo.create_application(999))
            # Existing single-database operation still snapshots and deduplicates.
            single = PostgresRepository('', account_id=account, pool=local)
            await local.execute('INSERT INTO account(id) VALUES($1)', account)
            single_rows = await asyncio.gather(single.create_application(78), single.create_application(79))
            self.assertEqual(single_rows[0]['id'], single_rows[1]['id'])
            resumes=PostgresResumeStore('',pool=central).for_account(account)
            await resumes.update_profile({'full_name':'Central test'})
            self.assertEqual(await central.fetchval('SELECT count(*) FROM resume_workspace'),1)
            self.assertEqual(await local.fetchval('SELECT count(*) FROM resume_workspace'),0)
        finally:
            for pool in pools:
                await pool.close()
            await setup.execute('SET search_path TO public')
            for name in names:
                await setup.execute('DROP SCHEMA IF EXISTS '+name+' CASCADE')
            await setup.close()
