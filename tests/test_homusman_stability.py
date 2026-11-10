"""Regression tests for the independent Homusman fork's plan acceptance model."""
import sys
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest

# The LP model is standalone. Avoid importing the HA integration's __init__
# in this fast numeric test environment, which has no Home Assistant runtime.
package = ModuleType("custom_components.haeo_homusman")
package.__path__ = [str(Path(__file__).resolve().parents[1] / "custom_components" / "haeo_homusman")]
sys.modules.setdefault("custom_components.haeo_homusman", package)
coordinator = ModuleType("custom_components.haeo_homusman.coordinator")
coordinator.__path__ = [str(Path(package.__path__[0]) / "coordinator")]
sys.modules.setdefault("custom_components.haeo_homusman.coordinator", coordinator)


from custom_components.haeo_homusman.core.model import Network
from custom_components.haeo_homusman.core.model.elements import (
    MODEL_ELEMENT_TYPE_BATTERY,
    MODEL_ELEMENT_TYPE_CONNECTION,
    MODEL_ELEMENT_TYPE_NODE,
)


def make_battery_network(periods=(1.0,), initial_charge=5.0, capacity=10.0, **battery_settings):
    network = Network(name="stability", periods=np.array(periods))
    network.add({
        "element_type": MODEL_ELEMENT_TYPE_BATTERY,
        "name": "battery", "capacity": capacity, "initial_charge": initial_charge,
        **battery_settings,
    })
    network.add({
        "element_type": MODEL_ELEMENT_TYPE_NODE,
        "name": "grid", "is_source": True, "is_sink": True,
    })
    network.add({
        "element_type": MODEL_ELEMENT_TYPE_CONNECTION,
        "name": "battery:discharge",
        "source": "battery", "target": "grid", "tags": {1},
        "segments": {
            "power_limit": {"segment_type": "power_limit", "max_power": 5.0},
            "pricing": {"segment_type": "pricing", "price": -0.01},
        },
    })
    network.add({
        "element_type": MODEL_ELEMENT_TYPE_CONNECTION,
        "name": "battery:charge",
        "source": "grid", "target": "battery", "tags": {1},
        "segments": {
            "power_limit": {"segment_type": "power_limit", "max_power": 5.0},
            "pricing": {"segment_type": "pricing", "price": 0.01},
        },
    })
    return network


def test_incumbent_values_the_cost_of_holding_current_power() -> None:
    candidate = make_battery_network()
    incumbent = make_battery_network()
    cost = candidate.optimize()
    assert candidate.action_snapshot()["battery:discharge"][0] == pytest.approx(5.0)
    assert incumbent.optimize_incumbent({"battery:discharge": (0.0,), "battery:charge": (0.0,)}) - cost == pytest.approx(0.05)
    assert incumbent.action_snapshot()["battery:discharge"][0] == pytest.approx(0.0)


def test_gate_identifies_soc_penalty_as_decisive(monkeypatch) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    settings = {"min_charge": 5.0, "charge_limit_cost": 10.0}
    candidate = make_battery_network(**settings)
    monkeypatch.setattr(plan_acceptance, "build_network", lambda *a, **kw: make_battery_network(**settings))
    cost = candidate.optimize()
    boundaries = (0.0, 3600.0)
    result = plan_acceptance.assess_plan(
        {}, (3600.0,), boundaries, candidate.action_snapshot(), cost, boundaries,
        {"battery:discharge": (0.1,), "battery:charge": (0.0,)}, 0.02, candidate,
    )
    assert result.reason == "soc_limit_penalty"
    assert result.continuation is None
    assert result.benefit == pytest.approx(0.999)


def test_gate_scores_can_discount_terminal_energy_without_changing_the_solve(monkeypatch) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    candidate = make_battery_network(periods=(48.0,), capacity=5.0)
    incumbent = make_battery_network(periods=(48.0,), capacity=5.0)
    candidate.elements["battery"].salvage_value = 0.07
    incumbent.elements["battery"].salvage_value = 0.07
    monkeypatch.setattr(plan_acceptance, "build_network", lambda *args, **kwargs: incumbent)
    raw_cost = candidate.optimize()
    assert raw_cost == pytest.approx(-0.35)
    actions = candidate.action_snapshot()
    end = 48 * 3600
    result = plan_acceptance.assess_plan(
        {}, (end,), (0.0, end), actions, raw_cost, (0.0, end),
        {"battery:discharge": (0.1,), "battery:charge": (0.0,)}, 0.02,
        candidate, plan_acceptance.tariff_weights({
            "forecast_confidence_enabled": True, "confidence_floor": 0.0,
            "confidence_midpoint_hours": 6.0, "confidence_width_hours": 2.0,
        }),
    )
    assert result.incumbent_cost - raw_cost == pytest.approx(0.288)
    assert result.reason == "below_threshold"
    assert result.benefit == pytest.approx(-0.048, abs=0.01)
    assert "battery terminal energy" not in (result.benefit_drivers or "")
    assert candidate.action_snapshot() == actions


def test_incumbent_does_not_relax_an_impossible_action() -> None:
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError

    with pytest.raises(InfeasibleError):
        make_battery_network().optimize_incumbent({"battery:discharge": (6.0,), "battery:charge": (0.0,)})


def test_elapsed_interval_would_double_count_discharge() -> None:
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError

    actions = {"battery:discharge": (5.0,), "battery:charge": (0.0,)}
    with pytest.raises(InfeasibleError):
        make_battery_network(initial_charge=4.95).optimize_incumbent(actions)
    remaining = make_battery_network(periods=(59 / 60,), initial_charge=4.95)
    assert remaining.optimize_incumbent(actions) == pytest.approx(-0.05 * 59 / 60)


def test_bounded_correction_fixes_small_soc_mismatch_and_minimizes_change() -> None:
    network = make_battery_network(initial_charge=4.95)
    original = {"battery:discharge": (5.0,), "battery:charge": (0.0,)}
    network.optimize_incumbent(original, correction_power=0.1, correction_energy=0.25)
    actions = network.action_snapshot()
    assert actions["battery:discharge"][0] == pytest.approx(4.95, abs=1e-7)
    assert actions["battery:charge"][0] == pytest.approx(0.0, abs=1e-7)
    assert not network.relaxations
    assert original["battery:discharge"] == (5.0,)


@pytest.mark.parametrize("power,energy,used", [(0.04, 0.25, {}), (0.1, 0.04, {}), (0.1, 0.25, {"battery": 0.21})])
def test_correction_rejects_power_energy_or_lifetime_budget_overrun(power, energy, used) -> None:
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError

    network = make_battery_network(initial_charge=4.95)
    with pytest.raises(InfeasibleError):
        network.optimize_incumbent(
            {"battery:discharge": (5.0,), "battery:charge": (0.0,)},
            correction_power=power, correction_energy=energy, energy_used=used,
        )


def test_economic_opportunity_alone_does_not_nudge_the_retained_plan() -> None:
    network = make_battery_network()
    original = {"battery:discharge": (0.0,), "battery:charge": (0.0,)}
    network.optimize_incumbent(original, correction_power=0.1, correction_energy=0.25)
    assert network.action_snapshot()["battery:discharge"][0] == pytest.approx(0.0, abs=1e-7)


def test_charge_and_discharge_share_the_power_correction_bound() -> None:
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError

    original = {"battery:discharge": (5.06,), "battery:charge": (5.06,)}
    with pytest.raises(InfeasibleError):
        make_battery_network().optimize_incumbent(original, correction_power=0.1, correction_energy=0.25)
    network = make_battery_network()
    network.optimize_incumbent(original, correction_power=0.2, correction_energy=0.25)
    assert network.action_snapshot()["battery:discharge"][0] == pytest.approx(5.0)
    assert network.action_snapshot()["battery:charge"][0] == pytest.approx(5.0)


def test_reference_and_elapsed_budget_survive_repeated_extensions() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import elapsed_corrections, extend_reference

    original = {"battery:discharge": (1.0, 2.0), "battery:charge": (0.0, 0.0)}
    corrected = {"battery:discharge": (0.9, 2.1), "battery:charge": (0.0, 0.0)}
    used = elapsed_corrections((0., 3600., 7200.), corrected, original, 1800., {})
    assert used["battery"] == pytest.approx(0.05)
    next_actions = {"battery:discharge": (0.9, 2.1, 3.0), "battery:charge": (0.0, 0.0, 0.0)}
    reference = extend_reference((1800., 3600., 7200., 9000.), (0., 3600., 7200.), original, next_actions)
    assert reference["battery:discharge"] == (1.0, 2.0, 3.0)
    total = elapsed_corrections((1800., 3600., 7200., 9000.), next_actions, reference, 7200., used)
    assert total["battery"] == pytest.approx(0.2)


def test_broad_conflict_reports_a_feasible_commitment_adjustment(monkeypatch) -> None:
    from custom_components.haeo_homusman.core.model import network
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError, RowLabel

    monkeypatch.setattr(network, "conflicting_rows", lambda *args, **kwargs: (RowLabel("LP", "row", 0),) * 11)
    with pytest.raises(InfeasibleError) as error:
        make_battery_network().optimize_incumbent({"battery:discharge": (6.0,), "battery:charge": (0.0,)})
    assert len(error.value.conflicts) == 1
    assert error.value.conflicts[0].element == "battery:discharge"
    assert "-1 kW" in error.value.conflicts[0].constraint


def test_confidence_preserves_current_price_and_shrinks_distant_spikes() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import adjust_tariff, tariff_weights

    values = np.full(48, -0.1)
    values[0] = 3.0
    values[24] = 2.0
    result = adjust_tariff(values, np.arange(49) * 3600, tariff_weights({'forecast_confidence_enabled': True}))
    assert result[0] == 3.0
    assert 0.8 < result[24] < 1.6
    assert result[-1] < 0
    assert values[24] == 2.0


def test_grid_gate_adjustments_preserve_raw_prices_and_reverse_export_sign() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import grid_tariff_adjustments, tariff_weights
    from custom_components.haeo_homusman.core.schema.elements import ElementType

    prices = np.array([0.1, 0.1, 1.0])
    configs = {"grid": {"element_type": ElementType.GRID, "pricing": {
        "price_source_target": prices, "price_target_source": prices,
    }}}
    adjustments = grid_tariff_adjustments(
        configs, (0.0, 3600.0, 36000.0, 39600.0), tariff_weights({"forecast_confidence_enabled": True})
    )
    assert adjustments["grid:import"][0] == 0.0
    assert adjustments["grid:import"][-1] < 0.0
    np.testing.assert_allclose(adjustments["grid:export"], -adjustments["grid:import"])
    np.testing.assert_allclose(prices, [0.1, 0.1, 1.0])


@pytest.mark.parametrize(
    ("committed", "threshold", "allowed", "expected"),
    [(0.0, 0.02, True, "accepted"), (0.0, 0.06, True, "below_threshold"),
     (5.0, 0.0, True, "below_threshold"), (6.0, 0.02, True, "incumbent_infeasible"),
     (0.0, 0.02, False, "acceptance_interval"), (6.0, 0.02, False, "incumbent_infeasible")],
)
def test_gate_uses_same_horizon_benchmark(monkeypatch, committed, threshold, allowed, expected) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    def build_incumbent(name, configs, periods, *, relax_infeasible):
        assert configs == {}
        assert periods == (3600.0,)
        assert not relax_infeasible
        return make_battery_network()

    monkeypatch.setattr(plan_acceptance, "build_network", build_incumbent)
    candidate = make_battery_network()
    cost = candidate.optimize()
    result = plan_acceptance.assess_plan(
        {}, (3600.0,), (3600.0, 7200.0), candidate.action_snapshot(),
        cost, (3600.0, 7200.0), {"battery:discharge": (committed,), "battery:charge": (0.0,)}, threshold,
        candidate, economic_replacement_allowed=allowed,
    )
    assert result.reason == expected
    if expected == "acceptance_interval":
        assert result.continuation is not None
        assert result.benefit == pytest.approx(0.05)
    if expected == "accepted":
        assert result.benefit_drivers == "battery:discharge +0.050"
    if expected == 'incumbent_infeasible':
        assert any('limit' in row.constraint for row in result.conflicts)

def test_spike_scale_controls_deviation_without_time_weighting() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import adjust_tariff, tariff_weights

    values = np.full(48, 0.25)
    values[0] = 2
    values[24] = 1
    boundaries = np.arange(49) * 3600
    assert adjust_tariff(values, boundaries, tariff_weights({})) is values
    small = adjust_tariff(values, boundaries, tariff_weights({
        "spike_suppression_enabled": True, "spike_scale_cents_per_kwh": 15,
    }))
    large = adjust_tariff(values, boundaries, tariff_weights({
        "spike_suppression_enabled": True, "spike_scale_cents_per_kwh": 150,
    }))
    assert small[0] == large[0] == values[0]
    assert small[24] < large[24] < values[24]

def test_holds_all_overlapping_actions_and_extends_only_the_tail(monkeypatch) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    monkeypatch.setattr(plan_acceptance, "build_network", lambda *args, **kwargs: make_battery_network((1., 1., 1.)))
    candidate = make_battery_network((1., 1., 1.))
    cost = candidate.optimize()
    result = plan_acceptance.assess_plan(
        {}, (3600., 3600., 3600.), (0., 3600., 7200., 10800.),
        candidate.action_snapshot(), cost, (0., 3600., 7200.),
        {"battery:discharge": (1., 2.), "battery:charge": (0., 0.)}, 1.,
    )
    assert result.reason == "below_threshold"
    assert result.continuation is not None
    assert result.continuation.action_snapshot()["battery:discharge"] == pytest.approx((1., 2., 2.))


def test_future_commitment_can_make_the_incumbent_infeasible(monkeypatch) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    monkeypatch.setattr(plan_acceptance, "build_network", lambda *args, **kwargs: make_battery_network((1., 1.)))
    candidate = make_battery_network((1., 1.))
    cost = candidate.optimize()
    result = plan_acceptance.assess_plan(
        {}, (3600., 3600.), (0., 3600., 7200.),
        candidate.action_snapshot(), cost, (0., 3600., 7200.),
        {"battery:discharge": (4., 4.), "battery:charge": (0., 0.)}, 100.,
    )
    assert result.reason == "incumbent_infeasible"
    assert result.continuation is None
    assert any(row.period == 1 and "held power" in row.constraint for row in result.conflicts)


def test_refinement_preserves_switch_time_and_splits_forecast_values() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import refine_configs, rolling_boundaries

    original = (1800., 5400., 9000.)
    refined = rolling_boundaries(original, (0., 3600., 7200.), {"battery:discharge": (1., 2.)})
    assert refined == (1800., 3600., 5400., 7200., 9000.)
    result = refine_configs({"element": {"price": np.array([0.2, 0.4])}}, original, refined)
    assert result["element"]["price"] == pytest.approx([0.2, 0.2, 0.4, 0.4])
