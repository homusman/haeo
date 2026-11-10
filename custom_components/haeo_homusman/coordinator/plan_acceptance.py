"""Compare near-term commitments and adjust forecast tariff deviations."""

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from typing import cast
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from custom_components.haeo_homusman.core.adapters.network_builder import build_network
from custom_components.haeo_homusman.core.const import (
    CONF_FORECAST_CONFIDENCE_ENABLED,
    CONF_SPIKE_SUPPRESSION_ENABLED,
    TARIFF_NUMERIC_OPTIONS,
)
from custom_components.haeo_homusman.core.model import Network
from custom_components.haeo_homusman.core.model.infeasibility import InfeasibleError, RowLabel
from custom_components.haeo_homusman.core.schema.elements import ElementConfigData, ElementType

THRESHOLD = 0.02

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
    retention = tariff_retention((starts - starts[0]) / 3600, settings)
    confidence = settings.confidence_floor + (1 - settings.confidence_floor) * retention
    deviation = values - baseline
    weight = confidence if settings.time_enabled else np.ones_like(values)
    if settings.spike_enabled:
        spike = -np.expm1(-np.square(deviation * 100 / settings.spike_scale_cents_per_kwh))
        attenuation = 1 - confidence if settings.time_enabled else 1 - retention
        weight = weight * (1 - settings.max_spike_suppression * attenuation * spike)
    result = baseline + weight * deviation
    result[0] = values[0]
    return result


def tariff_retention(hours: NDArray[np.float64], settings: TariffWeights) -> NDArray[np.float64]:
    """Return the time curve normalized at the start of the horizon."""
    logistic = 1 / (1 + np.exp(np.clip(
        (hours - settings.confidence_midpoint_hours) / settings.confidence_width_hours, -700, 700
    )))
    return logistic / logistic[0]


def grid_tariff_adjustments(
    configs: dict[str, ElementConfigData], boundaries: Sequence[float], settings: TariffWeights
) -> dict[str, NDArray[np.float64]]:
    """Return signed price changes for scoring solved grid flows."""
    adjusted = {}
    for name, config in configs.items():
        if config["element_type"] != ElementType.GRID:
            continue
        for direction, field, sign in (("import", "price_source_target", 1), ("export", "price_target_source", -1)):
            values = config["pricing"][field]
            if isinstance(values, np.ndarray):
                adjusted[f"{name}:{direction}"] = sign * (adjust_tariff(values, boundaries, settings) - values)
    return adjusted


def rolling_boundaries(
    boundaries: tuple[float, ...],
    previous_boundaries: Sequence[float],
    previous_actions: Mapping[str, tuple[float, ...]] | None,
) -> tuple[float, ...]:
    """Split periods at retained action changes and at the end of the old plan."""
    if not previous_actions or not previous_boundaries:
        return boundaries
    retained = {
        previous_boundaries[index]
        for index in range(1, len(previous_boundaries) - 1)
        if any(abs(values[index] - values[index - 1]) > 1e-7 for values in previous_actions.values())
    }
    retained.add(previous_boundaries[-1])
    return tuple(sorted(set(boundaries) | {time for time in retained if boundaries[0] < time < boundaries[-1]}))


def refine_configs(
    configs: dict[str, ElementConfigData], original: Sequence[float], refined: Sequence[float]
) -> dict[str, ElementConfigData]:
    """Carry the same forecast values into split intervals in both solves."""
    period_indices = np.searchsorted(original, refined[:-1], side="right") - 1

    def expand(value: object) -> object:
        if isinstance(value, np.ndarray) and value.ndim == 1:
            if len(value) == len(original) - 1:
                return value[period_indices]
            if len(value) == len(original):
                if value.dtype == np.dtype(bool):
                    indices = np.searchsorted(original, refined, side="right") - 1
                    return value[indices]
                return np.interp(refined, original, value)
        if isinstance(value, Mapping):
            return {key: expand(item) for key, item in value.items()}
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, tuple):
            return tuple(expand(item) for item in value)
        return value

    return cast(dict[str, ElementConfigData], expand(configs))


@dataclass(frozen=True, slots=True)
class PlanAssessment:
    """Result of comparing the candidate with the retained schedule and its tail."""

    reason: str
    incumbent_cost: float | None = None
    continuation: Network | None = None
    conflicts: tuple[RowLabel, ...] = ()
    benefit_drivers: str | None = None
    benefit: float | None = None
    gate_incumbent_cost: float | None = None
    gate_candidate_cost: float | None = None


def assess_plan(
    configs: dict[str, ElementConfigData],
    periods: Sequence[float],
    boundaries: Sequence[float],
    actions: Mapping[str, tuple[float, ...]],
    cost: float,
    previous_boundaries: Sequence[float],
    previous_actions: Mapping[str, tuple[float, ...]] | None,
    threshold: float,
    candidate: Network | None = None,
    weights: TariffWeights | None = None,
) -> PlanAssessment:
    """Keep the old controllable schedule throughout the overlap and optimize only the tail."""
    if not previous_actions or actions.keys() != previous_actions.keys():
        return PlanAssessment("bootstrap")
    if boundaries[0] < previous_boundaries[0] or boundaries[0] >= previous_boundaries[-1]:
        return PlanAssessment("expired")

    indices = [
        bisect_right(previous_boundaries, time) - 1
        for time in boundaries[:-1]
        if time < previous_boundaries[-1]
    ]
    committed = {name: tuple(values[index] for index in indices) for name, values in previous_actions.items()}
    network = build_network("incumbent", configs, periods, relax_infeasible=False)
    try:
        benchmark = network.optimize_incumbent(committed)
    except InfeasibleError as error:
        return PlanAssessment("incumbent_infeasible", conflicts=error.conflicts)
    benefit = benchmark - cost
    gate_old = gate_new = None
    drivers = None
    if candidate is not None:
        adjustments = grid_tariff_adjustments(configs, boundaries, weights) if weights is not None else None
        terminal_weight = 1.0
        if weights is not None and weights.time_enabled:
            hours = (boundaries[-1] - boundaries[0]) / 3600
            retention = tariff_retention(np.array([0.0, hours]), weights)[1]
            terminal_weight = weights.confidence_floor + (1 - weights.confidence_floor) * retention
        old_costs = network.primary_cost_by_element(adjustments, terminal_weight)
        new_costs = candidate.primary_cost_by_element(adjustments, terminal_weight)
        if weights is not None:
            gate_old, gate_new = sum(old_costs.values()), sum(new_costs.values())
            benefit = gate_old - gate_new
        changes = [(name, old - new_costs.get(name, 0.0)) for name, old in old_costs.items()]
        largest = sorted(changes, key=lambda change: abs(change[1]), reverse=True)[:3]
        drivers = ", ".join(
            f"{' '.join(filter(None, label))} {amount:+.3f}" for label, amount in largest if abs(amount) >= 0.001
        ) or None
    accepted = benefit > threshold
    return PlanAssessment(
        "accepted" if accepted else "below_threshold",
        benchmark,
        None if accepted else network,
        benefit_drivers=drivers,
        benefit=benefit,
        gate_incumbent_cost=gate_old,
        gate_candidate_cost=gate_new,
    )
