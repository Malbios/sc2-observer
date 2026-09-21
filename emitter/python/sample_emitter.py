"""Writes a telemetry file with no game behind it.

This is the exit criterion for the telemetry phase: point Spectator's "Watch
Folder..." at the folder this writes into, run it, and the file should render
while it is being written and read back the same way after a reload. Run it
with `--crash` and the viewer should sit on the last complete loop rather than
break.

It is also the worked example for the emitter API, so it uses every one of the
five kinds and both grid encodings.

    python sample_emitter.py --data-dir ../.. --loops 800

That writes into `<data dir>/telemetry/`, which for the command above is the
repo's own `telemetry/` folder, the one the watch picker opens on.
"""

import argparse
import math
import os
import random
import time

from spectator_telemetry import Telemetry, circle, grid, line, point, polyline, rect, text

#: A pretend map, in the same coordinate frame a real bot would report: SC2
#: map coordinates, y up.
MAP_SIZE = 64.0
OUR_BASE = (14.0, 16.0)
ENEMY_BASE = (50.0, 48.0)

#: Cells per side of the influence map. Small enough to read, big enough that
#: the compact encoding is doing real work.
GRID_SIZE = 24

TASKS = ["mine", "scout", "defend", "build", "idle"]
LEVELS = ["debug", "info", "warn", "error"]

#: Fake unit tags. A real bot uses the game's own tags, which is what joins
#: entity data to the units on the map.
TAGS = [4300603393 + index * 256 for index in range(8)]

CHANNELS = [
    {"ch": "econ", "kind": "series", "label": "Economy"},
    {"ch": "econ/supply", "kind": "series", "label": "Supply used", "range": [0, 200]},
    {"ch": "plan/shapes", "kind": "overlay", "label": "Plan", "visible": True},
    {"ch": "map/threat", "kind": "overlay", "label": "Threat", "visible": False},
    {"ch": "map/scan", "kind": "overlay", "label": "Scan", "visible": False},
    {"ch": "plan/contact", "kind": "overlay", "label": "Contact", "visible": True},
    {"ch": "log", "kind": "event", "label": "Decisions"},
    {"ch": "plan/state", "kind": "snapshot", "label": "Plan state"},
    {"ch": "units/tasks", "kind": "entity", "label": "Unit tasks"},
]


def threat_values(loop):
    """An influence map that moves, so consecutive updates differ visibly."""
    phase = loop / 200.0
    return [
        0.5 + 0.5 * math.sin((x + y) * 0.35 + phase)
        for y in range(GRID_SIZE)
        for x in range(GRID_SIZE)
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default=".", help="telemetry/ is created inside this")
    parser.add_argument("--name", default="sample", help="the bot's own name for itself")
    parser.add_argument("--loops", type=int, default=1000, help="last game loop to emit")
    parser.add_argument("--step", type=int, default=8, help="loops per step, as a bot on step 8 would")
    parser.add_argument("--delay", type=float, default=0.08, help="seconds per step, so a tailer sees it grow")
    parser.add_argument("--crash", action="store_true", help="exit abruptly halfway, without an end line")
    args = parser.parse_args()

    telemetry = Telemetry(
        args.name,
        data_dir=args.data_dir,
        meta={"sample": True, "pid": os.getpid()},
        channels=CHANNELS,
    )
    if telemetry.path is None:
        print("could not open a telemetry file; nothing was written")
        return
    print("writing %s" % telemetry.path)

    random.seed(7)
    minerals, vespene, supply, army = 50, 0, 12, 0
    revision = 0
    step = 0
    loop = 0

    while loop <= args.loops:
        telemetry.tick(loop)

        minerals = max(0, minerals + random.randint(-40, 70))
        vespene = max(0, vespene + random.randint(-10, 25))
        supply = min(200, supply + (1 if step % 3 == 0 else 0))
        army = max(0, army + (1 if step % 7 == 0 else 0))

        telemetry.series("econ", {"minerals": minerals, "vespene": vespene, "army": army})
        telemetry.series("econ/supply", supply)

        # An overlay that changes every step. The emitter compares content, so
        # a channel that did not change costs nothing to re-send.
        angle = loop / 120.0
        scout = (
            OUR_BASE[0] + 20.0 * math.cos(angle),
            OUR_BASE[1] + 20.0 * math.sin(angle),
        )
        telemetry.overlay(
            "plan/shapes",
            [
                circle(OUR_BASE, 6.0),
                rect((OUR_BASE[0] - 9, OUR_BASE[1] - 9), (OUR_BASE[0] + 9, OUR_BASE[1] + 9)),
                line(OUR_BASE, ENEMY_BASE),
                polyline([OUR_BASE, scout, ENEMY_BASE]),
                point(scout),
                text((OUR_BASE[0], OUR_BASE[1] + 11), "loop %d" % loop),
            ],
            style={"color": "#4fc3f7", "width": 1.5},
        )

        # The same overlay sent every step but unchanged: proof the comparison
        # is doing its job, since this writes exactly once for the whole run.
        telemetry.overlay("map/scan", [circle(ENEMY_BASE, 13.0)], style={"color": "#8b93a1", "opacity": 0.4})

        if step % 3 == 0:
            telemetry.overlay(
                "map/threat",
                [
                    grid(
                        threat_values(loop),
                        origin=(0.0, 0.0),
                        cell=MAP_SIZE / GRID_SIZE,
                        width=GRID_SIZE,
                        height=GRID_SIZE,
                        encoding="b64f32" if step % 6 == 0 else "b64u8",
                    )
                ],
                style={"opacity": 0.5, "z": -1},
            )

        if step % 5 == 0:
            index = step // 5
            # Expires on its own after 40 loops, so it fades without the bot
            # having to remember to clear it.
            telemetry.overlay("plan/contact", [point(ENEMY_BASE)], ttl=40, style={"color": "#ff7043"})
            telemetry.event(
                "log",
                "step %d: %d minerals, %d supply" % (step, minerals, supply),
                level=LEVELS[index % len(LEVELS)],
                data={"step": step, "minerals": minerals},
                pos=OUR_BASE if index % 2 == 0 else None,
            )

        if step % 10 == 0:
            revision += 1
            telemetry.snapshot(
                "plan/state",
                {
                    "revision": revision,
                    "objective": "expand" if revision % 2 == 0 else "defend",
                    "queue": TASKS[revision % len(TASKS) :],
                    "resources": {"minerals": minerals, "vespene": vespene},
                },
            )

        if step % 2 == 0:
            # One message per (channel, tag): section 3.3 replaces per tag.
            # style.label picks which field is drawn beside the unit.
            for index, tag in enumerate(TAGS):
                telemetry.entity(
                    "units/tasks",
                    tag,
                    style={"label": "task"},
                    task=TASKS[(index + step) % len(TASKS)],
                    priority=(index % 3) + 1,
                    since=loop,
                )

        if args.crash and loop >= args.loops // 2:
            print("exiting abruptly at loop %d, no end line" % loop)
            # Not close(): the point is to leave the file as a killed bot would,
            # very possibly mid-line.
            os._exit(1)

        step += 1
        loop += args.step
        if args.delay > 0:
            time.sleep(args.delay)

    telemetry.close("finished")
    print("wrote up to loop %d, %d message(s) dropped" % (loop - args.step, telemetry.dropped))


if __name__ == "__main__":
    main()
