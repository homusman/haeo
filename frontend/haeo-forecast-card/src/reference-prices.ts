import type { ForecastSeries } from "./types";

export type ReferencePrices = Record<string, Record<string, [number, number][]>>;

/** Pair raw references with visible optimizer tariffs; share their color and axes. */
export function referencePriceSeries(series: ForecastSeries[], references: ReferencePrices): ForecastSeries[] {
  return series.flatMap((item) => {
    if (item.lane !== "price" || item.elementType !== "grid" || !item.direction) return [];
    const field = item.direction === "+" ? "display.raw_import_price" : "display.raw_export_price";
    const points = references[item.elementName]?.[field];
    if (!points || points.length < 2) return [];
    return [{
      ...item,
      key: item.key + ":raw-reference",
      label: item.label + " (raw price, dotted)",
      times: Float64Array.from(points, ([time]) => time * 1000),
      values: Float64Array.from(points, ([, value]) => value),
    }];
  });
}
