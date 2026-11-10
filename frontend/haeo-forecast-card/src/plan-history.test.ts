import { downsampleRecorderStates } from "./actual-points";
import { describe, expect, it } from "vitest";
import { archivedSeries, clipPlanPoints } from "./archived-series";
import { historicSegments, type PlanSummary } from "./plan-view";

const plan = (seconds: number, reason = "accepted", ended?: number): PlanSummary => ({
  id: String(seconds),
  accepted_at: new Date(seconds * 1000).toISOString(),
  ended_at: ended === undefined ? null : new Date(ended * 1000).toISOString(),
  ends: seconds + 100,
  decision: { reason, benefit: null },
});

describe("history segments", () => {
  it("ends a followed plan at the next acceptance and leaves gaps for ungated solves", () => {
    const segments = historicSegments([plan(30), plan(20, "gate_disabled"), plan(10)], 40_000);
    expect(segments.map(({ start, end }) => [start, end])).toEqual([
      [10_000, 20_000],
      [30_000, 40_000],
    ]);
  });

  it("stops at closure or horizon expiry", () => {
    const segments = historicSegments([plan(30, "accepted", 35), plan(10)], 160_000);
    expect(segments.map(({ start, end }) => [start, end])).toEqual([
      [10_000, 30_000],
      [30_000, 35_000],
    ]);
    expect(historicSegments([plan(10)], 160_000)[0]?.end).toBe(110_000);
  });

  it("clips forecast points with the appropriate interpolation", () => {
    expect(
      clipPlanPoints(
        [
          [0, 1],
          [10, 3],
          [20, 5],
        ],
        5,
        15,
        false
      )
    ).toEqual([
      [5, 1],
      [10, 3],
      [15, 3],
    ]);
    expect(
      clipPlanPoints(
        [
          [0, 1],
          [10, 3],
          [20, 5],
        ],
        5,
        15,
        true
      )
    ).toEqual([
      [5, 2],
      [10, 3],
      [15, 4],
    ]);
    expect(
      clipPlanPoints(
        [
          [0, 1],
          [10, 3],
        ],
        12,
        20,
        false
      )
    ).toEqual([]);
  });
});

it("carries the previous saved cost when a same-input benefit is unavailable", () => {
  const first = plan(10);
  first.decision.candidate_cost = 2.5;
  const next = plan(20, "incumbent_infeasible");
  next.decision.candidate_cost = 2;
  const segments = historicSegments([next, first], 30_000);
  expect(segments[1]?.previousCost).toBe(2.5);
  expect(segments[1]?.plan.decision.benefit).toBeNull();
});

it("loads the pinned tariff from its archived input instead of a live tariff", () => {
  const summary = plan(10);
  const source = {
    entityId: "number.tariff",
    outputName: "price",
    drawType: "step",
  } as import("./types").ForecastSeries;
  const hass = {
    states: {
      "number.tariff": {
        entity_id: "number.tariff",
        attributes: { element_name: "Grid", field_path: "pricing.import" },
      },
    },
  };
  const detail = {
    ...summary,
    boundaries: [10, 20],
    series: {},
    inputs: {
      Grid: {
        "pricing.import": [
          [10, 0.3],
          [20, 0.4],
        ] as [number, number][],
      },
    },
  };
  const [archived] = archivedSeries([source], hass, detail);
  expect(Array.from(archived!.times)).toEqual([10000, 20000]);
  expect(Array.from(archived!.values)).toEqual([0.3, 0.4]);
  const revised = {
    ...detail,
    execution_until: 15,
    execution_inputs: { Grid: { "pricing.import": [[10, 0.5], [15, 0.6]] as [number, number][] } },
  };
  const [followed] = archivedSeries([source], hass, revised, undefined, undefined, true);
  expect(Array.from(followed!.values)).toEqual([0.5, 0.6]);
  expect(Array.from(followed!.times)).toEqual([10000, 15000]);
  const [snapshot] = archivedSeries([source], hass, revised);
  expect(Array.from(snapshot!.values)).toEqual([0.3, 0.4]);
  expect(archivedSeries([source], hass, { ...summary, boundaries: [10, 20], series: {} })).toEqual([]);
});

it("reduces long Recorder windows and retains extrema, gaps and endpoints", () => {
  const readings = Array.from({ length: 3600 }, (_, lu) => ({
    lu,
    s: lu === 155 ? "unavailable" : lu === 157 ? "999" : lu === 159 ? "-999" : "1",
  }));
  const short = downsampleRecorderStates(readings, 15 * 60_000);
  const long = downsampleRecorderStates(readings, 48 * 3600_000);
  expect(long.length).toBeLessThan(short.length / 10);
  expect(long[0]).toBe(readings[0]);
  expect(long.at(-1)).toBe(readings.at(-1));
  for (const index of [155, 157, 159]) expect(long).toContain(readings[index]);
});
