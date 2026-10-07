"""The real renderer must honor the controls shown by the resume workspace."""
from copy import deepcopy
from contextlib import asynccontextmanager
import os
from pathlib import Path
import unittest
from urllib.parse import urlsplit
from uuid import uuid4

import asyncpg
import httpx
from fastapi import FastAPI
from pydantic import ValidationError
from starlette.middleware.sessions import SessionMiddleware

from api.auth import session_account
from api.resume_api import render_router, router
from api.resume_models import ResumeUpdate
from api.resume_render import build_typst_source, compile_pdf
from api.resume_store import PostgresResumeStore


PROFILE = {"full_name": "Alex Morgan", "email": "alex@example.com", "links": []}
ENTRIES = [
    {"id": 1, "kind": "education", "org": "University of Washington", "role": "Computer Science",
     "detail": "GPA 3.85", "bullets": []},
    {"id": 2, "kind": "experience", "org": "Northstar Labs", "role": "Intern", "bullets": [
        {"id": 21, "text": "Original accomplishment"}, {"id": 22, "text": "Excluded accomplishment"}]},
]
SKILLS = [
    {"id": 50, "category": "coursework", "name": "Algorithms"},
    {"id": 51, "category": "coursework", "name": "Excluded course"},
    {"id": 60, "category": "language", "name": "Python"},
]
RESUME = {
    "availability_line": "Available Summer 2027",
    "selection": {"entries": [{"entry_id": 2, "bullets": [{"bullet_id": 21, "text_override": "Tailored accomplishment"}]}],
                  "skills": [50, 60]},
}


class WorkspaceRenderTests(unittest.TestCase):
    def source(self, resume=None):
        return build_typst_source(PROFILE, resume or RESUME, ENTRIES, SKILLS)

    def test_legacy_selection_includes_visible_education_and_chosen_courses(self):
        source = self.source()
        self.assertIn("University of Washington", source)
        self.assertIn("GPA 3.85", source)
        self.assertIn("*Coursework:* Algorithms", source)
        self.assertIn("Python", source)
        self.assertNotIn("Excluded course", source)
        self.assertIn("Tailored accomplishment", source)
        self.assertNotIn("Original accomplishment", source)
        self.assertNotIn("Excluded accomplishment", source)
        self.assertEqual(RESUME["selection"]["entries"][0]["entry_id"], 2)

    def test_gpa_and_header_overrides_survive_validation_and_rendering(self):
        resume = deepcopy(RESUME)
        resume["selection"]["entries"].append({"entry_id": 1, "show_detail": False})
        resume["selection"]["entries"][0]["role"] = "Software Engineering Intern"
        command = ResumeUpdate(selection=resume["selection"])
        resume["selection"] = command.selection.model_dump()
        source = self.source(resume)
        self.assertNotIn("GPA 3.85", source)
        self.assertIn("Software Engineering Intern", source)
        self.assertEqual(ENTRIES[1]["role"], "Intern")

    def test_availability_prints_once_without_education(self):
        source = build_typst_source(PROFILE, RESUME, ENTRIES[1:], SKILLS)
        self.assertEqual(source.count("Available Summer 2027"), 1)

    def test_both_designs_compile_to_real_pdfs(self):
        for template in ("main", "barlow"):
            with self.subTest(template=template):
                resume = deepcopy(RESUME)
                resume["selection"]["template"] = template
                validated = ResumeUpdate(selection=resume["selection"]).selection.model_dump()
                resume["selection"] = validated
                source = self.source(resume)
                self.assertIn(f'font: "{"Barlow" if template == "barlow" else "New Computer Modern"}"', source)
                pdf, pages, error = compile_pdf(source)
                self.assertEqual(error, "")
                self.assertTrue(pdf.startswith(b"%PDF-"))
                self.assertEqual(pages, 1)

    def test_legacy_guest_template_is_respected(self):
        resume = deepcopy(RESUME)
        resume["template"] = "barlow"
        self.assertIn('font: "Barlow"', self.source(resume))
        resume["selection"]["template"] = "main"
        self.assertIn('font: "New Computer Modern"', self.source(resume))

    def test_unknown_design_is_rejected_and_untrusted_render_input_uses_main(self):
        with self.assertRaises(ValidationError):
            ResumeUpdate(selection={"template": "arbitrary"})
        resume = deepcopy(RESUME)
        resume["selection"]["template"] = 'bad")[#text("​'
        self.assertIn('font: "New Computer Modern"', self.source(resume))


class PublicRenderTests(unittest.IsolatedAsyncioTestCase):
    async def test_guest_render_route_returns_pdf_using_the_selection(self):
        app = FastAPI()
        app.include_router(render_router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/resume/render/pdf", json={
                "profile": PROFILE, "resume": RESUME, "entries": ENTRIES, "skills": SKILLS,
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "application/pdf")
            self.assertTrue(response.content.startswith(b"%PDF-"))
            source = await client.post("/api/resume/render/source", json={
                "profile": PROFILE, "resume": RESUME, "entries": ENTRIES, "skills": SKILLS,
            })
            self.assertIn("Tailored accomplishment", source.text)


class ConnectionPool:
    def __init__(self, connection):
        self.connection = connection

    def __getattr__(self, name):
        return getattr(self.connection, name)

    @asynccontextmanager
    async def acquire(self):
        yield self.connection


@unittest.skipUnless(os.environ.get("ONESHOT_TEST_DATABASE_URL"), "local test database not configured")
class AccountPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_selection_round_trip_and_account_scoping(self):
        dsn = os.environ["ONESHOT_TEST_DATABASE_URL"]
        self.assertIn(urlsplit(dsn).hostname, (None, "localhost", "127.0.0.1", "::1"))
        connection = await asyncpg.connect(dsn)
        transaction = connection.transaction()
        await transaction.start()
        try:
            schema = f"resume_test_{uuid4().hex}"
            await connection.execute(f"CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema}, public")
            for table in ("resume_workspace", "resume_document"):
                await connection.execute(f"CREATE TABLE {table} (LIKE public.{table} INCLUDING ALL)")
            migration = (Path(__file__).resolve().parents[1] / "migrations/20261006_resume_vocabulary.sql").read_text()
            migration = migration.replace("BEGIN;", "").replace("COMMIT;", "")
            await connection.execute(migration)
            await connection.execute(migration)  # Safe on older and current schemas.
            # A legacy serial default copied by LIKE would use the real table's
            # sequence. Give the test its own sequence, as identity already does.
            identity = await connection.fetchval(
                "SELECT is_identity FROM information_schema.columns WHERE table_schema=$1 AND table_name='resume_document' AND column_name='id'", schema)
            if identity == "NO":
                await connection.execute("CREATE SEQUENCE test_resume_id; ALTER TABLE resume_document ALTER COLUMN id SET DEFAULT nextval('test_resume_id')")
            account = uuid4()
            store = PostgresResumeStore(dsn, account_id=account, pool=ConnectionPool(connection))
            await store.update_profile(PROFILE)
            education = await store.create_entry({**ENTRIES[0], "id": None})
            app = FastAPI()
            app.add_middleware(SessionMiddleware, secret_key="isolated-resume-test")
            app.include_router(router)
            app.state.resume_store = store
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                self.assertEqual((await client.get("/api/resume/resumes")).status_code, 401)
                app.dependency_overrides[session_account] = lambda: account
                response = await client.post("/api/resume/resumes", json={"name": "Account resume", "selection": {"entries": [], "skills": []}})
                self.assertEqual(response.status_code, 201)
                resume_id = response.json()["id"]
                selection = {"template": "barlow", "entries": [{"entry_id": education["id"], "show_detail": False, "bullets": []}], "skills": []}
                response = await client.patch(f"/api/resume/resumes/{resume_id}", json={"selection": selection, "availability_line": "Available Summer 2028"})
                self.assertEqual(response.status_code, 200)
                saved = (await client.get(f"/api/resume/resumes/{resume_id}")).json()
                self.assertEqual(saved["selection"], selection)
                self.assertEqual(saved["availability_line"], "Available Summer 2028")
                source = (await client.get(f"/api/resume/resumes/{resume_id}/source")).text
                self.assertIn('font: "Barlow"', source)
                self.assertNotIn("GPA 3.85", source)
                response = await client.get(f"/api/resume/resumes/{resume_id}/pdf")
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.content.startswith(b"%PDF-"))
                app.dependency_overrides[session_account] = lambda: uuid4()
                self.assertEqual((await client.get(f"/api/resume/resumes/{resume_id}")).status_code, 404)
                self.assertEqual((await client.patch(f"/api/resume/resumes/{resume_id}", json={"name": "Other account"})).status_code, 404)
        finally:
            await transaction.rollback()
            await connection.close()


if __name__ == "__main__":
    unittest.main()
