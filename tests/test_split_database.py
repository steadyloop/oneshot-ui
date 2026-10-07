"""Local jobs and central personal data must remain separate."""
import os
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import asyncpg

from api.repository import PostgresRepository, SOFTWARE_FILTER
from api.resume_store import PostgresResumeStore
from api.config import load_settings


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
        root=Path(os.environ.get('XJOBSCORE_SCHEMA_ROOT',Path(__file__).resolve().parents[2]/'xjobscore'))
        if not (root/'frontend.sql').is_file():
            self.skipTest('xjobscore/frontend.sql checkout required')
        setup=await asyncpg.connect(dsn)
        names=['jobs_'+uuid4().hex,'personal_'+uuid4().hex]
        pools=[]
        try:
            for name in names:
                await setup.execute('CREATE SCHEMA '+name)
                await setup.execute('SET search_path TO '+name)
                await setup.execute((root/'frontend.sql').read_text())
                for filename in ('20261006_application_tracker.sql','20261006_resume_vocabulary.sql'):
                    await setup.execute((Path(__file__).resolve().parents[1]/'migrations'/filename).read_text())
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
            account=uuid4()
            await central.execute('INSERT INTO account(id) VALUES($1)',account)
            await central.execute("INSERT INTO job_application(account_id,job_posting_id,company_snapshot,title_snapshot,stage) VALUES($1,77,'Acme','Tracked intern','applied')",account)
            repo=PostgresRepository('',account_id=account,pool=central,jobs_pool=local)
            listing=await repo.list_jobs(degree_fields=[SOFTWARE_FILTER])
            self.assertEqual([j['id'] for j in listing['jobs']],[79])
            application=await repo.create_application(79,submitted_at='2026-10-07')
            self.assertEqual(await central.fetchval('SELECT job_posting_id FROM job_application WHERE id=$1',application['id']),79)
            self.assertEqual(await central.fetchval('SELECT count(*) FROM job_application'),2)
            self.assertEqual(await local.fetchval('SELECT count(*) FROM job_application'),0)
            self.assertEqual((await repo.list_jobs(degree_fields=[SOFTWARE_FILTER]))['total'],0)
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
