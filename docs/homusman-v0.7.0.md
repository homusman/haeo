# HAEO Homusman v0.7.0

## Highlights

- Small input changes can be handled by bounded battery schedule corrections while retaining the accepted plan.
- Corrections remain anchored to the original schedule. Repeated solves and horizon extensions share a lifetime energy budget.
- The card shows revision counts and per-battery correction totals. Historical plots use the published schedule over elapsed intervals.

## Configuration

Two Advanced hub settings control corrections. Defaults are **0.1 kW per battery** and **0.25 kWh per battery per accepted plan**. Charge and discharge adjustments share both limits. Set either limit to zero to require exact held powers.

The power bound applies to the combined absolute change from the original schedule in each interval. The energy budget covers both elapsed corrections and the remaining horizon. Each newly appended tail receives a reference when it is first added. A new acceptance resets the budget.

## Acceptance and history

The retained solve finds the smallest correction needed for feasibility, then calculates its economic cost. Candidate and retained schedules use the same current forecasts and measured SoC. The gate applies the existing economic threshold and forecast discounts to their scores. If the correction bounds cannot produce a feasible retained plan, a feasible candidate may replace it.

Corrections preserve the acceptance time and plan identity. Revision records contain changed power intervals and budget summaries. The upper historical graph uses published schedules over elapsed intervals. Selecting an archived plan in the lower pane displays its original acceptance snapshot.

History retains at most 128 revision records and 2,048 points per traced series, subject to the existing 512 KiB per-plan and 8 MiB archive limits. Older details are pruned when required. The card indicates pruned trace coverage. Revision count remains cumulative. Stored schedules describe what the hub published, while measured overlays continue to come from Home Assistant Recorder.

Restarting Core starts a fresh active acceptance after the next successful solve. Archived history remains available.

## Installation

Update the Homusman integration to v0.7.0 in HACS, restart Home Assistant Core and reload the dashboard. The release includes the integration ZIP and a SHA-256 checksum. To roll back, select v0.6.2 in HACS, restart Core and reload the dashboard.
