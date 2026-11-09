# HAEO Homusman plan acceptance preview

This HACS prerelease is for the separate `haeo_homusman` hub in shadow use. Keep the dispatcher connected to the vanilla HAEO hub. Install by selecting `v0.5.4b3` explicitly in HACS, restart Core and reload the Homusman Lovelace card.

- This update fixes a setup error in the coordinator and gives the fork?s cards distinct names in the card picker.
- The earlier battery-power deviation penalty has been removed. Its saved settings have no effect.
- Under the Homusman hub's advanced options, enable the plan acceptance gate to compare against a strict, same-input LP solve that holds modeled first-interval grid and battery net power. The default threshold is 0.02 in the model's currency, and the same-action deadband is 0.1 kW. The gate and tariff weighting both default off.
- Tariff weighting shrinks forecast deviations around separate three-hour exponential baselines. The first interval retains its original tariff. The modeled benefit uses the objective selected for the current solve.
- The forecast card shows accepted outputs by default. An administrator can use the Past slider to show the gated plans that were followed. Hover a historical segment to compare its original forecast with the current forecast and any configured measurements. The archive is per hub, local and bounded by size and time. The next successful solve after restart bootstraps a fresh active plan. Archived plans are available for review.

Ungated optimizations stay live but no longer write forecast snapshots to the archive. The card shows the stored count and actual archive file size. Its Purge plan archive button removes saved plans for this hub and leaves the live plan and Recorder history alone. Existing archive data is retained until it ages out or an administrator purges it.

For Recorder overlays, add an explicit mapping to the Homusman forecast card YAML. Use the plotted fork output on the left and a measured sensor with matching quantity, direction and compatible units on the right:

```yaml
actual_entities:
  sensor.homusman_grid_power_import: sensor.meter_import_power
  sensor.homusman_battery_state_of_charge: sensor.battery_soc
```

Replace the example IDs with your own. The card uses Home Assistant history for those sensors and leaves missing readings as gaps. Raw-market benefit and active-plan recovery across restart remain outside this build. The gate compares model net power. Native inverter modes and physical responses require independent validation before the fork feeds dispatch.

For rollback, select the previous Homusman version in HACS, restart Core and reload the card.

