# HAEO Homusman v0.7.4

The retained plan now uses its bounded corrections to reduce configured SoC target penalties before minimising power movement. This prevents avoidable SoC penalties from driving candidate acceptances simply because the retained solve preferred zero correction.

Among equally effective corrections of the same total energy, the solver favours later intervals. It can still adjust the immediate interval when required by SoC recovery or physical feasibility. The existing per-battery power and lifetime energy budgets apply.

The final gate compares the candidate with this corrected retained schedule using the current inputs and configured discounts. A replacement may still be justified when its economic benefit clears the threshold, or when the correction budget cannot address the drift.

Update the Homusman integration in HACS, restart Home Assistant Core and reload the dashboard.
