# HAEO Homusman v0.6.0

This stable release brings rolling plan acceptance and plan history to the separate `haeo_homusman` hub. The fork can run alongside vanilla HAEO for comparison while the existing dispatcher continues to use vanilla HAEO.

## Where the acceptance gate sits

Home Assistant sensor values and forecasts feed the fork’s HAEO model. The optimiser solves for a candidate. Before the coordinator publishes its output entities, the acceptance gate decides whether to publish that candidate or continue the current accepted plan. The Homusman forecast card reads the active outputs and uses the fork’s history interface to display the latest candidate and archived acceptance snapshots. Any downstream dispatcher or automation decides separately which hub’s outputs to consume.

## How acceptance is calculated

1. The optimiser solves a candidate using the latest measured state, forecasts and model constraints. It evaluates the current plan over the same rolling horizon and against the same inputs.
2. For the portion the current plan already covers, the evaluation fixes its scheduled battery and EV charge and discharge and flexible-load power. The model recomputes resulting state of charge and grid flows from the latest inputs, then optimises only the uncovered tail. The combined schedule must be feasible over the entire horizon, including the tail.
3. The benefit is the current plan’s recalculated objective cost minus the candidate’s objective cost. With both plans feasible, the gate accepts the candidate only when the benefit is **strictly greater than** the configured threshold, expressed in the model’s currency. At or below the threshold, it publishes the extended current plan and keeps the original acceptance time.
4. A feasible candidate is accepted regardless of benefit when the gate has no usable current plan or the current plan is infeasible. For infeasible plans, the metadata and logs include the identified constraints and intervals when the solver can isolate them. A change in measured SoC affects feasibility through the model’s constraints.

For example, an incumbent cost of $1.20 and a candidate cost of $1.11 give $0.09 of modeled benefit. With a $0.10 threshold and a feasible incumbent, the gate keeps the incumbent. The comparison uses the configured objective. Optional tariff time weighting and spike suppression are separate settings and affect both evaluated costs. Spike suppression scales deviations from a filtered tariff baseline. Both options default off for new hubs. The earlier battery-power deviation penalty has been removed.

## Dashboard and history

- The upper chart shows the active plan and historical plan segments. Click a past segment or the future to pin an archived plan or the candidate in the aligned lower chart. Right-click or use **Clear comparison** to clear it. Candidate metadata shows the elapsed time from the current plan’s acceptance to candidate generation.
- Hover a power series to shade its difference in the lower chart. Lower power is red. The cursor panel shows both plans and measured values where available. Power and price ranges and the Past setting are remembered by the card.
- Recorder traces come from configured topology sensors, including measured power where configured. Longer lookbacks plot fewer Recorder points while preserving peaks and gaps. The Recorder data remains in Home Assistant.
- The local plan archive records gated acceptance transitions and is bounded by age and size. Continuations and ungated runs add no snapshots. The card shows the archive’s saved plan count and file size, and **Purge plan archive** clears those snapshots. After a restart, the next successful solve starts a fresh active plan. Existing snapshots remain available for review.

## Install or roll back

Update the Homusman integration to `v0.6.0` in HACS, restart Home Assistant Core and reload the Lovelace dashboard. Choose the Homusman card when adding a new card. The release includes `haeo_homusman.zip` and its SHA-256 checksum for manual verification. To roll back, select the previously installed Homusman version in HACS, restart Core and reload the dashboard.
