"""Tests for the in-memory marker store.

Run: python3 -m unittest discover -s tests   (from the zmnMon root)
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import MarkerStore, SampleStore


class MarkerStoreTests(unittest.TestCase):
    def test_add_returns_marker_with_id_and_fields(self):
        store = MarkerStore()
        m = store.add(100.0, "after entering event screen")
        self.assertEqual(m["ts"], 100.0)
        self.assertEqual(m["text"], "after entering event screen")
        self.assertGreater(m["id"], 0)
        self.assertIn("created", m)

    def test_ids_increment(self):
        store = MarkerStore()
        a = store.add(1.0, "a")
        b = store.add(2.0, "b")
        self.assertEqual(b["id"], a["id"] + 1)

    def test_all_sorted_by_ts(self):
        store = MarkerStore()
        store.add(300.0, "late")
        store.add(100.0, "early")
        store.add(200.0, "mid")
        self.assertEqual([m["ts"] for m in store.all()], [100.0, 200.0, 300.0])

    def test_delete_removes_and_returns_true(self):
        store = MarkerStore()
        m = store.add(1.0, "x")
        self.assertTrue(store.delete(m["id"]))
        self.assertEqual(store.all(), [])

    def test_delete_unknown_returns_false(self):
        store = MarkerStore()
        store.add(1.0, "x")
        self.assertFalse(store.delete(999))

    def test_update_changes_text_and_preserves_identity(self):
        store = MarkerStore()
        m = store.add(100.0, "old note")
        updated = store.update(m["id"], "new note")
        self.assertEqual(updated["text"], "new note")
        self.assertEqual(updated["id"], m["id"])
        self.assertEqual(updated["ts"], 100.0)
        self.assertEqual(updated["created"], m["created"])
        self.assertEqual(store.all()[0]["text"], "new note")

    def test_update_unknown_returns_none(self):
        store = MarkerStore()
        store.add(1.0, "x")
        self.assertIsNone(store.update(999, "nope"))

    def test_clear_empties_all_markers(self):
        store = MarkerStore()
        store.add(1.0, "a")
        store.add(2.0, "b")
        store.clear()
        self.assertEqual(store.all(), [])


class SampleStoreTests(unittest.TestCase):
    def test_clear_empties_history_and_latest(self):
        store = SampleStore(maxlen=10)
        store.add({"ts": 1.0})
        store.clear()
        snap = store.since(0)
        self.assertEqual(snap["samples"], [])
        self.assertIsNone(snap["latest"])

    def test_set_maxlen_keeps_most_recent_when_shrinking(self):
        store = SampleStore(maxlen=10)
        for ts in (1.0, 2.0, 3.0, 4.0, 5.0):
            store.add({"ts": ts})
        store.set_maxlen(3)
        self.assertEqual([s["ts"] for s in store.since(0)["samples"]], [3.0, 4.0, 5.0])

    def test_set_maxlen_preserves_latest(self):
        store = SampleStore(maxlen=10)
        for ts in (1.0, 2.0, 3.0):
            store.add({"ts": ts})
        store.set_maxlen(1)
        self.assertEqual(store.since(0)["latest"]["ts"], 3.0)


if __name__ == "__main__":
    unittest.main()
