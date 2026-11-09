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


def make_battery_network():
    network = Network(name="stability", periods=np.array([1.0]))
    network.add({
        "element_type": MODEL_ELEMENT_TYPE_BATTERY,
        "name": "battery", "capacity": 10.0, "initial_charge": 5.0,
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
    assert candidate.action_snapshot()["battery"][0] == pytest.approx(5.0)
    assert incumbent.optimize_incumbent({"battery": 0.0}) - cost == pytest.approx(0.05)
    assert incumbent.action_snapshot()["battery"][0] == pytest.approx(0.0)


def test_incumbent_does_not_relax_an_impossible_action() -> None:
    from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError

    with pytest.raises(InfeasibleError):
        make_battery_network().optimize_incumbent({"battery": 6.0})


def test_confidence_preserves_current_price_and_shrinks_distant_spikes() -> None:
    from custom_components.haeo_homusman.coordinator.plan_acceptance import adjust_tariff

    values = np.full(48, -0.1)
    values[0] = 3.0
    values[24] = 2.0
    result = adjust_tariff(values, np.arange(49) * 3600)
    assert result[0] == 3.0
    assert 0.8 < result[24] < 1.6
    assert result[-1] < 0
    assert values[24] == 2.0


@pytest.mark.parametrize(
    ("committed", "threshold", "expected"),
    [(0.0, 0.02, "accepted"), (0.0, 0.06, "below_threshold"),
     (5.0, 0.0, "same_action"), (6.0, 0.02, "incumbent_infeasible")],
)
def test_gate_uses_same_horizon_benchmark(monkeypatch, committed, threshold, expected) -> None:
    from custom_components.haeo_homusman.coordinator import plan_acceptance

    def build_incumbent(name, configs, periods, *, relax_infeasible):
        assert configs == {}
        assert periods == (3600.0,)
        assert not relax_infeasible
        return make_battery_network()

    monkeypatch.setattr(plan_acceptance, "build_network", build_incumbent)
    candidate = make_battery_network()
    cost = candidate.optimize()
    reason, _ = plan_acceptance.assess_plan(
        {}, (3600.0,), (3600.0, 7200.0), candidate.action_snapshot(),
        cost, (3600.0, 7200.0), {"battery": (committed,)}, threshold,
    )
    assert reason == expected
