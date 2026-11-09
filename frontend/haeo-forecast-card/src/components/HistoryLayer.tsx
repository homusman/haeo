import type { JSX } from "preact";
import { linePath, stepPath } from "../geometry";
import { observer } from "../mobx-observer";
import type { PlanDetail } from "../plan-view";
import { powerValueForDisplay } from "../power-display";
import type { ForecastCardStore } from "../store";
import type { ForecastSeries } from "../types";

type Point = [number, number];

function planPoints(store: ForecastCardStore, plan: PlanDetail, series: ForecastSeries): Point[] {
  const name = store.hass?.states[series.entityId]?.attributes["element_name"];
  const points = typeof name === "string" ? plan.series[name]?.[series.outputName] : undefined;
  if (!points?.length) return [];
  const result: Point[] = points.map(([time, value]) => [time * 1000, Number(value)]);
  const last = result.at(-1)!;
  const end = plan.boundaries.at(-1)! * 1000;
  if (series.drawType === "step" && last[0] < end) result.push([end, last[1]]);
  return result;
}

export function clipPlanPoints(points: Point[], start: number, end: number, linear: boolean): Point[] {
  if (points.length < 2 || start >= end) return [];
  const lower = Math.max(start, points[0]![0]);
  const upper = Math.min(end, points.at(-1)![0]);
  if (lower >= upper) return [];
  function valueAt(time: number): number {
    const next = points.findIndex(([at]) => at > time);
    if (next < 0) return points.at(-1)![1];
    const left = points[next - 1]!;
    const right = points[next]!;
    return linear ? left[1] + ((right[1] - left[1]) * (time - left[0])) / (right[0] - left[0]) : left[1];
  }
  return [[lower, valueAt(lower)], ...points.filter(([time]) => lower < time && time < upper), [upper, valueAt(upper)]];
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

function actualPoints(store: ForecastCardStore, series: ForecastSeries): Point[] {
  const id = store.config.actual_entities?.[series.entityId];
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
  if (!store.pastHours && !store.candidatePreview) return null;
  const { min, max } = store.xDomain;
  const selected = store.hoveredPlan;
  const comparison = selected ? store.historyDetails[selected.plan.id] : undefined;
  const visible = store.visibleSeries.filter(({ lane }) => lane === "power" || lane === "price" || lane === "soc");
  return (
    <g className="historyLayer" pointer-events="none">
      {store.segments.map(({ plan, start, end }) => {
        const detail = store.historyDetails[plan.id];
        return (
          detail &&
          visible.map((series) => {
            const points = planPoints(store, detail, series);
            const isPreview = comparison?.id === plan.id;
            const ranges =
              comparison && !isPreview
                ? [
                    [start, Math.min(end, comparison.boundaries[0]! * 1000)],
                    [Math.max(start, comparison.boundaries.at(-1)! * 1000), end],
                  ]
                : [[start, end]];
            const parts = isPreview
              ? [points]
              : ranges.map(([from, to]) =>
                  clipPlanPoints(points, Math.max(min, from!), Math.min(max, to!), series.drawType === "line")
                );
            return parts.map((part, index) => (
              <path
                key={plan.id + series.key + index}
                d={path(store, series, part)}
                fill="none"
                stroke={series.color}
                stroke-width={1.5}
                stroke-dasharray={isPreview ? "5 4" : undefined}
                opacity={isPreview ? 0.75 : 0.6}
              />
            ));
          })
        );
      })}
      {!selected &&
        store.candidatePreview &&
        visible.map((series) => {
          const points = planPoints(store, store.candidatePreview!, series);
          const clipped = clipPlanPoints(points, store.historyClock, max, series.drawType === "line");
          return (
            <path
              key={"candidate-" + series.key}
              d={path(store, series, clipped)}
              fill="none"
              stroke={series.color}
              stroke-width={2}
              stroke-dasharray="5 4"
            />
          );
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
        visible
          .filter((series) => store.config.actual_entities?.[series.entityId])
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
