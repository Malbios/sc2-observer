"""Checks the three promises the emitter makes to a bot.

It never raises, it never grows without bound, and what it loses it counts.
Those are the properties a bot author is trusting when they put this inside a
decision loop, so they get tested rather than asserted in a docstring.

The JSON contract itself is checked on the other side: import a file with
`npm run import-telemetry` and the app's own parser reports any line it will
not accept, per-line and with a reason.

    python -m unittest discover -s emitter/python
"""

import json
import math
import os
import shutil
import tempfile
import unittest

from spectator_telemetry import Telemetry, circle, grid, point

FIVE_KINDS = ("overlay", "series", "event", "snapshot", "entity")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class EmitterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="spectator-emitter-")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def emitter(self, **kwargs):
        telemetry = Telemetry("test-bot", data_dir=self.dir, **kwargs)
        self.addCleanup(telemetry.close)
        return telemetry

    # -- the file ----------------------------------------------------------

    def test_hello_is_the_first_line(self):
        telemetry = self.emitter(meta={"git": "abc123"}, channels=[{"ch": "econ", "kind": "series"}])
        telemetry.close()

        messages = read(telemetry.path)
        self.assertEqual(messages[0]["kind"], "hello")
        self.assertEqual(messages[0]["data"]["meta"]["git"], "abc123")
        self.assertEqual(messages[-1]["kind"], "end")

    def test_the_name_cannot_escape_the_folder(self):
        telemetry = Telemetry("../../etc/passwd", data_dir=self.dir)
        self.addCleanup(telemetry.close)
        self.assertEqual(os.path.dirname(telemetry.path), os.path.join(self.dir, "telemetry"))

    def test_all_five_kinds_round_trip(self):
        telemetry = self.emitter()
        telemetry.tick(120)
        telemetry.overlay("plan", [circle((10.0, 20.0), 3.0), point((1.0, 2.0))])
        telemetry.series("econ", {"minerals": 350})
        telemetry.event("log", "expanding", level="warn", pos=(5.0, 6.0))
        telemetry.snapshot("plan/state", {"objective": "expand"})
        telemetry.entity("units/tasks", 4300603393, task="mine")
        telemetry.close()

        by_kind = {}
        for message in read(telemetry.path):
            by_kind.setdefault(message["kind"], []).append(message)

        for kind in FIVE_KINDS:
            self.assertIn(kind, by_kind, "%s was not written" % kind)
            self.assertEqual(by_kind[kind][0]["loop"], 120)

        self.assertEqual(by_kind["series"][0]["data"], [{"name": "minerals", "value": 350}])
        self.assertEqual(by_kind["event"][0]["data"]["level"], "warn")
        self.assertEqual(by_kind["entity"][0]["data"]["tag"], 4300603393)

    def test_seq_is_monotonic(self):
        telemetry = self.emitter()
        for loop in range(0, 100, 8):
            telemetry.tick(loop)
            telemetry.series("econ", loop)
        telemetry.close()

        seqs = [message["seq"] for message in read(telemetry.path)]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))

    # -- section 3.4: emit only when the content changed --------------------

    def test_unchanged_overlays_are_not_rewritten(self):
        telemetry = self.emitter()
        for loop in range(0, 80, 8):
            telemetry.tick(loop)
            telemetry.overlay("plan", [circle((10.0, 20.0), 3.0)])
        telemetry.close()

        overlays = [m for m in read(telemetry.path) if m["kind"] == "overlay"]
        self.assertEqual(len(overlays), 1)

    def test_a_changed_style_counts_as_a_change(self):
        telemetry = self.emitter()
        telemetry.overlay("plan", [circle((10.0, 20.0), 3.0)], style={"color": "#ff0000"})
        telemetry.overlay("plan", [circle((10.0, 20.0), 3.0)], style={"color": "#00ff00"})
        telemetry.close()

        overlays = [m for m in read(telemetry.path) if m["kind"] == "overlay"]
        self.assertEqual(len(overlays), 2)

    def test_expiring_overlays_are_always_rewritten(self):
        # Identical content at a later loop says "still true now", which is a
        # different statement; suppressing it would let the ttl run out.
        telemetry = self.emitter()
        for loop in range(0, 80, 8):
            telemetry.tick(loop)
            telemetry.overlay("contact", [point((50.0, 50.0))], ttl=40)
        telemetry.close()

        overlays = [m for m in read(telemetry.path) if m["kind"] == "overlay"]
        self.assertEqual(len(overlays), 10)
        self.assertTrue(all(m["ttl"] == 40 for m in overlays))

    # -- section 3.4: rounds floats to limit volume -------------------------

    def test_coordinates_are_rounded(self):
        telemetry = self.emitter()
        telemetry.overlay("plan", [point((10.123456, 20.987654))])
        telemetry.close()

        shape = [m for m in read(telemetry.path) if m["kind"] == "overlay"][0]["data"][0]
        self.assertEqual(shape["pos"], [10.12, 20.99])

    def test_rounding_never_destroys_a_small_value(self):
        # A grid's scale factor and a probability are both smaller than the
        # rounding step, and both mean nothing at all once they are zero.
        telemetry = self.emitter()
        telemetry.series("confidence", 0.004)
        telemetry.close()

        series = [m for m in read(telemetry.path) if m["kind"] == "series"][0]
        self.assertEqual(series["data"], 0.004)

    def test_a_grid_survives_its_own_encoding(self):
        values = [i / 575.0 for i in range(576)]
        telemetry = self.emitter()
        telemetry.overlay("threat", [grid(values, origin=(0.0, 0.0), cell=2.0, width=24, height=24)])
        telemetry.close()

        shape = [m for m in read(telemetry.path) if m["kind"] == "overlay"][0]["data"][0]
        import base64

        raw = base64.b64decode(shape["values"])
        decoded = [shape["offset"] + byte * shape["scale"] for byte in raw]
        self.assertEqual(len(decoded), 576)
        # Within half a quantization step, which is all a byte can promise.
        worst = max(abs(a - b) for a, b in zip(decoded, values))
        self.assertLess(worst, 1.0 / 255 / 2 + 1e-9)

    # -- the promises -------------------------------------------------------

    def test_nothing_a_bot_can_pass_raises(self):
        telemetry = self.emitter()
        cycle = {}
        cycle["self"] = cycle

        class Opaque(object):
            pass

        # None of these can be represented, and none of them may interrupt the
        # bot: each is dropped and counted instead.
        telemetry.series("econ", float("nan"))
        telemetry.series("econ", float("inf"))
        telemetry.snapshot("plan", cycle)
        telemetry.snapshot("plan", Opaque())
        telemetry.overlay("plan", [circle((float("nan"), 1.0), 2.0)])
        telemetry.event("log", "fine", level="not-a-level")
        telemetry.tick("not a loop")
        telemetry.close()

        messages = read(telemetry.path)
        self.assertTrue(all("kind" in message for message in messages))
        # The one that was salvageable got through, with its level coerced.
        events = [m for m in messages if m["kind"] == "event" and m["ch"] == "log"]
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["data"]["level"], "info")

    def test_what_is_dropped_is_counted_and_reported(self):
        telemetry = self.emitter()
        telemetry.series("econ", float("nan"))
        self.assertEqual(telemetry.dropped, 1)

        telemetry.event("log", "after the drop")
        telemetry.close()

        reports = [m for m in read(telemetry.path) if m.get("ch") == "_emitter"]
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["data"]["data"]["dropped"], 1)
        self.assertEqual(reports[0]["data"]["level"], "warn")

    def test_nothing_is_lost_without_being_counted(self):
        # The conservation law that makes the queue bound safe: everything
        # emitted is either in the file or in a drop count. A tiny queue makes
        # drops likely; the test does not care whether any happened, only that
        # none went missing quietly.
        # hello and end are messages too, and under queue pressure they can be
        # dropped like any other, so they count towards the total.
        total = 500 + 2
        telemetry = self.emitter(max_queued=1)
        for index in range(500):
            telemetry.tick(index)
            telemetry.series("econ", index)
        telemetry.close()

        messages = read(telemetry.path)
        written = len([m for m in messages if m.get("ch") != "_emitter"])
        reported = sum(m["data"]["data"]["dropped"] for m in messages if m.get("ch") == "_emitter")
        self.assertEqual(written + reported + telemetry.dropped, total)

    def test_closing_twice_is_safe(self):
        telemetry = self.emitter()
        telemetry.series("econ", 1)
        telemetry.close()
        telemetry.close()

        ends = [m for m in read(telemetry.path) if m["kind"] == "end"]
        self.assertEqual(len(ends), 1)

    def test_emitting_after_close_is_ignored(self):
        telemetry = self.emitter()
        telemetry.close()
        telemetry.series("econ", 1)

        self.assertEqual([m for m in read(telemetry.path) if m["kind"] == "series"], [])

    def test_an_unwritable_directory_is_survivable(self):
        # The bot has to keep playing when telemetry cannot be written at all.
        blocker = os.path.join(self.dir, "blocked")
        with open(blocker, "w", encoding="utf-8") as handle:
            handle.write("not a directory")

        telemetry = Telemetry("test-bot", data_dir=blocker)
        self.assertIsNone(telemetry.path)
        telemetry.tick(10)
        telemetry.series("econ", 1)
        telemetry.close()
        self.assertFalse(math.isnan(telemetry.dropped))


if __name__ == "__main__":
    unittest.main()
