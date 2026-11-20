import { describe, expect, it } from "vitest";
import { h, render } from "preact";
import { ChartSvg } from "./components/ChartSvg";
import { ForecastCardStore } from "./store";
import { referencePriceSeries } from "./reference-prices";
import { DEFAULT_TEST_HUB, loadScenarioHassState } from "./fixtures/scenarioOutputs";

describe("display-only raw tariff references", () => {
  function setup() {
    const store = new ForecastCardStore();
    store.setHass(loadScenarioHassState("scenario2"));
    store.setConfig({ type: "custom:haeo-homusman-forecast-card", hub_entry_id: DEFAULT_TEST_HUB });
    return store;
  }

  it("matches tariff direction, preserves color and converts timestamp seconds", () => {
    const store = setup();
    const series = store.priceSeries.find((item) => item.elementType === "grid" && item.direction === "+")!;
    expect(series).toBeDefined();
    const original = Array.from(series.values);
    const result = referencePriceSeries([series], {
      [series.elementName]: { "display.raw_import_price": [[100, 0.2], [200, 10]] },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.color).toBe(series.color);
    expect(Array.from(result[0]!.times)).toEqual([100000, 200000]);
    expect(Array.from(result[0]!.values)).toEqual([0.2, 10]);
    expect(Array.from(series.values)).toEqual(original);
    expect(referencePriceSeries([series], {
      [series.elementName]: { "display.raw_export_price": [[100, 0.3], [200, 1]] },
    })).toEqual([]);
  });

  it("does not change plotted optimizer series, domains or a pin when references update", () => {
    const store = setup();
    const plotted = store.plottedSeries.map((series) => series.key);
    const domain = { ...store.xDomain };
    store.pinnedPlanId = "keep-me";
    store.setReferencePrices({ Grid: { "display.raw_import_price": [[1, 0.2], [2, 10]] } });
    expect(store.plottedSeries.map((series) => series.key)).toEqual(plotted);
    expect(store.xDomain).toEqual(domain);
    expect(store.pinnedPlanId).toBe("keep-me");
    // Old archived plans have no reference snapshots; never substitute live prices.
    expect(store.referencePricePaths(true)).toEqual([]);
  });

  it("renders dotted SVG paths and uses the saved raw forecast in comparison", () => {
    const store = setup();
    const series = store.priceSeries.find((item) => item.elementType === "grid" && item.direction === "+")!;
    const start = series.times[0]! / 1000;
    const points: [number, number][] = [[start, 0.2], [start + 3600, 0.8]];
    const field = store.hass!.states[series.entityId]!.attributes["field_path"];
    const inputs = { [series.elementName]: {
      "display.raw_import_price": points,
      ...(typeof field === "string" ? { [field]: points } : {}),
    } };
    store.setReferencePrices(inputs);
    const root = document.createElement("div");
    render(h(ChartSvg, { store, onPointerMove: () => {}, onPointerLeave: () => {} }), root);
    const path = root.querySelector('path[stroke-dasharray="2 4"]');
    expect(path?.getAttribute("d")).toBeTruthy();
    expect(path?.getAttribute("stroke")).toBe(series.color);
    render(null, root);
    store.setCandidatePreview({
      id: "candidate", accepted_at: new Date(start * 1000).toISOString(), ended_at: null,
      ends: start + 3600, boundaries: [start, start + 3600],
      decision: { reason: "benefit", benefit: 1 }, inputs,
      series: { [series.elementName]: { [series.outputName]: points } },
    });
    const comparison = store.referencePricePaths(true);
    expect(comparison.length).toBeGreaterThan(0);
    store.setReferencePrices({ [series.elementName]: {
      "display.raw_import_price": [[start, 99], [start + 3600, 99]],
    } });
    expect(store.referencePricePaths(true)).toEqual(comparison);
  });
});
