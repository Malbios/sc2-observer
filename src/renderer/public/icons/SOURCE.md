# Where these icons came from

Every icon in this folder is a `.png` supplied by the project owner.

Until 2026-09-24 the unit portraits were 125 `.webp` files copied from
[`stephanzlatarev/vscode-starcraft`](https://github.com/stephanzlatarev/vscode-starcraft),
almost certainly extracted StarCraft II game art that that repository's MIT
licence could not grant. They were bundled by an explicit, informed decision
of the project owner on 2026-09-19. All of them have since been replaced or
deleted, so none of that art ships any more. It is still in the git history.

On 2026-09-28 the whole set was replaced by the owner's new images (one per
entity, named `<race>-<unit|building>-<name>[-variant]`). Each was cropped to
its drawn area, padded to a square with transparent pixels, and downscaled to
512px, which is still twice the size the viewer ever uses. Files are named
after the unit type names the SC2 API reports, so the source names were
renamed on the way in where they differ:

- Terran: `hellbat` is `HellionTank`; `liberator-fighter_mode` is `Liberator`
  and `-defender_mode` `LiberatorAG`; `siege_tank-tank_mode` is `SiegeTank` and
  `-siege_mode` `SiegeTankSieged`; `thor-explosive_payload` is `Thor` and
  `-high_impact_mode` `ThorAP`; `viking-fighter_mode` is `VikingFighter` and
  `-assault_mode` `VikingAssault`; `<building>-flying` is `<Building>Flying`;
  `refinery-rich` is `RefineryRich` (and `assimilator-rich` `AssimilatorRich`).
- Protoss: `robotics_support_bay` is `RoboticsBay`, `templar_archives` is
  `TemplarArchive`, `stasis_ward` is `OracleStasisTrap`, `adept-shade` is
  `AdeptPhaseShift`, `disruptor-phased` is `DisruptorPhased`,
  `warp_prism-deployed` is `WarpPrismPhasing`, and `ability-forcefield` is
  `ForceField`.
- Zerg: `lurker` is `LurkerMP`, `lurker_den` `LurkerDenMP`, `swarm_host`
  `SwarmHostMP` (`SwarmHostBurrowedMP` burrowed), `nydus_worm` `NydusCanal`,
  `cocoon` the larva's `Egg`, `overseer_cocoon` `OverlordCocoon`,
  `lurker_cocoon` `LurkerMPEgg`, `overlord-ventral_sacs` `OverlordTransport`,
  `locust-landed` `LocustMP`, `locust-flying` `LocustMPFlying`,
  `infested_marine` `InfestorTerran` and `infested_swarm_egg`
  `InfestedTerransEgg`.
- Neutral: `mineral_field`, `mineral_field_rich`, `vespene_geyser`,
  `vespene_geyser-rich` and `destructible_rocks` became `minerals.png`,
  `richminerals.png`, `vespene.png`, `richvespene.png` and `rocks.png`, each
  standing in for every type of its kind; `xel_naga_watchtower` is
  `XelNagaTower` and `inhibitor_zone_generator` `InhibitorZoneSmall`.

The `<Unit>Hallucination.png` files (the unit with an eye badge) are what a
Sentry can hallucinate, drawn only when the recording's viewpoint knows the
unit is one. `Hallucination.png` is the badge alone (the owner's
`icon-hallucination`), for the unit inspector.
