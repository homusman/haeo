"""Compare near-term commitments and adjust forecast tariff deviations."""

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from math import exp

import numpy as np
from numpy.typing import NDArray

from custom_components.haeo_homusman.core.adapters.network_builder import build_network
from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError
from custom_components.haeo_homusman.core.schema.elements import ElementConfigData, ElementType

THRESHOLD = 0.02
DEADBAND_KW = 0.1
BASELINE_SECONDS = 3 * 3600


def adjust_tariff(values: NDArray[np.float64], boundaries: Sequence[float]) -> NDArray[np.float64]:
    """Shrink deviations from a symmetric three-hour exponential baseline."""
    starts = np.asarray(boundaries[:-1])
    durations = np.diff(boundaries)
    centers = starts + durations / 2
    baseline = np.empty_like(values)
    for index, center in enumerate(centers):
        weights = np.exp(-np.abs(centers - center) / BASELINE_SECONDS) * durations
        baseline[index] = np.average(values, weights=weights)
    hours = (starts - starts[0]) / 3600
    logistic = 1 / (1 + np.exp(np.clip((hours - 12) / 3, -700, 700)))
    confidence = 0.6 + 0.4 * logistic * (1 + exp(-4))
    result = baseline + confidence * (values - baseline)
    result[0] = values[0]
    return result


def adjust_grid_prices(
    configs: dict[str, ElementConfigData], boundaries: Sequence[float]
) -> dict[str, ElementConfigData]:
    """Transform import and export independently, leaving scalar tariffs intact."""
    adjusted = configs.copy()
    for name, config in configs.items():
        if config["element_type"] != ElementType.GRID:
            continue
        pricing = config["pricing"].copy()
        for direction in ("price_source_target", "price_target_source"):
            values = pricing[direction]
            if isinstance(values, np.ndarray):
                pricing[direction] = adjust_tariff(values, boundaries)
        adjusted[name] = {**config, "pricing": pricing}
    return adjusted


def assess_plan(
    configs: dict[str, ElementConfigData],
    periods: Sequence[float],
    boundaries: Sequence[float],
    actions: Mapping[str, tuple[float, ...]],
    cost: float,
    previous_boundaries: Sequence[float],
    previous_actions: Mapping[str, tuple[float, ...]] | None,
    threshold: float,
) -> tuple[str, float | None]:
    """Score a strict same-input incumbent and compare the near-term commitment."""
    if not previous_actions or not actions or actions.keys() != previous_actions.keys():
        return "bootstrap", None
    index = bisect_right(previous_boundaries, boundaries[0]) - 1
    if index < 0 or index >= len(previous_boundaries) - 1 or boundaries[1] > previous_boundaries[-1]:
        return "expired", None
    committed = {name: values[index] for name, values in previous_actions.items()}
    for offset in range(index + 1, len(previous_boundaries) - 1):
        if previous_boundaries[offset] >= boundaries[1]:
            break
        if any(abs(previous_actions[name][offset] - power) > 1e-7 for name, power in committed.items()):
            return "commitment_boundary", None

    network = build_network("incumbent", configs, periods, relax_infeasible=False)
    try:
        benchmark = network.optimize_incumbent(committed)
    except InfeasibleError:
        return "incumbent_infeasible", None
    if all(abs(values[0] - committed[name]) <= DEADBAND_KW for name, values in actions.items()):
        return "same_action", benchmark
    return ("accepted" if benchmark - cost > threshold else "below_threshold"), benchmark

