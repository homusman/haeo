# HAEO Homusman plan acceptance preview

This HACS prerelease is for the separate `haeo_homusman` hub in shadow use. Keep the dispatcher connected to the vanilla HAEO hub. Install by selecting `v0.5.4b2` explicitly in HACS, restart Core and reload the Homusman Lovelace card.

- This update fixes a setup error in the coordinator and gives the fork?s cards distinct names in the card picker.
- The earlier battery-power deviation penalty has been removed. Its saved settings have no effect.
- Under the Homusman hub's advanced options, enable the plan acceptance gate to compare against a strict, same-input LP solve that holds modeled first-interval grid and battery net power. The default threshold is 0.02 in the model's currency, and the same-action deadband is 0.1 kW. The gate and tariff weighting both default off.
- Tariff weighting shrinks forecast deviations around separate three-hour exponential baselines. The first interval retains its original tariff. The modeled benefit uses the objective selected for the current solve.
- The forecast card shows accepted outputs by default. An administrator can view the newest candidate or select a prior accepted plan on the same chart. The archive is per hub, local and bounded by size and time. The next successful solve after restart bootstraps a fresh active plan. Archived plans are available for review.

The historic view in this preview selects one original plan at a time. Recorder overlays, a stitched past timeline, hover-to-compare, raw-market benefit and active-plan recovery across restart are outside this build. The gate compares model net power. Native inverter modes and physical responses require independent validation before the fork feeds dispatch.

For rollback, select the previous Homusman version in HACS, restart Core and reload the card.

