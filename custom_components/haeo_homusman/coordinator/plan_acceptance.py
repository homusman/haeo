"""Compare near-term commitments and adjust forecast tariff deviations."""

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from custom_components.haeo_homusman.core.adapters.network_builder import build_network
from custom_components.haeo_homusman.core.const import (
    CONF_FORECAST_CONFIDENCE_ENABLED,
    CONF_SPIKE_SUPPRESSION_ENABLED,
    TARIFF_NUMERIC_OPTIONS,
)
from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError
from custom_components.haeo_homusman.core.schema.elements import ElementConfigData, ElementType

THRESHOLD = 0.02
DEADBAND_KW = 0.1
@dataclass(frozen=True, slots=True)
class TariffWeights:
    """Settings for forecast deviation weighting."""

    time_enabled: bool
    spike_enabled: bool
    confidence_midpoint_hours: float
    confidence_width_hours: float
    confidence_floor: float
    tariff_baseline_hours: float
    spike_scale_cents_per_kwh: float
    max_spike_suppression: float


def tariff_weights(settings: Mapping[str, object]) -> TariffWeights:
    """Read persisted settings with defaults for older entries."""
    return TariffWeights(
        bool(settings.get(CONF_FORECAST_CONFIDENCE_ENABLED)),
        bool(settings.get(CONF_SPIKE_SUPPRESSION_ENABLED)),
        **{key: settings.get(key, default) for key, (default, _, _) in TARIFF_NUMERIC_OPTIONS.items()},
    )


def adjust_tariff(values: NDArray[np.float64], boundaries: Sequence[float], settings: TariffWeights) -> NDArray[np.float64]:
    """Shrink deviations from a symmetric three-hour exponential baseline."""
    if not settings.time_enabled and not settings.spike_enabled:
        return values
    starts = np.asarray(boundaries[:-1])
    durations = np.diff(boundaries)
    centers = starts + durations / 2
    baseline = np.empty_like(values)
    for index, center in enumerate(centers):
        weights = np.exp(-np.abs(centers - center) / (settings.tariff_baseline_hours * 3600)) * durations
        baseline[index] = np.average(values, weights=weights)
    hours = (starts - starts[0]) / 3600
    logistic = 1 / (1 + np.exp(np.clip(
        (hours - settings.confidence_midpoint_hours) / settings.confidence_width_hours, -700, 700
    )))
    confidence = settings.confidence_floor + (1 - settings.confidence_floor) * logistic / logistic[0]
    deviation = values - baseline
    weight = confidence if settings.time_enabled else np.ones_like(values)
    if settings.spike_enabled:
        spike = -np.expm1(-np.square(deviation * 100 / settings.spike_scale_cents_per_kwh))
        attenuation = 1 - confidence if settings.time_enabled else 1 - logistic / logistic[0]
        weight = weight * (1 - settings.max_spike_suppression * attenuation * spike)
    result = baseline + weight * deviation
    result[0] = values[0]
    return result


def adjust_grid_prices(
    configs: dict[str, ElementConfigData], boundaries: Sequence[float], settings: TariffWeights
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
                pricing[direction] = adjust_tariff(values, boundaries, settings)
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

