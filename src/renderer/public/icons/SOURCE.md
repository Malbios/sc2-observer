# Where these icons came from

The 125 `.webp` unit and building portraits in this folder were copied from
[`stephanzlatarev/vscode-starcraft`](https://github.com/stephanzlatarev/vscode-starcraft)
(`icons/` in that repository), the VS Code extension this project studied as
prior art.

**Licensing, stated plainly:** that repository is MIT licensed, but MIT covers
its *code*. These images are almost certainly extracted StarCraft II game art,
and Blizzard's copyright in them is not something a third party's MIT licence
can grant away. Bundling them here was an explicit, informed decision by the
project owner on 2026-09-19, made after being told exactly this. It is also why
the implementation plan's §8 originally listed Blizzard art assets as a
non-goal; that entry was amended rather than quietly ignored.

If this project is ever distributed publicly, these files are the first thing
to revisit.

`minerals.png` and `vespene.png` are not from that set. They are supplied by
the project owner and stand in for the mineral-field and vespene-geyser unit
types, which have no portrait in the `.webp` set.
