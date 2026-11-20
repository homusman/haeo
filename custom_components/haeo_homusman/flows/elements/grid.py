"""Grid element configuration flows."""

from collections.abc import Mapping
from typing import ClassVar

from homeassistant.helpers import selector
import voluptuous as vol

from custom_components.haeo_homusman.core.schema.elements.grid import ELEMENT_TYPE, RAW_PRICE_FIELDS
from custom_components.haeo_homusman.core.schema.sections import (
    CONF_MAX_POWER_SOURCE_TARGET,
    CONF_MAX_POWER_TARGET_SOURCE,
    CONF_PRICE_SOURCE_TARGET,
    CONF_PRICE_TARGET_SOURCE,
)
from custom_components.haeo_homusman.flows.connected_flow import ConnectedElementSubentryFlow
from custom_components.haeo_homusman.flows.field_schema import SectionDefinition
from custom_components.haeo_homusman.flows.sectioned_flow import FieldEntries
from custom_components.haeo_homusman.flows.sections import power_limits_section, pricing_section


class GridSubentryFlowHandler(ConnectedElementSubentryFlow):
    """Handle grid element configuration flows."""

    element_type = ELEMENT_TYPE

    def _top_level_entries(self, subentry_data: Mapping[str, object] | None) -> FieldEntries:
        """Add optional display-only raw tariff references."""
        return {
            **super()._top_level_entries(subentry_data),
            **{
                key: (vol.Optional(key), selector.EntitySelector(selector.EntitySelectorConfig(domain="sensor")))
                for key in RAW_PRICE_FIELDS
            },
        }

    def _top_level_defaults(self, subentry_data: Mapping[str, object] | None) -> dict[str, object]:
        """Restore saved reference sensors in the editor."""
        return {
            **super()._top_level_defaults(subentry_data),
            **{
                key: subentry_data[key]
                for key in RAW_PRICE_FIELDS
                if subentry_data and key in subentry_data
            },
        }

    def _config_fields(
        self, user_input: Mapping[str, object], sections: Mapping[str, Mapping[str, object]]
    ) -> dict[str, object]:
        """Persist references outside the optimizer pricing inputs."""
        return {
            **super()._config_fields(user_input, sections),
            **{key: user_input[key] for key in RAW_PRICE_FIELDS if user_input.get(key)},
        }

    sections: ClassVar[tuple[SectionDefinition, ...]] = (
        pricing_section((CONF_PRICE_SOURCE_TARGET, CONF_PRICE_TARGET_SOURCE), collapsed=False),
        power_limits_section(
            (CONF_MAX_POWER_SOURCE_TARGET, CONF_MAX_POWER_TARGET_SOURCE),
            collapsed=True,
        ),
    )
