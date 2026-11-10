# HAEO Homusman v0.7.1

- The Advanced hub settings include a minimum time between economic acceptances. It defaults to zero minutes. Feasibility and expiry replacements can take effect immediately.
- Hover or focus the Benefit value in the optimiser diagnostics to see candidate benefit versus retained plan age. The latest scored plan is highlighted. History keeps up to 20,000 evaluations within the rolling archive window. Evaluations without a score are counted separately.
- The Current plan and its Plan latest snapshot share acceptance metadata. The snapshot retains its original forecasts and survives Clear comparison when pinned. A pinned candidate refreshes with the card.
- Recorded power traces keep one colour through zero crossings. They use filled areas and follow the plot's overlay or stack toggle. In stack mode, signed power traces of the same equipment class add together.
- Acceptance metadata distinguishes decisions driven by configured SoC penalties from physical infeasibility.

Update the Homusman integration in HACS, restart Home Assistant Core and reload the dashboard.
