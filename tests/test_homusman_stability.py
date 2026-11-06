"""Regression tests for the independent Homusman fork's LP stability cost."""
import numpy as np
import pytest

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


def test_penalty_rejects_small_financial_gain():
    network = make_battery_network()
    network.set_stability_reference({}, penalty_dollars_per_kwh=0)
    network.optimize()
    without_penalty = float(network.battery_power_snapshot()["battery"][0])
    assert without_penalty > 1.0

    # 2 cents/kWh of setpoint deviation outweighs 1 cent/kWh export gain.
    network.set_stability_reference(
        {"battery": (np.array([0.0]), np.array([1.0]))},
        penalty_dollars_per_kwh=0.02,
    )
    network.optimize()
    stable = float(network.battery_power_snapshot()["battery"][0])
    assert abs(stable) < 0.05


def test_economic_gain_overrides_smaller_penalty():
    network = make_battery_network()
    network.set_stability_reference(
        {"battery": (np.array([0.0]), np.array([1.0]))},
        penalty_dollars_per_kwh=0.001,
    )
    network.optimize()
    assert float(network.battery_power_snapshot()["battery"][0]) > 1.0


def test_zero_weight_does_not_modify_optimum():
    network = make_battery_network()
    network.set_stability_reference(
        {"battery": (np.array([0.0]), np.array([0.0]))},
        penalty_dollars_per_kwh=0.02,
    )
    network.optimize()
    assert float(network.battery_power_snapshot()["battery"][0]) > 1.0
