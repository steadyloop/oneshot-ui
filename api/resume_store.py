"""PostgreSQL store for the resume workspace.

Three tables, all keyed by account: ``resume_workspace`` holds the whole content
bank as one jsonb row, ``resume_target`` the pasted job descriptions, and
``resume_document`` the assembled resumes.

The bank is one row rather than a table per content type because the atomic unit
is the bullet, not the resume: a resume is a *selection* of bullet and skill ids
plus template parameters, and those ids have to stay stable. All the list work
lives in :mod:`resume_workspace`; this module is the load / mutate / save shell
around it.

asyncpg returns ``jsonb`` as a ``str`` unless a codec is registered, so every
read decodes explicitly and every write passes ``json.dumps`` with a ``::jsonb``
cast — the same convention ``repository.py`` uses. A pool-level codec was
rejected: it would not exist on a pool handed in through ``for_account`` or a
test fixture, so the bug would appear on some code paths only.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date, datetime
import json
from typing import Any, AsyncIterator
from uuid import UUID

import asyncpg

from . import resume_workspace as workspace
from .repository import LOCAL_ACCOUNT_ID

RESUME_FIELDS = (
    "name", "target_job_id", "variant", "availability_line", "education_note", "selection",
)
TARGET_FIELDS = ("company", "title", "url", "jd_text", "date_posted", "note")


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _json_value(value: Any, fallback: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return fallback if value is None else value


def _target(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": row["id"],
        "company": row["company"],
        "title": row["title"],
        "url": row["url"],
        "jd_text": row["jd_text"],
        "date_posted": row["date_posted"],
        "note": row["note"],
        "job_application_id": row["job_application_id"],
        "created_at": _iso(row["created_at"]),
    }


def _document(row: asyncpg.Record) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "target_job_id": row["target_job_id"],
        "variant": row["variant"],
        "availability_line": row["availability_line"],
        "education_note": row["education_note"],
        "selection": _json_value(row["selection"], {}),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
    }


class PostgresResumeStore:
    """Resume-studio queries and commands over an ``asyncpg`` pool."""

    def __init__(
        self,
        dsn: str,
        *,
        account_id: UUID = LOCAL_ACCOUNT_ID,
        pool: asyncpg.Pool | None = None,
    ) -> None:
        self.dsn = dsn
        self.account_id = account_id
        self.pool = pool
        self._owns_pool = pool is None

    async def connect(self) -> None:
        if self.pool is not None:
            return
        if not self.dsn:
            raise RuntimeError(
                "No PostgreSQL DSN. Set DATABASE_URL."
            )
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=8)

    async def close(self) -> None:
        if self.pool is not None and self._owns_pool:
            await self.pool.close()
            self.pool = None

    def _ready(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("PostgresResumeStore.connect() has not been called")
        return self.pool

    def for_account(self, account_id: UUID) -> "PostgresResumeStore":
        """A per-request view of the same pool, scoped to one account."""
        return PostgresResumeStore(self.dsn, account_id=account_id, pool=self._ready())

    # -- workspace access ------------------------------------------------

    @staticmethod
    def _decode(row: asyncpg.Record | None) -> dict[str, Any]:
        if row is None:
            return workspace.blank_workspace()
        return workspace.normalize(
            {
                "profile": _json_value(row["profile"], {}),
                "entries": _json_value(row["entries"], []),
                "skills": _json_value(row["skills"], []),
                "variants": _json_value(row["variants"], []),
                # `None` -- not `[]` -- so a row written before this column
                # existed inherits the seed vocabulary instead of decoding as a
                # deliberate empty list and silently disabling coverage.
                "vocabulary": _json_value(row["vocabulary"], None),
                "next_item_id": row["next_item_id"],
            }
        )

    async def _read(self) -> dict[str, Any]:
        """Read-only view. Creates no row: a GET must not write."""
        row = await self._ready().fetchrow(
            """
            SELECT profile, entries, skills, variants, vocabulary, next_item_id
            FROM resume_workspace WHERE account_id = $1
            """,
            self.account_id,
        )
        return self._decode(row)

    @asynccontextmanager
    async def _edit(self) -> AsyncIterator[dict[str, Any]]:
        """Lock the workspace row, yield it for mutation, write it back.

        The upsert creates the row on first use and row-locks it either way, in
        one round trip. The lock is load-bearing: without it two concurrent
        bullet inserts both read the same ``entries`` array and the second write
        silently discards the first.

        The write-back runs only on a clean exit — an exception propagates and
        the transaction rolls back.
        """
        async with self._ready().acquire() as connection, connection.transaction():
            row = await connection.fetchrow(
                """
                INSERT INTO resume_workspace (account_id) VALUES ($1)
                ON CONFLICT (account_id) DO UPDATE
                    SET updated_at = resume_workspace.updated_at
                RETURNING profile, entries, skills, variants, vocabulary, next_item_id
                """,
                self.account_id,
            )
            state = self._decode(row)
            yield state
            await connection.execute(
                """
                UPDATE resume_workspace
                SET profile      = $2::jsonb,
                    entries      = $3::jsonb,
                    skills       = $4::jsonb,
                    variants     = $5::jsonb,
                    vocabulary   = $6::jsonb,
                    next_item_id = $7,
                    updated_at   = now()
                WHERE account_id = $1
                """,
                self.account_id,
                json.dumps(state["profile"]),
                json.dumps(state["entries"]),
                json.dumps(state["skills"]),
                json.dumps(state["variants"]),
                json.dumps(state["vocabulary"]),
                state["next_item_id"],
            )

    # -- profile ---------------------------------------------------------

    async def get_profile(self) -> dict[str, Any]:
        return workspace.public_profile(await self._read())

    async def update_profile(self, fields: dict[str, Any]) -> dict[str, Any]:
        async with self._edit() as state:
            return workspace.apply_profile(state, fields)

    # -- variants and vocabulary -----------------------------------------

    async def list_variants(self) -> list[dict[str, str]]:
        return workspace.list_variants(await self._read())

    async def set_variants(self, raw: Any) -> list[dict[str, str]]:
        """Replace the variant list. Raises ValueError if it would orphan tags."""
        async with self._edit() as state:
            return workspace.set_variants(state, raw)

    async def list_vocabulary(self) -> list[str]:
        return workspace.list_vocabulary(await self._read())

    async def set_vocabulary(self, raw: Any) -> list[str]:
        async with self._edit() as state:
            return workspace.set_vocabulary(state, raw)

    # -- entries and bullets ---------------------------------------------

    async def list_entries(self) -> list[dict[str, Any]]:
        return workspace.list_entries(await self._read())

    async def create_entry(self, fields: dict[str, Any]) -> dict[str, Any]:
        async with self._edit() as state:
            return workspace.add_entry(state, fields)

    async def update_entry(
        self, entry_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        async with self._edit() as state:
            return workspace.edit_entry(state, entry_id, fields)

    async def delete_entry(self, entry_id: int) -> bool:
        async with self._edit() as state:
            return workspace.remove_entry(state, entry_id)

    async def create_bullet(
        self, entry_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        async with self._edit() as state:
            workspace.check_audience(state, fields.get("audience"))
            return workspace.add_bullet(state, entry_id, fields)

    async def update_bullet(
        self, bullet_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        async with self._edit() as state:
            workspace.check_audience(state, fields.get("audience"))
            return workspace.edit_bullet(state, bullet_id, fields)

    async def delete_bullet(self, bullet_id: int) -> bool:
        async with self._edit() as state:
            return workspace.remove_bullet(state, bullet_id)

    # -- skills ----------------------------------------------------------

    async def list_skills(self) -> list[dict[str, Any]]:
        return workspace.list_skills(await self._read())

    async def create_skill(self, fields: dict[str, Any]) -> dict[str, Any] | None:
        async with self._edit() as state:
            workspace.check_audience(state, fields.get("audience"))
            return workspace.add_skill(state, fields)

    async def delete_skill(self, skill_id: int) -> bool:
        async with self._edit() as state:
            return workspace.remove_skill(state, skill_id)

    # -- target jobs -----------------------------------------------------

    async def list_target_jobs(self) -> list[dict[str, Any]]:
        rows = await self._ready().fetch(
            "SELECT * FROM resume_target WHERE account_id = $1 ORDER BY id DESC",
            self.account_id,
        )
        return [_target(row) for row in rows]

    async def create_target_job(self, fields: dict[str, Any]) -> dict[str, Any]:
        row = await self._ready().fetchrow(
            """
            INSERT INTO resume_target
                (account_id, company, title, url, jd_text, date_posted, note)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            self.account_id,
            fields["company"],
            fields["title"],
            fields.get("url", ""),
            fields.get("jd_text", ""),
            fields.get("date_posted", ""),
            fields.get("note", ""),
        )
        return _target(row)

    async def create_target_from_application(
        self, application_id: int
    ) -> dict[str, Any] | None:
        """Build a resume target from a queued application. Idempotent.

        This is the join between the two halves of the app: the application
        tracker and the resume studio were separate stores over separate tables,
        so tailoring a resume for a tracked job meant retyping the company,
        title and URL and pasting the description by hand.

        Reads `job_application` directly rather than calling into
        `PostgresRepository`. The two stores share one pool and this is a single
        statement against an account-scoped row; routing it through the other
        store would buy indirection and a second round trip, not safety.

        The snapshot columns are the right source: they are frozen at the moment
        the job was queued and are immutable for discovered applications, so the
        target always reflects the posting as it was tracked. `description` is
        joined from the live posting because that is the only place it exists --
        it is absent for external applications, and absent on the ~12% of
        classified postings whose vendor supplies no description, both of which
        simply leave `jd_text` empty for the user to paste into.

        Returns None when the application is not this account's, which the route
        turns into a 404.
        """
        async with self._ready().acquire() as connection, connection.transaction():
            source = await connection.fetchrow(
                """
                SELECT
                    a.company_snapshot, a.title_snapshot, a.apply_url_snapshot,
                    coalesce(j.description, '') AS description,
                    j.posted_at
                FROM job_application a
                LEFT JOIN job_posting j ON j.id = a.job_posting_id
                WHERE a.id = $1 AND a.account_id = $2
                """,
                application_id,
                self.account_id,
            )
            if source is None:
                return None
            # ON CONFLICT DO UPDATE rather than DO NOTHING: DO NOTHING returns no
            # row, so the second click would have to re-SELECT to answer. The
            # no-op SET makes the existing row come back from the same statement.
            row = await connection.fetchrow(
                """
                INSERT INTO resume_target
                    (account_id, company, title, url, jd_text, date_posted,
                     job_application_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (account_id, job_application_id)
                    WHERE job_application_id IS NOT NULL
                    DO UPDATE SET company = resume_target.company
                RETURNING *
                """,
                self.account_id,
                source["company_snapshot"],
                source["title_snapshot"],
                source["apply_url_snapshot"] or "",
                # The column is `text NOT NULL`, and jd_text is capped at 100k by
                # the API model; a vendor description can exceed that.
                (source["description"] or "")[:100_000],
                source["posted_at"].date().isoformat() if source["posted_at"] else "",
                application_id,
            )
        return _target(row)

    async def _get_target(self, job_id: int) -> dict[str, Any] | None:
        row = await self._ready().fetchrow(
            "SELECT * FROM resume_target WHERE id = $1 AND account_id = $2",
            job_id,
            self.account_id,
        )
        return _target(row) if row is not None else None

    async def update_target_job(
        self, job_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        updates = {k: v for k, v in fields.items() if k in TARGET_FIELDS and v is not None}
        if not updates:
            return await self._get_target(job_id)
        columns = list(updates)
        assignments = ", ".join(f"{name} = ${i + 3}" for i, name in enumerate(columns))
        row = await self._ready().fetchrow(
            f"""
            UPDATE resume_target SET {assignments}
            WHERE id = $1 AND account_id = $2
            RETURNING *
            """,
            job_id,
            self.account_id,
            *(updates[name] for name in columns),
        )
        return _target(row) if row is not None else None

    async def delete_target_job(self, job_id: int) -> bool:
        result = await self._ready().execute(
            "DELETE FROM resume_target WHERE id = $1 AND account_id = $2",
            job_id,
            self.account_id,
        )
        return result != "DELETE 0"

    # -- resumes ---------------------------------------------------------

    async def list_resumes(self) -> list[dict[str, Any]]:
        rows = await self._ready().fetch(
            """
            SELECT * FROM resume_document WHERE account_id = $1
            ORDER BY updated_at DESC, id DESC
            """,
            self.account_id,
        )
        return [_document(row) for row in rows]

    async def get_resume(self, resume_id: int) -> dict[str, Any] | None:
        row = await self._ready().fetchrow(
            "SELECT * FROM resume_document WHERE id = $1 AND account_id = $2",
            resume_id,
            self.account_id,
        )
        return _document(row) if row is not None else None

    async def _check_variant(self, variant: Any) -> None:
        """Reject a resume variant the account has not declared.

        The audience checks run inside ``_edit``, which already holds the
        workspace row; a resume lives in another table, so this one reads it.
        """
        workspace.check_variant(await self._read(), variant)

    async def create_resume(self, fields: dict[str, Any]) -> dict[str, Any]:
        await self._check_variant(fields.get("variant"))
        row = await self._ready().fetchrow(
            """
            INSERT INTO resume_document
                (account_id, name, target_job_id, variant, availability_line,
                 education_note, selection)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            RETURNING *
            """,
            self.account_id,
            fields["name"],
            fields.get("target_job_id"),
            fields.get("variant", ""),
            fields.get("availability_line", ""),
            fields.get("education_note", ""),
            json.dumps(fields.get("selection", {})),
        )
        return _document(row)

    async def update_resume(
        self, resume_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        await self._check_variant(fields.get("variant"))
        updates = {
            k: v
            for k, v in fields.items()
            if k in RESUME_FIELDS and v is not None and k != "target_job_id"
        }
        if not updates and "target_job_id" not in fields:
            return await self.get_resume(resume_id)
        # target_job_id is handled apart from the "not None" filter above so the
        # link can be *cleared* with an explicit null. The client sends this key
        # on every save, so this is the hot path, not an edge case.
        if "target_job_id" in fields:
            updates["target_job_id"] = fields["target_job_id"]

        columns = list(updates)
        assignments = ", ".join(
            f"{name} = ${i + 3}{'::jsonb' if name == 'selection' else ''}"
            for i, name in enumerate(columns)
        )
        values = [
            json.dumps(updates[name]) if name == "selection" else updates[name]
            for name in columns
        ]
        row = await self._ready().fetchrow(
            f"""
            UPDATE resume_document SET {assignments}, updated_at = now()
            WHERE id = $1 AND account_id = $2
            RETURNING *
            """,
            resume_id,
            self.account_id,
            *values,
        )
        return _document(row) if row is not None else None

    async def delete_resume(self, resume_id: int) -> bool:
        result = await self._ready().execute(
            "DELETE FROM resume_document WHERE id = $1 AND account_id = $2",
            resume_id,
            self.account_id,
        )
        return result != "DELETE 0"

    # -- derived ---------------------------------------------------------

    async def coverage(
        self, job_id: int, resume_id: int | None = None
    ) -> dict[str, Any] | None:
        job = await self._get_target(job_id)
        if job is None:
            return None
        # One read for both: the skill bank and the term list are the same row,
        # so re-reading for the vocabulary could straddle an edit.
        state = await self._read()
        skills = workspace.list_skills(state)
        shown_ids: set[int] = set()
        if resume_id is not None:
            resume = await self.get_resume(resume_id)
            if resume is not None:
                shown_ids = set(resume["selection"].get("skills", []))
        return workspace.compute_coverage(
            job, skills, shown_ids, workspace.list_vocabulary(state)
        )

    async def render_inputs(
        self, resume_id: int
    ) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]] | None:
        """Everything the Typst renderer needs, from one consistent snapshot.

        The old four-call version could interleave with an edit and render a
        resume against a bank that never existed. Profile, entries, and skills
        now come out of a single row, so this is two queries.
        """
        resume = await self.get_resume(resume_id)
        if resume is None:
            return None
        state = await self._read()
        return (
            workspace.public_profile(state),
            resume,
            workspace.list_entries(state),
            workspace.list_skills(state),
        )
