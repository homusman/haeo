# HAEO Homusman v0.6.1

- Gated solves start at the solve time. The optimiser uses the current measured SoC and skips elapsed portions of forecast intervals. This prevents a retained schedule from replaying charge or discharge that has already happened. Both plans use fresh models built from the same inputs and keep the forecast's common end time.
- Historic metadata shows the previous plan repriced at acceptance and the largest element-level changes in the objective when benefit triggered the change. The difference between two saved plan costs uses two different runs. The gate compares costs from the same run.
- When the solver returns a broad conflict, the gate tries to identify a small set of changes to held actions that could restore feasibility. This is a diagnostic solve only. The original schedule still has to satisfy the full horizon.

Update the Homusman integration in HACS, restart Home Assistant Core and reload the dashboard.
