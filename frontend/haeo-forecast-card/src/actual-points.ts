import type { RecorderState } from "./plan-view";
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

/** Keep the first, last, extrema and an unavailable reading in each plot bucket. */
export function downsampleRecorderStates(states: RecorderState[], windowMs: number): RecorderState[] {
  const bucketMs = Math.max(1000, windowMs / 240);
  let bucket = -Infinity;
  let readings: RecorderState[] = [];
  const result: RecorderState[] = [];
  const flush = (): void => {
    if (!readings.length) return;
    let min = Infinity,
      max = -Infinity;
    let minIndex = 0,
      maxIndex = 0,
      gapIndex = -1;
    for (const [index, reading] of readings.entries()) {
      const value = reading.s.trim() ? Number(reading.s) : NaN;
      if (!Number.isFinite(value)) {
        if (gapIndex < 0) gapIndex = index;
        continue;
      }
      if (value < min) {
        min = value;
        minIndex = index;
      }
      if (value > max) {
        max = value;
        maxIndex = index;
      }
    }
    const recoveryIndex =
      gapIndex < 0
        ? -1
        : readings.findIndex(
            (reading, index) => index > gapIndex && reading.s.trim() !== "" && Number.isFinite(Number(reading.s))
          );
    const indices = new Set([0, minIndex, maxIndex, gapIndex, recoveryIndex, readings.length - 1]);
    for (const index of [...indices].sort((a, b) => a - b)) {
      if (index >= 0) result.push(readings[index]!);
    }
    readings = [];
  };
  for (const state of states) {
    const time = (state.lu ?? state.lc ?? NaN) * 1000;
    if (!Number.isFinite(time)) continue;
    const nextBucket = Math.floor(time / bucketMs);
    if (bucket !== nextBucket) {
      flush();
      bucket = nextBucket;
    }
    readings.push(state);
  }
  flush();
  return result;
}
