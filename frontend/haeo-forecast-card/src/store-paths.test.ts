import { describe, expect, it } from "vitest";

import { computePowerDifferences, computeSocPaths } from "./store-paths";
import type { ForecastSeries } from "./types";

function socSeries(overrides: Partial<ForecastSeries>): ForecastSeries {
  return {
    key: "battery:soc",
    entityId: "sensor.battery_soc",
    label: "Battery state of charge",
    elementName: "Battery",
    elementType: "battery",
    outputName: "battery_state_of_charge",
    outputType: "state_of_charge",
    direction: null,
    sourceRole: "output",
    configMode: null,
    fixed: false,
    priority: null,
    lane: "soc",
    drawType: "line",
    unit: "%",
    color: "#22c55e",
    times: new Float64Array([0, 1]),
    values: new Float64Array([50, 40]),
    ...overrides,
  };
}

describe("computeSocPaths", () => {
  it("marks directional lines as thresholds and leaves battery lines plain", () => {
    const paths = computeSocPaths(
      [
        socSeries({}),
        socSeries({ key: "backup:soc", elementName: "Backup", elementType: "buffer", direction: "+" }),
        socSeries({ key: "room:soc", elementName: "Room", elementType: "buffer", direction: "-" }),
      ],
      { min: -1, max: 1 },
      { min: 0, max: 100 },
      0,
      100,
      (time) => time * 10
    );

    expect(paths.map((path) => path.className)).toEqual([undefined, "thresholdLine", "thresholdLine"]);
  });
});

it("shades the exact power difference over common intervals in both directions", () => {
  const series = socSeries({
    key: "export",
    lane: "power",
    outputType: "power",
    elementType: "grid",
    outputName: "grid_power_export",
    direction: "-",
    drawType: "step",
    times: Float64Array.from([0, 10, 20]),
    values: Float64Array.from([1, 3, 0]),
  });
  const comparison = { ...series, times: Float64Array.from([5, 15, 25]), values: Float64Array.from([2, 2, 0]) };
  const selected = new Set(["export"]);
  const range = { min: 0, max: 25 };
  const identity = (value: number): number => value;
  const paths = computePowerDifferences([series], [comparison], selected, range, "overlay", identity, identity);
  expect(paths.map(({ direction }) => direction)).toEqual(["higher", "lower"]);
  expect(paths[0]?.path).toBe("M 5 1 H 10 V 2 H 5 Z ");
  expect(paths[1]?.path).toBe("M 10 3 H 15 V 2 H 10 Z M 15 3 H 20 V 2 H 15 Z ");
  expect(computePowerDifferences([series], [comparison], new Set(), range, "overlay", identity, identity)).toEqual([]);
});
