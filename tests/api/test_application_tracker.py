"""Tracker persistence contract. Database checks use an isolated, rolled-back schema.

Run with ONESHOT_TEST_DATABASE_URL pointing to a local development database.
"""
import os
import unittest
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import httpx
from pydantic import ValidationError

from api.tracker.models import ApplicationUpdate, ExternalApplicationCreate
from api.tracker.store import PostgresRepository
from api.app import create_app
from api.auth import session_account
from api.config import Settings
from db_fixtures import clone_tables


class PayloadTests(unittest.TestCase):
    def test_workflow_validation(self):
        self.assertEqual(ApplicationUpdate(stage='replied').stage, 'replied')
        self.assertEqual(ExternalApplicationCreate(company='Acme', title='Intern').url, '')
        for body in ({'stage': 'considering'}, {'stage': 'closed'}, {'stage': None}, {'task_state': None}):
            with self.assertRaises(ValidationError):
                ApplicationUpdate(**body)


class ConnectionPool:
    def __init__(self, connection):
        self.connection = connection

    @asynccontextmanager
    async def acquire(self):
        yield self.connection

    async def fetch(self, *args):
        return await self.connection.fetch(*args)


@unittest.skipUnless(os.environ.get('ONESHOT_TEST_DATABASE_URL'), 'local test database not configured')
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_record_lifecycle(self):
        dsn = os.environ['ONESHOT_TEST_DATABASE_URL']
        self.assertIn(urlsplit(dsn).hostname, (None, 'localhost', '127.0.0.1', '::1'))
        connection = await asyncpg.connect(dsn)
        transaction = connection.transaction()
        await transaction.start()
        try:
            schema = f'tracker_test_{uuid4().hex}'
            await connection.execute(f'CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}, public')
            await clone_tables(connection, 'job_application', 'job_application_event')
            account = uuid4()
            legacy = await connection.fetchval("INSERT INTO job_application(account_id, company_snapshot, title_snapshot, stage, task_state, submitted_at, resume_variant) VALUES ($1, 'Legacy', 'Intern', 'applied', 'waiting', NULL, 'Existing.pdf') RETURNING id", account)
            closed = await connection.fetchval("INSERT INTO job_application(account_id, company_snapshot, title_snapshot, stage, closed_reason, last_open_stage) VALUES ($1, 'Closed', 'Intern', 'closed', 'withdrawn', 'interview') RETURNING id", account)
            await connection.execute("INSERT INTO job_application_event(job_application_id,event_type,to_stage) VALUES ($1,'stage_changed','interview')", closed)
            repo = PostgresRepository(dsn, account_id=account, pool=ConnectionPool(connection))
            other = repo.for_account(uuid4())
            old = await repo.get_application(legacy)
            self.assertEqual(old['stage'], 'applied'); self.assertIsNone(old['submitted_at'])
            self.assertEqual(old['resume_variant'], 'Existing.pdf')
            self.assertEqual((await repo.get_application(closed))['last_open_stage'], 'interview')
            app = await repo.create_external_application(company='Acme', title='Intern', submitted_at='2026-09-28')
            app_id = app['id']
            self.assertEqual(app['stage'], 'applied'); self.assertEqual(app['task_state'], 'waiting')
            self.assertIsNone(app['next_action']); self.assertIsNone(app['apply_url_snapshot'])
            for stage in ('replied', 'offer'):
                app = await repo.update_application(app_id, {'stage': stage, 'task_state': 'action', 'next_action': 'Review offer', 'next_due_at': '2026-10-16'})
                self.assertEqual(app['id'], app_id); self.assertEqual(app['stage'], stage)
            app = await repo.update_application(app_id, {'task_state': 'waiting', 'waiting_for': 'Confirmation', 'next_action': None, 'next_due_at': None, 'activity': 'Completed: Review offer'})
            self.assertEqual(app['stage'], 'offer'); self.assertIsNone(app['next_due_at'])
            self.assertTrue(any(e['note'] == 'Completed: Review offer' for e in app['events']))
            app = await repo.update_application(app_id, {'stage': 'closed', 'closed_reason': 'rejected'})
            self.assertEqual(app['last_open_stage'], 'offer')
            app = await repo.update_application(app_id, {'stage': app['last_open_stage'], 'closed_reason': None})
            self.assertEqual(app['stage'], 'offer'); self.assertIsNone(app['closed_reason'])
            self.assertEqual(app['submitted_at'][:10], '2026-09-28')
            self.assertIsNone(await other.get_application(app_id))
            self.assertIsNone(await other.update_application(app_id, {'stage': 'interview'}))
            self.assertEqual(len((await other.list_applications())['applications']), 0)
            with self.assertRaises(ValueError):
                await repo.update_application(app_id, {'stage': 'considering'})
            with self.assertRaises(ValueError):
                await repo.update_application(app_id, {'company': 'Changed', 'next_due_at': 'not-a-date'})
            self.assertEqual((await repo.get_application(app_id))['company'], 'Acme')
            # Discover uses the real posting snapshot while writing only to our isolated tracker.
            job = await connection.fetchval('SELECT id FROM public.job_posting LIMIT 1')
            if job:
                tracked = await repo.create_application(job, submitted_at='2026-10-06')
                again = await repo.create_application(job, submitted_at='2026-10-06')
                self.assertEqual(tracked['stage'], 'applied'); self.assertEqual(tracked['id'], again['id'])
                self.assertTrue(again['already_exists'])
                with self.assertRaises(ValueError):
                    await repo.update_application(tracked['id'], {'company': 'Changed'})
            self.assertIsNone((await repo.update_application(legacy, {'stage': 'interview'}))['submitted_at'])
            self.assertIsNone((await repo.update_application(legacy, {'stage': 'applied'}))['submitted_at'])
            # Exercise the real routes and command models against the same isolated DB.
            app_server = create_app(Settings(dsn=''), repository=repo)
            app_server.state.repository = repo
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app_server), base_url='http://test') as client:
                self.assertEqual((await client.get('/api/applications')).status_code, 401)
                app_server.dependency_overrides[session_account] = lambda: account
                response = await client.post('/api/applications/external', json={'company': 'API Co', 'title': 'Intern', 'submitted_at': '2026-10-06'})
                self.assertEqual(response.status_code, 200)
                row = response.json(); self.assertEqual(row['stage'], 'applied')
                response = await client.patch(f"/api/applications/{row['id']}", json={'stage': 'replied', 'task_state': 'action', 'next_action': 'Reply to recruiter'})
                self.assertEqual(response.status_code, 200); self.assertEqual(response.json()['stage'], 'replied')
                self.assertEqual((await client.patch(f"/api/applications/{row['id']}", json={'stage': 'considering'})).status_code, 422)
                app_server.dependency_overrides[session_account] = lambda: uuid4()
                self.assertEqual((await client.get(f"/api/applications/{row['id']}")).status_code, 404)
                self.assertEqual((await client.get('/application/')).status_code, 200)
        finally:
            await transaction.rollback()
            await connection.close()


if __name__ == '__main__':
    unittest.main()
