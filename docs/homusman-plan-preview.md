# HAEO Homusman plan acceptance preview

Hover a power series in either chart to see the difference shaded in the lower chart where both forecasts overlap. The card reduces the density of plotted Recorder history as the Past range grows, keeping peaks and gaps.

This update bounds and scrolls plan metadata, preserves SoC and price values in the cursor panel, and places plot titles inside the lower-left corners.

This HACS prerelease is for the separate `haeo_homusman` hub in shadow use. Keep the dispatcher connected to the vanilla HAEO hub. Install by selecting `v0.5.4b14` explicitly in HACS, restart Core and reload the Homusman Lovelace card.

- This update fixes a setup error in the coordinator and gives the fork?s cards distinct names in the card picker.
- The earlier battery-power deviation penalty has been removed. Its saved settings have no effect.
- The rolling acceptance gate compares both plans on one updated horizon. The incumbent holds the accepted battery and EV charge/discharge and flexible-load schedules throughout their overlap. Grid flows and SoC are recalculated. Only the uncovered tail is freely scheduled. Retention extends the active plan without adding an acceptance transition. A conflict anywhere in the incumbent lets a feasible candidate bypass the threshold. Conflicting constraints and UTC intervals appear in the log and metadata when the solver identifies them.
- Separate Advanced settings enable tariff time weighting and spike suppression. Tune the midpoint, width, floor, baseline time constant, spike scale and suppression strength there. The first interval retains its original tariff. Both features default off for new hubs. The modeled benefit uses the objective selected for the current solve.
- Click while hovering a historical segment to open a separate pinned chart below the main graph. The lower chart always has its own space. Click a past segment to select it or click the future to show the candidate below the current plan. Right-click or use Clear comparison to reset the lower pane. Both charts share the axis settings and cursor panel. Rescaling keeps the pin active. On narrow cards, the panel appears below both charts.  New archived plans include input forecasts. Earlier archives can show saved outputs only. The cursor panel lists values for both plans, and the separate metadata panel shows saved costs and the reason for the change. Power and price numeric fields apply a fixed scale, and SoC is 0–100%. Archive controls and the latest optimiser run sit below the legend. The cursor panel includes recorded values even when no accepted plan covers that time. Candidate view retains configured input context such as tariffs and windows.
- The Past slider sits below the future slider with nonlinear steps. Hover respects the selected range. Historical and candidate power plans use the same filled renderer and display mode as the current plan. The candidate view replaces the current forecast on the right of now.
- The forecast card shows accepted outputs by default. An administrator can use the Past slider to show the gated plans that were followed. Hover a historical segment to compare its original forecast with the current forecast and any configured measurements. The archive is per hub, local and bounded by size and time. The next successful solve after restart bootstraps a fresh active plan. Archived plans are available for review.

Ungated optimizations stay live but no longer write forecast snapshots to the archive. The card shows the stored count and actual archive file size. Its Purge plan archive button removes saved plans for this hub and leaves the live plan and Recorder history alone. Existing archive data is retained until it ages out or an administrator purges it.

Recorder overlays use unambiguous configured inputs from the same hub. Choose a Measured power sensor in each element’s settings. The card reads that sensor from Recorder. Use positive battery discharge and grid import, or enable Invert measured power sign. These fields are chart inputs only. For example, a battery’s configured SoC sensor supplies actual SoC. Existing explicit mappings take precedence and remain available for measurements the topology does not supply. Use the plotted fork output on the left and a measured sensor with matching quantity, direction and compatible units on the right:

```yaml
actual_entities:
  sensor.homusman_grid_power_import: sensor.meter_import_power
  sensor.homusman_battery_state_of_charge: sensor.battery_soc
```

Replace the example IDs with your own. The card uses Home Assistant history for those sensors and leaves missing readings as gaps. Raw-market benefit and active-plan recovery across restart remain outside this build. The gate retains modeled controllable schedules and recalculates grid flows under the latest forecasts. The archive still preserves original acceptance snapshots. Continuation updates are reflected in the active plan. Native inverter modes and physical responses require independent validation before the fork feeds dispatch.

For rollback, select the previous Homusman version in HACS, restart Core and reload the card.
