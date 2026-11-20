"""Read bounded, display-only price forecasts without optimizer dependencies."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import math
from typing import TYPE_CHECKING

from custom_components.haeo_homusman.core.schema.elements.grid import RAW_PRICE_FIELDS

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant

MAX_REFERENCE_POINTS = 2048


def price_reference_points(attributes: Mapping[str, object]) -> list[list[float]]:
    """Normalize a HAEO/Amber time-value forecast to seconds and dollars/kWh."""
    unit = attributes.get("unit_of_measurement")
    if unit not in ("$/kWh", "AUD/kWh", "c/kWh", "¢/kWh"):
        return []
    multiplier = 0.01 if unit in ("c/kWh", "¢/kWh") else 1.0
    forecast = attributes.get("forecast")
    if not isinstance(forecast, list | tuple) or not 1 <= len(forecast) <= MAX_REFERENCE_POINTS:
        return []
    points: list[list[float]] = []
    try:
        for point in forecast:
            if not isinstance(point, Mapping):
                return []
            raw_time, raw_value = point.get("time"), point.get("value")
            at = datetime.fromisoformat(raw_time) if isinstance(raw_time, str) else raw_time
            if (
                not isinstance(at, datetime)
                or at.tzinfo is None
                or not isinstance(raw_value, int | float | str)
                or isinstance(raw_value, bool)
            ):
                return []
            value = float(raw_value) * multiplier
            if not math.isfinite(value) or (points and at.timestamp() <= points[-1][0]):
                return []
            points.append([at.timestamp(), value])
        raw_end = attributes.get("forecast_end") or forecast[-1].get("end_time")
        end = datetime.fromisoformat(raw_end) if isinstance(raw_end, str) else raw_end
        if isinstance(end, datetime) and end.tzinfo is not None:
            end_time = end.timestamp()
        elif len(points) > 1:
            end_time = points[-1][0] + points[-1][0] - points[-2][0]
        else:
            return []
        if end_time > points[-1][0]:
            points.append([end_time, points[-1][1]])
        return points
    except (TypeError, ValueError, OverflowError):
        return []


def reference_price_forecasts(hass: HomeAssistant, entry: ConfigEntry | None) -> dict:
    """Collect optional reference sensors independently of required model inputs."""
    result = {}
    if entry is None:
        return result
    for subentry in entry.subentries.values():
        for field in RAW_PRICE_FIELDS:
            entity_id = subentry.data.get(field)
            state = hass.states.get(entity_id) if isinstance(entity_id, str) else None
            if state is None or state.state in ("unknown", "unavailable"):
                continue
            if points := price_reference_points(state.attributes):
                result.setdefault(subentry.title, {})["display." + field] = points
    return result
