import { entityIdsForHub } from "./hub-selection";
import type { HassLike } from "./series";
import type { ForecastCardConfig, ForecastSeries } from "./types";

const inputForOutput: Readonly<Record<string, string>> = {
  battery_state_of_charge: "initial_charge_percentage",
  ev_state_of_charge: "current_soc",
  load_power: "forecast",
  solar_power: "forecast",
};

export function discoverActualSources(
  hass: HassLike | null,
  config: ForecastCardConfig,
  series: ForecastSeries[]
): Record<string, string> {
  if (!hass || !config.hub_entry_id) return { ...config.actual_entities };
  const hubIds = entityIdsForHub(hass, config.hub_entry_id);
  const inputs = hubIds.map((id) => hass.states[id]?.attributes);
  const sources: Record<string, string> = {};
  for (const item of series) {
    const attributes = hass.states[item.entityId]?.attributes;
    if (!attributes) continue;
    if (item.outputName === "battery_power_charge" || item.outputName === "battery_power_discharge") {
      const battery = hubIds.find((id) => {
        const source = hass.states[id]?.attributes;
        return (
          source?.["element_name"] === attributes["element_name"] &&
          source?.["element_type"] === "battery" &&
          source?.["output_name"] === "battery_power_active"
        );
      });
      if (battery) sources[item.entityId] = battery;
      continue;
    }
    const field = inputForOutput[item.outputName];
    const matches = field
      ? inputs.filter(
          (input) =>
            input?.["element_name"] === attributes["element_name"] &&
            input?.["element_type"] === attributes["element_type"] &&
            input?.["field_name"] === field
        )
      : item.lane === "price" &&
          ["price_source_target", "price_target_source"].includes(String(attributes["field_name"]))
        ? [attributes]
        : [];
    const ids = matches.length === 1 ? matches[0]?.["source_entities"] : undefined;
    if (Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string" && ids[0].startsWith("sensor.")) {
      sources[item.entityId] = ids[0];
    }
  }
  return { ...sources, ...config.actual_entities };
}
