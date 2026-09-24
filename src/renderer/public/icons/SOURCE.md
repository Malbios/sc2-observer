# Where these icons came from

Every icon in this folder is a `.png` supplied by the project owner.

Until 2026-09-24 the unit portraits were 125 `.webp` files copied from
[`stephanzlatarev/vscode-starcraft`](https://github.com/stephanzlatarev/vscode-starcraft),
almost certainly extracted StarCraft II game art that that repository's MIT
licence could not grant. They were bundled by an explicit, informed decision
of the project owner on 2026-09-19. All of them have since been replaced or
deleted (the last four, `MothershipCore`, `PointDefenseDrone`, `Viking` and
`InfestedTerran`, were types a 4.10 game never shows), so none of that art
ships any more. It is still in the git history.

`minerals.png` and `vespene.png` stand in for every mineral-field and
vespene-geyser type.

The Zerg `.png` files (units and buildings, 43 of them) were supplied by the
project owner on 2026-09-23. They are named after the unit type names the SC2 API reports (so
`LurkerMP`, `SwarmHostMP` and `NydusCanal`, not the display names), and were
downscaled from 1254px to 512px, which is still twice the size the viewer
ever uses.

The Terran `.png` files (42) followed on 2026-09-24, processed the same way.
Their source names differ from the API's in places: `surveillance_station` is
`OrbitalCommand`, `sensor_dome` is `SensorTower`, `hellion_battle_mode` (the
Hellbat) is `HellionTank`, and `liberator_aa_mode` is plain `Liberator`.

The Protoss `.png` files (39) followed the same day. Renamed on the way in:
`robotics_support_bay` is `RoboticsBay`, `templar_archives` is
`TemplarArchive` (singular in the API), `stasis_ward` is `OracleStasisTrap`,
`psionic_transfer` is the Adept's shade `AdeptPhaseShift`,
`purification_nova` is the Disruptor's ball `DisruptorPhased`, and `warp_ray`
(the Void Ray's beta name) is `VoidRay`.

The 13 `<Unit>Hallucination.png` files (the unit with an eye badge) are what a
Sentry can hallucinate, drawn only when the recording's viewpoint knows the
unit is one. `Hallucination.png` is the badge alone, for the unit inspector,
and `ForceField.png` is the Sentry's force field.
