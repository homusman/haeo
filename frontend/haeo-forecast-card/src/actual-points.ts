import type { Point } from "./archived-series";
import type { ForecastCardStore } from "./store";
import type { ForecastSeries } from "./types";

export function actualPoints(store: ForecastCardStore, series: ForecastSeries): Point[] {
  const id = store.actualSources[series.entityId];
  if (!id) return [];
  const unit = store.hass?.states[id]?.attributes["unit_of_measurement"];
  const scales: Record<string, number> = { W: 1, kW: 1000, MW: 1_000_000 };
  const sourceScale = typeof unit === "string" ? scales[unit] : undefined;
  const targetScale = scales[series.unit];
  const scale = unit === series.unit ? 1 : sourceScale && targetScale ? sourceScale / targetScale : null;
  if (scale === null) return [];
  const data = store.actuals[id] ?? [];
  const name = store.hass?.states[series.entityId]?.attributes["element_name"];
  const configured = typeof name === "string" ? store.powerMeasurements[name] : undefined;
  const linked = configured?.entity_id === id;
  const negative = ["battery_power_charge", "ev_power_charge", "grid_power_export", "inverter_power_ac_to_dc"].includes(
    series.outputName
  );
  const positive = [
    "battery_power_discharge",
    "ev_power_discharge",
    "grid_power_import",
    "inverter_power_dc_to_ac",
  ].includes(series.outputName);
  const points: Point[] = data.map(({ lu, lc, s }) => {
    const value = s.trim() ? Number(s) * scale * (linked && configured.inverted ? -1 : 1) : NaN;
    return [
      (lu ?? lc ?? NaN) * 1000,
      linked && (positive || negative) ? Math.max(0, negative ? -value : value) : value,
    ];
  });
  const visible = points.filter(([time]) => Number.isFinite(time) && time <= store.historyClock).slice(-8000);
  const last = visible.at(-1);
  if (last && last[0] < store.historyClock && Number.isFinite(last[1])) visible.push([store.historyClock, last[1]]);
  return visible;
}

export function measuredAt(points: Point[], time: number): number | undefined {
  if (!points.length || time < points[0]![0] || time > points.at(-1)![0]) return undefined;
  for (let index = points.length - 1; index >= 0; index--) {
    const [at, value] = points[index]!;
    if (at <= time) return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}
