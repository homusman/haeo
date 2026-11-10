# HAEO Homusman v0.6.2

The candidate and the retained plan's extension both solve against the original forecasts. When time weighting or spike suppression is enabled, the acceptance gate rescores the two solved schedules with discounted tariff deviations. The active plan and its saved cost use the undiscounted objective.

Time weighting also discounts the terminal value of stored energy when scoring acceptance. The optimiser still sees its full value. EV terminal value comes from the EV's public charging forecast and can differ from stationary battery salvage. The gate continues to count SoC limit penalties at full value. A feasible candidate can still replace an infeasible retained plan regardless of score.

The comparison metadata shows both gate scores, alongside the undiscounted plan costs. New cost breakdowns distinguish SoC limit penalties from terminal energy value. Historical acceptance decisions keep their saved costs.

Update the Homusman integration in HACS, restart Home Assistant Core and reload the dashboard.
