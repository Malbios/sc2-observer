# Spectator telemetry emitter (Python)

Report what your bot is thinking, on the same loop axis as the game, and see it
drawn on the map beside what the game actually did.

`spectator_telemetry.py` is one file with no dependencies beyond the standard
library. Copy it into your bot. There is nothing to install and nothing to
configure, because the transport is a file: your bot appends newline-delimited
JSON, and Spectator tails it while you play or imports it afterwards.

## Quickstart

```python
from spectator_telemetry import Telemetry, circle, line, text

telemetry = Telemetry("my-bot", data_dir="./data")

async def on_step(self, iteration):
    telemetry.tick(self.state.game_loop)          # once, at the top

    telemetry.series("econ", {"minerals": self.minerals, "supply": self.supply_used})
    telemetry.event("build", "starting natural", level="info")
    telemetry.overlay("plan/expand", [circle(self.next_expansion, 6.0)])

    for worker in self.workers:
        telemetry.entity("units/task", worker.tag, task=self.task_of(worker))

# at the end of the game
telemetry.close()
```

That writes `./data/telemetry/<timestamp>-my-bot.ndjson`. In Spectator, open a
recording and use **Watch Folder...** to point at `./data/telemetry`; channels
appear in the left rail as they are first written.

`Telemetry` is also a context manager, which is the reliable way to get the
closing line written:

```python
with Telemetry("my-bot", data_dir="./data") as telemetry:
    ...
```

## The five kinds

Everything a bot can usefully report fits one of five joins. There is no sixth.

| Call | What it is for | What the viewer does with it |
| --- | --- | --- |
| `overlay(ch, shapes)` | Geometry in map coordinates | Draws it on the map, in the same transform as the units |
| `series(ch, value)` | A number per loop | Plots it, x-axis locked to the timeline |
| `event(ch, msg)` | A discrete decision or observation | Filterable log, ticks on the timeline, a map marker if positioned |
| `snapshot(ch, data)` | Any JSON document, valid right now | Collapsible tree, diffed against the previous one |
| `entity(ch, tag, ...)` | Data about one unit, keyed by its game tag | Shows in the unit inspector, and as a label beside the unit |

`ch` is a free-form channel string. Slashes make a tree
(`enemy/estimate/army`), and the app builds that tree from the strings alone.
Spectator knows nothing about your bot's architecture and never will, so name
channels for the reader rather than for your module layout.

Shapes come from helpers so a typo is a Python error rather than a line the app
rejects later: `point`, `circle`, `line`, `polyline`, `polygon`, `rect`, `text`
and `grid`.

### Things worth knowing

**Overlays replace, they do not accumulate.** Writing `plan/expand` again
replaces what was there. That is what makes "draw once per decision" cheap.
Pass `ttl=40` for content that should disappear on its own after 40 loops.

**Unchanged overlays and snapshots cost nothing.** The emitter compares the
content it is about to write against what it last wrote on that channel and
skips the write if it is identical, so calling `overlay` every step is fine.
Content with a `ttl` is always written, because the repeat is what keeps it
alive. Pass `force=True` if the repetition itself is the signal.

**Series take a number, a dict, or pairs.** `series("econ/supply", 31)` when the
channel names the series, `series("econ", {"minerals": 350, "gas": 100})` when
it does not.

**Entities are one message per unit.** Data is replaced per `(channel, tag)`,
so they cannot be batched. To have a field drawn beside the unit on the map,
name it in the channel's style: `entity("units/task", tag, style={"label":
"task"}, task="mine")`.

**Grids are for heatmaps.** A 200x200 influence map as a JSON array is 40k
numbers per update, so `grid()` base64-encodes it instead:

```python
telemetry.overlay("map/threat", [grid(values, origin=(0, 0), cell=1.0,
                                      width=200, height=200, vmin=0, vmax=10)])
```

`values` is row-major and `vmin`/`vmax` are the range you want mapped, held
fixed across updates on purpose: a map whose colours changed meaning between
loops would be actively misleading. Use `encoding="b64f32"` when the exact
number matters more than the four-fold size saving.

## When things go wrong

The emitter is meant to sit inside a decision loop, so it is built to fail
quietly rather than take the bot with it:

- **It never raises.** Pass it a NaN, a cyclic dict or an object it cannot
  serialize and the message is dropped, not thrown.
- **It never blocks** beyond a local disk write. A background thread does the
  writing; your call serializes and hands over.
- **It never grows without bound.** The queue holds `max_queued` messages
  (4096 by default) and drops past that.
- **What it drops, it counts.** The next successful write carries one `event`
  on the `_emitter` channel with the number lost, and `telemetry.dropped` has
  it too. A picture with holes you do not know about would be worse than no
  picture.
- **If it cannot open a file at all**, `telemetry.path` is `None` and every
  call is a no-op. The bot plays on.

Being killed mid-game is fine and needs no handling: the closing `end` line is
a convenience, not a requirement, and a half-written last line is discarded by
the reader. The file stops growing, and the viewer shows the last loop you
reached.

## Checking your output

Run the sample, which uses every kind and both grid encodings and is the worked
example for all of the above:

```
python sample_emitter.py --data-dir ../.. --loops 800
```

That writes into the repo's own `telemetry/` folder, which is where
**Watch Folder...** opens by default. Add `--crash` to see what an abruptly
killed bot leaves behind.

The app's parser is the authority on whether a line is acceptable. To check a
file without opening the UI, import it and read the count:

```
npm run import-telemetry -- some-game.sqlite --file data/telemetry/<file>.ndjson
```

Any line it will not take is reported with its line number and the reason.

The emitter's own behaviour is covered by `test_emitter.py`:

```
python -m unittest discover -s emitter/python
```

## Matches played elsewhere

The same file works for ladder games. Write into your bot's data directory, and
the file comes back with the match; import it against the replay afterwards.
Loop numbers are what line the file up with the game, so there is no id to pass
around and nothing to coordinate. A new game is a new file, never a marker
inside one.
