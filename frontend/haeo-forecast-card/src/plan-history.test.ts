import { describe, expect, it } from "vitest";
import { clipPlanPoints } from "./archived-series";
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
