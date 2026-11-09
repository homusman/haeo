import { expect, it } from "vitest";
import { discoverActualSources } from "./actual-sources";
import type { HassLike } from "./series";
import type { ForecastSeries } from "./types";

it("uses the battery SoC input from the selected hub and keeps explicit overrides", () => {
  const hass: HassLike = {
    states: {},
    entities: {},
    devices: {
      fork: { config_entries: ["fork"] },
      vanilla: { config_entries: ["vanilla"] },
    },
  };
  function add(entity_id: string, device_id: string, attributes: Record<string, unknown>): void {
    hass.states[entity_id] = {
      entity_id,
      attributes: { element_name: "Battery", element_type: "battery", ...attributes },
    };
    hass.entities![entity_id] = { device_id };
  }
  add("sensor.fork_soc", "fork", {});
  add("number.fork_soc_input", "fork", {
    field_name: "initial_charge_percentage",
    source_entities: ["sensor.measured_soc"],
  });
  add("number.vanilla_soc_input", "vanilla", {
    field_name: "initial_charge_percentage",
    source_entities: ["sensor.other_soc"],
  });
  const series = [{ entityId: "sensor.fork_soc", outputName: "battery_state_of_charge" } as ForecastSeries];
  const config = { type: "custom:haeo-homusman-forecast-card", hub_entry_id: "fork" } as const;
  expect(discoverActualSources(hass, config, series)).toEqual({ "sensor.fork_soc": "sensor.measured_soc" });
  expect(
    discoverActualSources(hass, { ...config, actual_entities: { "sensor.fork_soc": "sensor.override" } }, series)
  ).toEqual({ "sensor.fork_soc": "sensor.override" });
  add("number.second_soc_input", "fork", {
    field_name: "initial_charge_percentage",
    source_entities: ["sensor.second"],
  });
  expect(discoverActualSources(hass, config, series)).toEqual({});
});
