# Bounded corrections to accepted plans

The Homusman acceptance gate evaluates a retained schedule against a newly optimised candidate using the same current inputs. The retained schedule may adjust battery charge and discharge to remain feasible.

For each battery and interval, nonnegative variables bound the absolute deviation of each scheduled direction from its acceptance reference. Their sum is bounded by the configured correction power in kW. The duration-weighted sum over the retained horizon, plus correction energy already elapsed, is bounded by the lifetime budget in kWh. Charge and discharge deviations share this budget and cannot cancel.

The reference survives each continuation. An appended tail establishes its reference when first added. Elapsed corrections are charged to the budget before trimming the old horizon, preventing repeated extensions from replenishing it.

The retained solve first minimises configured SoC target penalties within its correction limits. It then minimises total absolute correction energy while preserving that penalty minimum. Among equally effective corrections of the same size, it favours later intervals using a correction-energy weight of 1 / (1 + hours from the current horizon start). Each minimum is bounded within a small numerical tolerance before the next stage. The final stage performs the ordinary economic solve with its usual tie breaker.

The economic gate compares that corrected retained schedule with the candidate. A near-term correction remains available when it is necessary to reduce a SoC violation or satisfy a physical constraint. Model power balance and physical limits remain enforced throughout.

Configured operational SoC targets retain the model's existing penalty behavior. The correction mechanism changes held action constraints and uses a disposable network with physical relaxation disabled.

History preserves the original acceptance snapshot. Corrections receive revision numbers and compact changed-interval records. Elapsed portions of published output schedules are stored separately for the historical graph. These scheduled traces are distinct from Recorder measurements of actual hardware behavior.
