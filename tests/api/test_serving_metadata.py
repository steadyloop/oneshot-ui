"""Serving metadata remains usable without the pipeline's classifier engines."""

import unittest
from datetime import datetime, timedelta, timezone

from api.tracker.store import _skill_details, _skill_search_ids, VALID_DEGREE_FIELDS
from api.taxonomy.coverage_snapshot import board_state, empty_snapshot


class ServingMetadataTests(unittest.TestCase):
    def test_published_skill_ids_and_aliases_still_resolve(self):
        python = _skill_details({"skills": ["python", "Python", "unknown-skill"]})
        self.assertEqual([skill["id"] for skill in python], ["python", "unknown-skill"])
        self.assertEqual(python[0]["name"], "Python")
        self.assertIn("python", _skill_search_ids("Python"))
        self.assertIn("postgresql", _skill_search_ids("Postgres"))
        self.assertTrue({"software", "finance", "bioengineering"} <= VALID_DEGREE_FIELDS)

    def test_board_status_keeps_failure_pause_and_staleness_rules(self):
        now = datetime(2026, 10, 7, tzinfo=timezone.utc)
        self.assertEqual(board_state(3, now, now, 60, now), "paused")
        self.assertEqual(board_state(3, now, None, 60, now), "failing")
        self.assertEqual(board_state(1, now, None, 60, now), "degraded")
        self.assertEqual(board_state(0, None, None, 60, now), "never")
        self.assertEqual(board_state(0, now - timedelta(seconds=181), None, 60, now), "stale")
        self.assertEqual(board_state(0, now - timedelta(seconds=180), None, 60, now), "ok")

    def test_empty_snapshot_has_independent_serving_defaults(self):
        left, right = empty_snapshot(), empty_snapshot()
        left["source_coverage"]["sources"].append({"source": "test"})
        self.assertEqual(right["source_coverage"]["sources"], [])
        self.assertEqual(right["board_map"]["providers"], [])
