import type { JSX } from "preact";
import { linePath, stepPath } from "../geometry";
import { observer } from "../mobx-observer";
import { archivedSeries, clipPlanPoints, type Point } from "../archived-series";
import { OverlayLineLayer } from "./OverlayLineLayer";
import { PowerStackLayer } from "./PowerStackLayer";
import { powerValueForDisplay } from "../power-display";
import type { ForecastCardStore } from "../store";
import type { ForecastSeries } from "../types";

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

function actualPoints(store: ForecastCardStore, series: ForecastSeries): Point[] {
  const id = store.actualSources[series.entityId];
  if (!id) return [];
  const unit = store.hass?.states[id]?.attributes["unit_of_measurement"];
  const scales: Record<string, number> = { W: 1, kW: 1000, MW: 1_000_000 };
  const sourceScale = typeof unit === "string" ? scales[unit] : undefined;
  const targetScale = scales[series.unit];
  const scale = unit === series.unit ? 1 : sourceScale && targetScale ? sourceScale / targetScale : null;
  if (scale === null) return [];
  const data = store.actuals[id] ?? [];
  const points: Point[] = data.map(({ lu, lc, s }) => [(lu ?? lc ?? NaN) * 1000, s.trim() ? Number(s) * scale : NaN]);
  return points.filter(([time]) => Number.isFinite(time) && time <= store.historyClock).slice(-8000);
}

export const HistoryLayer = observer(function HistoryLayer({
  store,
}: {
  store: ForecastCardStore;
}): JSX.Element | null {
  if (!store.pastHours) return null;
  const { min, max } = store.xDomain;
  const selected = store.hoveredPlan;
  const comparison = selected ? store.historyDetails[selected.plan.id] : undefined;
  const visible = store.visibleSeries.filter(({ lane }) => lane === "power" || lane === "price" || lane === "soc");
  return (
    <g className="historyLayer" pointer-events="none">
      {store.segments.map(({ plan, start, end }) => {
        const detail = store.historyDetails[plan.id];
        if (!detail) return null;
        const isPreview = comparison?.id === plan.id;
        const ranges = isPreview
          ? [[min, store.candidatePreview ? Math.min(max, store.historyClock) : max]]
          : comparison
            ? [
                [start, Math.min(end, comparison.boundaries[0]! * 1000)],
                [Math.max(start, comparison.boundaries.at(-1)! * 1000), end],
              ]
            : [[start, end]];
        return ranges.map(([from, to], index) => {
          const series = archivedSeries(visible, store.hass, detail, Math.max(min, from!), Math.min(max, to!));
          if (!series.length) return null;
          const shapes = store.pathsForSeries(series);
          return (
            <g key={plan.id + index} opacity={isPreview ? 0.55 : undefined}>
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
        });
      })}
      {store.segments.length > 0 &&
        visible.map((series) => {
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
      {selected &&
        !store.candidatePreview &&
        visible
          .filter((series) => store.actualSources[series.entityId])
          .map((series) => {
            const points: Point[] = Array.from(series.times, (time, index) => [time, series.values[index]!]);
            const clipped = clipPlanPoints(points, store.historyClock, max, series.drawType === "line");
            return (
              <path
                key={series.key}
                d={path(store, series, clipped)}
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
