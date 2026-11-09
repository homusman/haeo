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
  const signedBattery = store.hass?.states[id]?.attributes["output_name"] === "battery_power_active";
  const points: Point[] = data.map(({ lu, lc, s }) => {
    const value = s.trim() ? Number(s) * scale : NaN;
    return [
      (lu ?? lc ?? NaN) * 1000,
      signedBattery ? Math.max(0, series.outputName === "battery_power_charge" ? -value : value) : value,
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
