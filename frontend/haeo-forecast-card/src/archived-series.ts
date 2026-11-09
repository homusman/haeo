import type { PlanDetail } from "./plan-view";
import type { HassLike } from "./series";
import type { ForecastSeries } from "./types";

export type Point = [number, number];

function planPoints(name: string | undefined, field: unknown, plan: PlanDetail, series: ForecastSeries): Point[] {
  const points =
    name === undefined
      ? undefined
      : typeof field === "string"
        ? plan.inputs?.[name]?.[field]
        : plan.series[name]?.[series.outputName];
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

export function archivedSeries(
  series: ForecastSeries[],
  hass: HassLike | null,
  plan: PlanDetail,
  from?: number,
  to?: number
): ForecastSeries[] {
  return series.flatMap((item) => {
    const attrs = hass?.states[item.entityId]?.attributes;
    const name = attrs?.["element_name"];
    const raw = planPoints(typeof name === "string" ? name : undefined, attrs?.["field_path"], plan, item);
    const points =
      from === undefined || to === undefined ? raw : clipPlanPoints(raw, from, to, item.drawType === "line");
    if (points.length < 2) return [];
    return [
      {
        ...item,
        times: Float64Array.from(points, ([time]) => time),
        values: Float64Array.from(points, ([, value]) => value),
      },
    ];
  });
}
