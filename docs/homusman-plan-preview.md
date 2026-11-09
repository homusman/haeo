# HAEO Homusman plan acceptance preview

This HACS prerelease is for the separate `haeo_homusman` hub in shadow use. Keep the dispatcher connected to the vanilla HAEO hub. Install by selecting `v0.5.4b7` explicitly in HACS, restart Core and reload the Homusman Lovelace card.

- This update fixes a setup error in the coordinator and gives the fork?s cards distinct names in the card picker.
- The earlier battery-power deviation penalty has been removed. Its saved settings have no effect.
- Under the Homusman hub's advanced options, enable the plan acceptance gate to compare against a strict, same-input LP solve that holds modeled first-interval grid and battery net power. The default threshold is 0.02 in the model's currency, and the same-action deadband is 0.1 kW. The gate and tariff weighting both default off.
- Separate Advanced settings enable tariff time weighting and spike suppression. Tune the midpoint, width, floor, baseline time constant, spike scale and suppression strength there. The first interval retains its original tariff. Both features default off for new hubs. The modeled benefit uses the objective selected for the current solve.
- Click while hovering a historical segment to pin the comparison. Click again to unpin. The cursor panel lists values for both plans, and the separate metadata panel shows saved costs and the reason for the change. Power and price numeric fields apply a fixed scale, and SoC is 0–100%. Archive controls and the latest optimiser run sit below the legend. The cursor panel includes recorded values even when no accepted plan covers that time. Candidate view retains configured input context such as tariffs and windows.
- The Past slider sits below the future slider with nonlinear steps. Hover respects the selected range. Historical and candidate power plans use the same filled renderer and display mode as the current plan. The candidate view replaces the current forecast on the right of now.
- The forecast card shows accepted outputs by default. An administrator can use the Past slider to show the gated plans that were followed. Hover a historical segment to compare its original forecast with the current forecast and any configured measurements. The archive is per hub, local and bounded by size and time. The next successful solve after restart bootstraps a fresh active plan. Archived plans are available for review.

Ungated optimizations stay live but no longer write forecast snapshots to the archive. The card shows the stored count and actual archive file size. Its Purge plan archive button removes saved plans for this hub and leaves the live plan and Recorder history alone. Existing archive data is retained until it ages out or an administrator purges it.

Recorder overlays use unambiguous configured inputs from the same hub. The battery power trace uses the hub’s recorded signed optimizer output, split into charge and discharge. A physical measurement can override that source. For example, a battery’s configured SoC sensor supplies actual SoC. Existing explicit mappings take precedence and remain available for measurements the topology does not supply. Use the plotted fork output on the left and a measured sensor with matching quantity, direction and compatible units on the right:

```yaml
actual_entities:
  sensor.homusman_grid_power_import: sensor.meter_import_power
  sensor.homusman_battery_state_of_charge: sensor.battery_soc
```

Replace the example IDs with your own. The card uses Home Assistant history for those sensors and leaves missing readings as gaps. Raw-market benefit and active-plan recovery across restart remain outside this build. The gate compares model net power. Native inverter modes and physical responses require independent validation before the fork feeds dispatch.

For rollback, select the previous Homusman version in HACS, restart Core and reload the card.
