"""Spectator telemetry emitter (plan section 3).

One file, standard library only, meant to be vendored straight into a bot.
It writes newline-delimited JSON to

    <data dir>/telemetry/<start timestamp>-<name>.ndjson

which Spectator tails locally and imports afterwards for matches played
elsewhere. The file is the contract; this module is a convenience wrapper
around the envelope in section 3.2, and a bot that would rather write the JSON
itself loses nothing.

Three promises, in order of importance, because a debugging aid that can take
the bot down with it is worse than no debugging aid:

1. It never raises. Every public method swallows its own errors. A bot that
   passes nonsense gets a dropped message and a counted warning, never an
   exception in the middle of its decision loop.
2. It never blocks beyond a local disk write. Messages are serialized in the
   calling thread (cheap, and it snapshots the data so a dict the bot mutates
   afterwards cannot corrupt what was reported) and handed to a background
   thread that does the writing.
3. It never grows without bound. The queue has a fixed size. When it is full
   the message is dropped and counted, and the next successful write carries
   one `event` on the `_emitter` channel saying how many were lost. Silent
   loss would be the worst outcome: you would debug the bot using a picture
   with holes in it and not know.

Usage:

    from spectator_telemetry import Telemetry, circle, text

    telemetry = Telemetry("my-bot", data_dir="./data")
    ...
    telemetry.tick(iteration)                      # the current game loop
    telemetry.series("econ", {"minerals": 350})
    telemetry.overlay("plan/expand", [circle((42.5, 31.0), 6.0)])
    telemetry.event("plan", "expanding to natural", level="info")
    ...
    telemetry.close()

`Telemetry` is also a context manager, which is the reliable way to get the
closing `end` line written.
"""

from __future__ import annotations

import array
import base64
import json
import os
import queue
import sys
import threading
from datetime import datetime, timezone

__all__ = [
    "Telemetry",
    "SCHEMA_VERSION",
    "point",
    "circle",
    "line",
    "polyline",
    "polygon",
    "rect",
    "text",
    "grid",
]

SCHEMA_VERSION = 1
EMITTER = "spectator-python/1"

#: Where this module reports its own problems. The leading underscore marks it
#: as coming from the plumbing rather than from the bot, the same way section
#: 3.6 reserves `_game/` for the game's own debug draws.
EMITTER_CHANNEL = "_emitter"

#: Messages held in memory before dropping. At roughly a dozen messages per
#: loop this is several seconds of slack, which covers a slow disk without
#: letting a stalled writer turn into unbounded memory use.
DEFAULT_MAX_QUEUED = 4096

#: Section 3.4: "rounds floats to limit volume". Map coordinates matter to
#: about a hundredth of a cell; past that it is bytes with no picture in them.
DEFAULT_FLOAT_DIGITS = 2

#: The closed set from section 3.3.
_LEVELS = ("debug", "info", "warn", "error")

#: Guards against a self-referential structure turning into a RecursionError
#: inside the bot's loop. Anything deeper is reported as a string.
_MAX_DEPTH = 12

_STOP = object()


# -- shape helpers ----------------------------------------------------------
#
# Section 3.3 names the vocabulary; the field spellings are pinned by
# src/shared/telemetry-types.ts, which the viewer compiles against. These
# helpers exist so a typo is a Python error here rather than a rejected line
# discovered later in the app.


def _xy(pos):
    return [pos[0], pos[1]]


def point(pos):
    return {"type": "point", "pos": _xy(pos)}


def circle(pos, r):
    return {"type": "circle", "pos": _xy(pos), "r": r}


def line(start, end):
    return {"type": "line", "from": _xy(start), "to": _xy(end)}


def polyline(points):
    return {"type": "polyline", "points": [_xy(p) for p in points]}


def polygon(points):
    return {"type": "polygon", "points": [_xy(p) for p in points]}


def rect(corner0, corner1):
    return {"type": "rect", "p0": _xy(corner0), "p1": _xy(corner1)}


def text(pos, label):
    return {"type": "text", "pos": _xy(pos), "text": str(label)}


def grid(values, origin, cell, width, height, encoding="b64u8", vmin=0.0, vmax=1.0):
    """A heatmap or influence map.

    Section 3.3: a 200x200 grid as a JSON array is 40k numbers per update, so
    the values go out base64-encoded and the viewer reconstructs each cell as
    `offset + raw * scale`. `b64u8` quantizes to a byte, which is four times
    smaller than `b64f32` and plenty for something that ends up as an alpha
    value; use `b64f32` when the exact number matters.

    `values` is row-major, `width * height` long, and is clamped into
    [vmin, vmax] for the u8 encoding rather than rescaled per update: a map
    whose colours changed meaning between loops would be actively misleading.
    """
    count = int(width) * int(height)
    flat = list(values)[:count]
    flat.extend([vmin] * (count - len(flat)))

    shape = {
        "type": "grid",
        "origin": _xy(origin),
        "cell": cell,
        "w": int(width),
        "h": int(height),
        "enc": encoding,
    }

    if encoding == "b64f32":
        # The viewer reads these little-endian, so a big-endian host has to
        # swap before encoding.
        packed = array.array("f", [float(v) for v in flat])
        if sys.byteorder != "little":
            packed.byteswap()
        shape["values"] = base64.b64encode(packed.tobytes()).decode("ascii")
        shape["scale"] = 1.0
        shape["offset"] = 0.0
        return shape

    span = float(vmax) - float(vmin)
    if span <= 0:
        span = 1.0
    raw = bytearray(count)
    for i, value in enumerate(flat):
        scaled = int(round((float(value) - float(vmin)) / span * 255.0))
        raw[i] = 0 if scaled < 0 else (255 if scaled > 255 else scaled)
    shape["values"] = base64.b64encode(bytes(raw)).decode("ascii")
    shape["scale"] = span / 255.0
    shape["offset"] = float(vmin)
    return shape


# -- emitter ----------------------------------------------------------------


class Telemetry(object):
    """Writes one game's telemetry file. Create one per game, not per bot."""

    def __init__(
        self,
        name,
        data_dir=".",
        meta=None,
        channels=None,
        max_queued=DEFAULT_MAX_QUEUED,
        float_digits=DEFAULT_FLOAT_DIGITS,
    ):
        self.name = _safe_name(name)
        self.float_digits = float_digits
        self.path = None

        self._queue = queue.Queue(maxsize=max_queued)
        self._lock = threading.Lock()
        self._seq = 0
        self._loop = 0
        self._dropped = 0
        self._last_payload = {}
        self._closed = False
        self._handle = None

        try:
            directory = os.path.join(data_dir, "telemetry")
            os.makedirs(directory, exist_ok=True)
            # Colons are not legal in Windows filenames, so the ISO stamp is
            # trimmed rather than used verbatim.
            stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
            self.path = os.path.join(directory, "%s-%s.ndjson" % (stamp, self.name))
            self._handle = open(self.path, "a", encoding="utf-8", newline="\n")
        except Exception:
            # A bot with nowhere to write must still run. Every emit from here
            # on is a no-op, and `path` stays None so the caller can notice.
            self._handle = None
            self._closed = True
            return

        # Daemon, so forgetting to close cannot keep the process alive.
        self._thread = threading.Thread(target=self._run, name="spectator-telemetry", daemon=True)
        self._thread.start()

        # Section 3.4: the first line is `hello`, written on open. Channel
        # pre-declaration is optional, and undeclared channels appear on first
        # use, so this is display hints rather than a schema.
        self._emit(
            "hello",
            data={
                "emitter": EMITTER,
                "name": self.name,
                "meta": meta or {},
                "channels": list(channels or []),
            },
        )

    # -- lifecycle ----------------------------------------------------------

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close("error" if exc_type else "closed")
        return False

    def tick(self, loop):
        """Sets the loop later messages are stamped with.

        Section 3.2: the loop is the only time axis, never wall-clock. Call it
        once at the top of the bot's step and the rest of the calls need no
        loop argument.
        """
        try:
            self._loop = max(0, int(loop))
        except Exception:
            pass

    def close(self, reason="closed"):
        """Writes the closing `end` line and stops the writer thread.

        Absence of `end` is not an error (section 3.4), so a bot that is killed
        mid-game still produces a readable file; this only makes a clean
        shutdown legible as one.
        """
        with self._lock:
            if self._closed:
                return
            self._closed = True

        self._emit("end", data={"reason": reason, "loop": self._loop}, force_open=True)
        try:
            self._queue.put_nowait(_STOP)
        except queue.Full:
            pass
        try:
            # Bounded: a writer wedged on a dead network drive must not become
            # the reason the bot fails to exit.
            self._thread.join(timeout=5.0)
        except Exception:
            pass

    @property
    def dropped(self):
        """Messages lost so far, to queue pressure or write failure."""
        with self._lock:
            return self._dropped

    # -- the five kinds -----------------------------------------------------

    def overlay(self, ch, shapes, style=None, ttl=None, loop=None, force=False):
        """Geometry in map coordinates, replacing this channel's last content.

        Section 3.4 asks the helper to emit only when the content changed, so a
        bot can call this every step without the cost of writing every step.
        Pass `force=True` for a channel whose repetition is the signal, and
        `ttl` for content that should expire on its own after N loops.

        Content with a `ttl` is never deduplicated. The same shapes at a later
        loop are a different statement there -- "still true now" -- and
        suppressing the repeat would let the channel expire while the bot
        believed it was keeping it alive.
        """
        self._emit(
            "overlay",
            ch=ch,
            loop=loop,
            data=list(shapes),
            style=style,
            ttl=ttl,
            dedupe=None if (force or ttl is not None) else ("overlay", ch),
        )

    def series(self, ch, value, loop=None):
        """A number per loop, or several named ones.

        Accepts a bare number (the channel names the series), a dict of
        name to value, or a list of {"name", "value"} pairs.
        """
        self._emit("series", ch=ch, loop=loop, data=_series_payload(value))

    def event(self, ch, msg, level="info", data=None, pos=None, loop=None):
        """A discrete log entry, optionally pinned to a map position."""
        # A typo in `level` would cost the whole message at the other end, and
        # the message is the part worth keeping, so it is coerced rather than
        # rejected. `ch` and `ttl` are deliberately not: a wrong value there
        # means the bot meant something else, and the app names the reason.
        payload = {"msg": str(msg), "level": level if level in _LEVELS else "info"}
        if data is not None:
            payload["data"] = data
        if pos is not None:
            payload["pos"] = _xy(pos)
        self._emit("event", ch=ch, loop=loop, data=payload)

    def snapshot(self, ch, data, loop=None, force=False):
        """The whole of something right now, diffed against the previous one."""
        self._emit("snapshot", ch=ch, loop=loop, data=data, dedupe=None if force else ("snapshot", ch))

    def entity(self, ch, tag, data=None, style=None, loop=None, **fields):
        """Data attached to one unit, keyed by the game's own tag.

        One message per (channel, tag): section 3.3 replaces per tag, not per
        channel, so these cannot be batched. The channel's `style.label` names
        the field the viewer draws beside the unit on the map.
        """
        payload = dict(data or {})
        payload.update(fields)
        payload["tag"] = tag
        self._emit("entity", ch=ch, loop=loop, data=payload, style=style)

    # -- internals ----------------------------------------------------------

    def _emit(self, kind, ch=None, loop=None, data=None, style=None, ttl=None, dedupe=None, force_open=False):
        if self._handle is None:
            return
        if self._closed and not force_open:
            return

        try:
            payload = json.dumps(
                _prepare(data, self.float_digits, 0),
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            )

            # Change detection compares the serialized payload, which is exact
            # and costs nothing extra: it has to be serialized either way.
            # Style is part of the comparison because a channel redrawn in a
            # different colour has changed, even when its geometry has not.
            if dedupe is not None:
                current = payload if style is None else payload + json.dumps(style, sort_keys=True, default=str)
                with self._lock:
                    if self._last_payload.get(dedupe) == current:
                        return
                    self._last_payload[dedupe] = current

            with self._lock:
                self._seq += 1
                head = {"v": SCHEMA_VERSION, "kind": kind, "seq": self._seq}
                if kind not in ("hello", "end"):
                    head["loop"] = self._loop if loop is None else max(0, int(loop))
                    head["ch"] = str(ch)
            if style:
                head["style"] = style
            if ttl is not None:
                head["ttl"] = ttl

            line = _splice(head, payload)
        except Exception:
            # Unserializable payloads (a NaN, a live object, a cycle) are
            # dropped rather than written as something that would be rejected
            # line by line at the other end.
            self._count_drop()
            return

        try:
            self._queue.put_nowait(line)
        except queue.Full:
            self._count_drop()

    def _count_drop(self):
        with self._lock:
            self._dropped += 1

    def _take_dropped(self):
        with self._lock:
            dropped = self._dropped
            self._dropped = 0
            return dropped

    def _drop_report(self):
        """One `event` carrying the count of what was lost (section 3.4)."""
        dropped = self._take_dropped()
        if not dropped:
            return None
        with self._lock:
            self._seq += 1
            head = {"v": SCHEMA_VERSION, "kind": "event", "seq": self._seq, "loop": self._loop, "ch": EMITTER_CHANNEL}
        payload = json.dumps(
            {
                "msg": "dropped %d telemetry message(s)" % dropped,
                "level": "warn",
                "data": {"dropped": dropped},
            },
            separators=(",", ":"),
            sort_keys=True,
        )
        return _splice(head, payload)

    def _run(self):
        """The writer thread. Everything it can do wrong, it does quietly."""
        while True:
            item = self._queue.get()
            stopping = item is _STOP

            batch = [] if stopping else [item]
            # Take whatever else is already waiting, so a busy loop costs one
            # write and one flush rather than one of each per message.
            while not stopping:
                try:
                    nxt = self._queue.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP:
                    stopping = True
                    break
                batch.append(nxt)

            report = self._drop_report()
            if report is not None:
                batch.append(report)

            if batch:
                try:
                    self._handle.write("\n".join(batch) + "\n")
                    # Section 3.4: flushed so the tailer sees whole lines
                    # promptly. Without this the OS buffer would hold a loop's
                    # worth of decisions for as long as it felt like.
                    self._handle.flush()
                except Exception:
                    # Disk full, folder deleted, handle closed underneath us:
                    # the bot keeps playing either way.
                    with self._lock:
                        self._dropped += len(batch)

            if stopping:
                try:
                    self._handle.close()
                except Exception:
                    pass
                return


# -- serialization ----------------------------------------------------------


def _splice(head, payload):
    """Joins a serialized envelope to an already-serialized payload.

    The payload is serialized first so change detection can compare it, and
    `json.dumps` of a non-empty dict always ends in `}`, so replacing that with
    the data member is exact and saves serializing the payload twice.
    """
    return json.dumps(head, allow_nan=False, separators=(",", ":"))[:-1] + ',"data":' + payload + "}"


def _series_payload(value):
    if isinstance(value, dict):
        return [{"name": str(name), "value": number} for name, number in value.items()]
    if isinstance(value, (list, tuple)):
        return [dict(pair) if isinstance(pair, dict) else {"name": str(pair[0]), "value": pair[1]} for pair in value]
    return value


def _safe_name(name):
    """The name ends up in a filename, so it cannot carry a path."""
    cleaned = "".join(ch if (ch.isalnum() or ch in "-_.") else "-" for ch in str(name)).strip("-.")
    return cleaned or "bot"


def _prepare(value, digits, depth):
    """Rounds floats and makes anything unexpected serializable.

    Bots hand telemetry whatever they happen to have: a numpy scalar, a Point2
    from their own library, an enum. None of that is worth an exception in the
    middle of a game, so it is coerced here and the picture stays honest about
    what it could not represent.
    """
    if depth > _MAX_DEPTH:
        return str(value)
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return value
    if isinstance(value, float):
        return _round(value, digits)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return {str(key): _prepare(item, digits, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_prepare(item, digits, depth + 1) for item in value]
    if hasattr(value, "__float__"):
        try:
            return _round(float(value), digits)
        except Exception:
            pass
    return str(value)


def _round(value, digits):
    """Rounds for volume, but never rounds something away entirely.

    Two decimal places is right for map coordinates, which is what section 3.4
    has in mind, and catastrophic for a small number that means something: a
    grid's scale factor of 1/255 becomes 0.0 and takes the whole heatmap with
    it, and a bot reporting a probability of 0.004 gets a flat zero. Anything
    that would round to nothing is left exactly as it came in; there are few
    enough of them that the volume argument does not apply.
    """
    rounded = round(value, digits)
    if rounded == 0.0 and value != 0.0:
        return value
    return rounded
