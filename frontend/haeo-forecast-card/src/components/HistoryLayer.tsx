import { actualPoints } from "../actual-points";
import type { JSX } from "preact";
import { linePath, stepAreaPath, stepPath } from "../geometry";
import { observer } from "../mobx-observer";
import { archivedSeries, type Point } from "../archived-series";
import { OverlayLineLayer } from "./OverlayLineLayer";
import { PowerStackLayer } from "./PowerStackLayer";
import { powerValueForDisplay } from "../power-display";
import type { ForecastCardStore } from "../store";
import type { ForecastSeries } from "../types";

function measuredPowerPaths(store: ForecastCardStore, visible: ForecastSeries[]) {
  const sources = new Set<string>();
  const groups = new Map<string, { series: ForecastSeries; points: Point[]; color: string }[]>();
  const recorded = store.normalizedSeries.filter(({ lane, sourceRole }) => lane === "power" && sourceRole !== "limit");
  for (const series of visible) {
    const source = store.actualSources[series.entityId];
    if (series.lane !== "power" || !source || series.sourceRole === "limit") continue;
    const key = JSON.stringify([series.elementName, source]);
    if (sources.has(key)) continue;
    const points = actualPoints(store, series, true);
    if (points.length < 2) continue;
    sources.add(key);
    for (const direction of ["+", "-"] as const) {
      const planned = recorded.find((item) =>
        item.elementName === series.elementName && item.direction === direction
        && store.actualSources[item.entityId] === source
      ) ?? series;
      const group = JSON.stringify([series.unit, direction]);
      const traces = groups.get(group) ?? [];
      const directional = points.map(([time, value]): Point => [
        time, (direction === "+" ? value > 0 : value < 0) ? value : NaN,
      ]);
      traces.push({ series: { ...planned, key: series.key + direction }, points: directional, color: series.color });
      groups.set(group, traces);
    }
  }
  const x = (time: number) => store.xScale(time);
  const y = (power: number) => store.yScalePower(power);
  return [...groups.values()].flatMap((traces) => {
    const times = [...new Set(traces.flatMap(({ points }) => points.map(([time]) => time)))].sort((a, b) => a - b);
    const stack = new Float64Array(times.length);
    const byKey = new Map(traces.map((trace) => [trace.series.key, trace]));
    return store.sortPowerSeries(traces.map(({ series }) => series)).map((series) => {
      const { points, color } = byKey.get(series.key)!;
      let cursor = -1;
      let start = 0;
      const lower = new Float64Array(times.length);
      const upper = new Float64Array(times.length);
      const areas: string[] = [];
      const flush = (end: number): void => {
        if (end <= start) return;
        // Duplicate the last interval values at its end to close the filled step.
        lower[end] = lower[end - 1]!;
        upper[end] = upper[end - 1]!;
        areas.push(stepAreaPath(
          Float64Array.from(times.slice(start, end + 1)),
          lower.slice(start, end + 1), upper.slice(start, end + 1), x, y,
        ));
      };
      for (let index = 0; index < times.length - 1; index++) {
        const time = times[index]!;
        while (cursor + 1 < points.length && points[cursor + 1]![0] <= time) cursor++;
        const value = cursor >= 0 && cursor < points.length - 1 ? points[cursor]![1] : NaN;
        if (!Number.isFinite(value)) {
          flush(index);
          start = index + 1;
          continue;
        }
        lower[index] = store.powerDisplayMode === "opposed" ? stack[index]! : 0;
        upper[index] = lower[index]! + value;
        stack[index] = upper[index]!;
      }
      flush(times.length - 1);
      return { series, color, d: areas.join(" ") };
    });
  });
}

function path(store: ForecastCardStore, series: ForecastSeries, points: Point[], actual = false): string {
  const draw = series.drawType === "step" ? stepPath : linePath;
  const y = (value: number): number => {
    if (series.lane === "power") return store.yScalePower(powerValueForDisplay(series, value, store.powerDisplayMode));
    if (series.lane === "soc") return store.yScaleSoc(value);
    return store.yScalePrice(value);
  };
  const runs: Point[][] = [[]];
  for (const point of points) {
    if (Number.isFinite(point[1])) runs.at(-1)!.push(point);
    else {
      const run = runs.at(-1)!;
      if (actual && run.length && series.drawType === "step") run.push([point[0], run.at(-1)![1]]);
      runs.push([]);
    }
  }
  return runs
    .filter((run) => run.length > 1)
    .map((run) =>
      draw(
        Float64Array.from(run, ([time]) => time),
        Float64Array.from(run, ([, value]) => value),
        (time) => store.xScale(time),
        y
      )
    )
    .join(" ");
}

export const HistoryLayer = observer(function HistoryLayer({
  store,
}: {
  store: ForecastCardStore;
}): JSX.Element | null {
  if (!store.pastHours) return null;
  const { min, max } = store.xDomain;
  const visible = store.visibleSeries.filter(({ lane }) => lane === "power" || lane === "price" || lane === "soc");
  return (
    <g className="historyLayer" pointer-events="none">
      {store.segments.map(({ plan, start, end }) => {
        const detail = store.historyDetails[plan.id];
        if (!detail) return null;
        const series = archivedSeries(visible, store.hass, detail, Math.max(min, start), Math.min(max, end), true);
        if (!series.length) return null;
        const shapes = store.pathsForSeries(series);
        return (
          <g key={plan.id}>
            <PowerStackLayer
              shapes={shapes.powerShapes}
              highlightedSeries={store.highlightedSeries}
              hoveredSeriesKeys={new Set()}
              focusedSeriesKeys={store.focusedLegendSeriesKeys}
            />
            <OverlayLineLayer
              paths={shapes.pricePaths}
              highlightedSeries={store.highlightedSeries}
              focusedSeriesKeys={store.focusedLegendSeriesKeys}
              cssClass="priceLine"
            />
            <OverlayLineLayer
              paths={shapes.socPaths}
              highlightedSeries={store.highlightedSeries}
              focusedSeriesKeys={store.focusedLegendSeriesKeys}
              cssClass="socLine"
            />
          </g>
        );
      })}
      {measuredPowerPaths(store, visible).map(({ series, color, d }) => (
        <path key={series.key} d={d} fill={color} fill-opacity={0.38} stroke={color} />
      ))}
      {visible.filter(({ lane }) => lane !== "power").map((series) => {
        const points = actualPoints(store, series);
        return (
          <path
            key={series.key}
            d={path(store, series, points, true)}
            fill="none"
            stroke={series.color}
            stroke-width={2}
          />
        );
      })}
      {store.segments
        .flatMap(({ start, end }) => [start, end])
        .filter((time, i, times) => times.indexOf(time) === i)
        .filter((time) => min <= time && time < store.historyClock)
        .map((time) => (
          <line
            key={time}
            x1={store.xScale(time)}
            x2={store.xScale(time)}
            y1={store.plotTop}
            y2={store.plotBottom}
            stroke="currentColor"
            stroke-dasharray="2 4"
            opacity={0.6}
          />
        ))}
      <line
        x1={store.xScale(store.historyClock)}
        x2={store.xScale(store.historyClock)}
        y1={store.plotTop}
        y2={store.plotBottom}
        stroke="currentColor"
        opacity={0.55}
      />
    </g>
  );
});
