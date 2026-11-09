import { stepArrayIndex } from "./hover";
import { linearScale, linePath, stepAreaPath, stepPath } from "./geometry";
import { classifyPowerSeries } from "./power-series-classification";
import type { ForecastSeries, LaneBounds, PowerDisplayMode } from "./types";
import { emptySectionStacks, powerSection, powerValueForDisplay, stepTopStrokePaths } from "./power-display";

export interface PowerShape {
  key: string;
  color: string;
  d: string;
  isPotential: boolean;
  strokePaths: string[];
}

export interface LineSvgPath {
  key: string;
  color: string;
  d: string;
  /** Extra class for lines drawn as thresholds rather than measured values. */
  className?: string;
}

export function computePowerShapes(
  orderedPowerSeries: ForecastSeries[],
  powerBounds: LaneBounds,
  powerDisplayMode: PowerDisplayMode,
  plotTop: number,
  plotBottom: number,
  xScale: (time: number) => number
): PowerShape[] {
  const firstSeries = orderedPowerSeries[0];
  if (!firstSeries) {
    return [];
  }
  const { min: powerMin, max: powerMax } = powerBounds;
  const yScalePower = (value: number): number => linearScale(value, powerMin, powerMax, plotBottom, plotTop);
  const horizonCount = firstSeries.times.length;
  const stacks = emptySectionStacks(horizonCount);

  return orderedPowerSeries.map((series) => {
    const category = classifyPowerSeries(series);
    const section = powerSection(series);
    const stack = stacks[section];
    const lower = new Float64Array(horizonCount);
    const upper = new Float64Array(horizonCount);
    const displayValues = new Float64Array(horizonCount);
    for (let idx = 0; idx < horizonCount; idx += 1) {
      const value = powerValueForDisplay(series, series.values[idx] ?? 0, powerDisplayMode);
      displayValues[idx] = value;
      lower[idx] = stack[idx] ?? 0;
      const next = (stack[idx] ?? 0) + value;
      upper[idx] = next;
      stack[idx] = next;
    }
    return {
      key: series.key,
      color: series.color,
      isPotential: category.subgroup === "potential",
      strokePaths: stepTopStrokePaths(series.times, upper, displayValues, xScale, yScalePower),
      d: stepAreaPath(series.times, lower, upper, xScale, yScalePower),
    };
  });
}

export interface PowerDifference {
  key: string;
  color: string;
  direction: "higher" | "lower";
  path: string;
}

export function computePowerDifferences(
  current: ForecastSeries[],
  comparison: ForecastSeries[],
  highlighted: ReadonlySet<string>,
  range: { min: number; max: number },
  mode: PowerDisplayMode,
  x: (time: number) => number,
  y: (power: number) => number
): PowerDifference[] {
  const differences: PowerDifference[] = [];
  for (const [index, series] of comparison.entries()) {
    if (!highlighted.has(series.key)) continue;
    const original = current.find((item) => item.key === series.key);
    if (!original || series.times.length < 2 || original.times.length < 2) continue;
    const start = Math.max(range.min, series.times[0]!, original.times[0]!);
    const end = Math.min(range.max, series.times.at(-1)!, original.times.at(-1)!);
    if (!(start < end)) continue;
    const base = comparison.slice(0, index).filter((item) => powerSection(item) === powerSection(series));
    const times = new Set([start, end]);
    for (const item of [series, original, ...base]) {
      for (const time of item.times) if (start < time && time < end) times.add(time);
    }
    const ordered = [...times].sort((a, b) => a - b);
    const paths = { higher: "", lower: "" };
    const valueAt = (item: ForecastSeries, time: number): number => {
      if (time < item.times[0]! || time >= item.times.at(-1)!) return 0;
      return powerValueForDisplay(item, item.values[stepArrayIndex(item.times, time)] ?? 0, mode);
    };
    for (let i = 0; i < ordered.length - 1; i++) {
      const at = ordered[i]!;
      const a = valueAt(original, at);
      const b = valueAt(series, at);
      if (Math.abs(a - b) < 1e-6) continue;
      const stack = base.reduce((sum, item) => sum + valueAt(item, at), 0);
      const x1 = x(at);
      const x2 = x(ordered[i + 1]!);
      const y1 = y(stack + a);
      const y2 = y(stack + b);
      const direction = Math.abs(b) > Math.abs(a) ? "higher" : "lower";
      paths[direction] += "M " + x1 + " " + y1 + " H " + x2 + " V " + y2 + " H " + x1 + " Z ";
    }
    for (const direction of ["higher", "lower"] as const) {
      if (paths[direction])
        differences.push({ key: series.key, color: series.color, direction, path: paths[direction] });
    }
  }
  return differences;
}

export function computeHoveredPowerKeys(
  orderedPowerSeries: ForecastSeries[],
  hoverIndices: Map<string, number>,
  powerDisplayMode: PowerDisplayMode,
  powerBounds: LaneBounds,
  plotTop: number,
  plotBottom: number,
  pointerY: number
): Set<string> {
  const hovered = new Set<string>();
  if (orderedPowerSeries.length === 0) {
    return hovered;
  }
  const { min: powerMin, max: powerMax } = powerBounds;
  const yScalePower = (value: number): number => linearScale(value, powerMin, powerMax, plotBottom, plotTop);
  const stackedAtHover = new Map([
    ["available" as const, 0],
    ["produced" as const, 0],
    ["consumed" as const, 0],
    ["possible" as const, 0],
  ]);
  for (const s of orderedPowerSeries) {
    const idx = hoverIndices.get(s.key) ?? 0;
    const value = powerValueForDisplay(s, s.values[idx] ?? 0, powerDisplayMode);
    if (Math.abs(value) < 1e-6) {
      continue;
    }
    const section = powerSection(s);
    const lower = stackedAtHover.get(section) ?? 0;
    const upper = lower + value;
    stackedAtHover.set(section, upper);
    const y1 = yScalePower(lower);
    const y2 = yScalePower(upper);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    if (pointerY >= top && pointerY <= bottom) {
      hovered.add(s.key);
    }
  }
  return hovered;
}

export function computePricePaths(
  priceSeries: ForecastSeries[],
  powerBounds: LaneBounds,
  priceBounds: LaneBounds,
  plotTop: number,
  plotBottom: number,
  xScale: (time: number) => number
): LineSvgPath[] {
  const { min: powerMin, max: powerMax } = powerBounds;
  const { min: priceMin, max: priceMax } = priceBounds;
  const zeroY = linearScale(0, powerMin, powerMax, plotBottom, plotTop);
  const yScalePrice = (value: number): number => {
    if (value >= 0) {
      const positiveMax = Math.max(priceMax, 0.001);
      return linearScale(value, 0, positiveMax, zeroY, plotTop);
    }
    const negativeMin = Math.min(priceMin, -0.001);
    return linearScale(value, negativeMin, 0, plotBottom, zeroY);
  };
  return priceSeries.map((series) => ({
    key: series.key,
    color: series.color,
    d: stepPath(series.times, series.values, xScale, yScalePrice),
  }));
}

export function computeSocPaths(
  socSeries: ForecastSeries[],
  powerBounds: LaneBounds,
  socBounds: LaneBounds,
  plotTop: number,
  plotBottom: number,
  xScale: (time: number) => number
): LineSvgPath[] {
  const { min: powerMin, max: powerMax } = powerBounds;
  const zeroY = linearScale(0, powerMin, powerMax, plotBottom, plotTop);
  const { min: socMin, max: socMax } = socBounds;
  const yScaleSoc = (value: number): number => linearScale(value, socMin, socMax, zeroY, plotTop);
  return socSeries.map((series) => ({
    key: series.key,
    color: series.color,
    d: linePath(series.times, series.values, xScale, yScaleSoc),
    // A directional line is a level the batteries are held ready to discharge from or charge into, so it is drawn as a threshold
    ...(series.direction !== null ? { className: "thresholdLine" } : {}),
  }));
}
