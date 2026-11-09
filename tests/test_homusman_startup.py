"""Exercise fork coordinator initialization through the first optimization."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from custom_components.haeo_homusman.coordinator import HaeoDataUpdateCoordinator
from custom_components.haeo_homusman.core.const import (
    CONF_FORECAST_CONFIDENCE_ENABLED,
    CONF_PLAN_GATE_ENABLED,
)
from custom_components.haeo_homusman.flows import HUB_SECTION_ADVANCED


@pytest.mark.parametrize("enabled", [False, True])
def test_initialize_then_optimize(enabled: bool) -> None:
    """The coordinator reads advanced options during optimization, using its current horizon."""
    async def run() -> None:
        coordinator = object.__new__(HaeoDataUpdateCoordinator)
        coordinator.hass = Mock()
        coordinator.hass.async_add_executor_job = AsyncMock(return_value=("bootstrap", None))
        coordinator.config_entry = SimpleNamespace(data={
            HUB_SECTION_ADVANCED: {
                CONF_FORECAST_CONFIDENCE_ENABLED: enabled,
                CONF_PLAN_GATE_ENABLED: enabled,
            },
        })
        boundaries = (0.0, 3600.0)
        coordinator._runtime_data = SimpleNamespace(
            horizon_manager=SimpleNamespace(
                periods_seconds=(3600.0,), get_forecast_timestamps=lambda: boundaries,
            ),
            input_stores={},
        )
        network = Mock(n_periods=1, relaxations=(), action_snapshot=Mock(return_value={}))
        coordinator._network = network
        coordinator._participant_configs = {}
        coordinator._stale_elements = set()
        coordinator._accepted = None
        coordinator.plan_history = Mock(record=AsyncMock())
        module = "custom_components.haeo_homusman.coordinator.coordinator"
        with (
            patch.object(coordinator, "_load_from_input_stores", return_value={}),
            patch.object(coordinator, "_build_network", return_value=network),
            patch.object(coordinator, "_subscribe_to_input_stores"),
            patch.object(coordinator, "_check_inputs"),
            patch.object(coordinator, "_solve", AsyncMock(return_value=0.0)),
            patch.object(coordinator, "_report_relaxations", AsyncMock()),
            patch.object(coordinator, "_build_outputs", return_value={}),
            patch(f"{module}.serialize_topology", return_value={}),
            patch(f"{module}.evaluate_network_connectivity"),
            patch(f"{module}.build_optimization_context", return_value=Mock()),
        ):
            await coordinator.async_initialize()
            plan = await coordinator._async_update_data()
        assert plan.boundaries == boundaries
        assert coordinator.plan_decision["reason"] == ("bootstrap" if enabled else "gate_disabled")
        assert coordinator.hass.async_add_executor_job.await_count == int(enabled)
        coordinator.plan_history.record.assert_awaited_once()

    asyncio.run(run())

