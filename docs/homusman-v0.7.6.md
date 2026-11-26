# HAEO Homusman v0.7.6

Retained plans now preferentially preserve their accepted net grid power schedule as load and solar forecasts change. Previously, minimizing battery adjustments took precedence, allowing forecast changes to become planned grid imports or exports and potentially change dispatcher mode.

The retained solve priorities are: minimize SoC target penalties, minimize accepted-grid tracking error, minimize battery correction energy, prefer later corrections, then optimize economic cost. Grid tracking is a soft preference within the existing per-battery power and lifetime energy budgets. It preserves intentional import/export targets as well as zero-grid targets; an unreachable target leaves a residual grid flow rather than creating an infeasibility.

Grid references remain anchored to acceptance, and each new tail is optimized freely before becoming part of the reference. Candidate optimization, price filtering, benefit discounts and dispatcher behavior are unchanged. Battery correction diagnostics and revision history continue to apply.

Update HAEO Homusman through HACS and restart Home Assistant Core. No configuration changes are required. A new initial plan is generated after restart. Solis native Self-use can handle short-term transients when selected by the dispatcher, subject to available energy, charging headroom and hardware limits; this release does not add a real-time feedback loop.

To roll back, reinstall v0.7.5 through HACS and restart Core. Production installation remains manual.
