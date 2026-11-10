"""Exercise fork coordinator initialization through the first optimization."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from custom_components.haeo_homusman.coordinator import HaeoDataUpdateCoordinator
from custom_components.haeo_homusman.coordinator.plan_acceptance import PlanAssessment
from custom_components.haeo_homusman.coordinator.plan_history import PlanHistory
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
        coordinator.hass.async_add_executor_job = AsyncMock(return_value=PlanAssessment("bootstrap"))
        coordinator.config_entry = SimpleNamespace(entry_id="test", data={
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
        network = Mock(
            n_periods=1, relaxations=(), action_snapshot=Mock(return_value={"battery:discharge": (0.0,)})
        )
        coordinator._network = network
        coordinator._participant_configs = {}
        coordinator._stale_elements = set()
        coordinator._relax_infeasible = False
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
            patch(f"{module}.build_network", return_value=network),
            patch(f"{module}.input_forecasts", return_value={}),
            patch(f"{module}.time", Mock(time=Mock(return_value=30.0), monotonic=Mock(return_value=30.0))) as clock,
        ):
            await coordinator.async_initialize()
            plan = await coordinator._async_update_data()
            assert plan.boundaries == ((30.0, 3600.0) if enabled else boundaries)
            assert coordinator.plan_decision["reason"] == ("bootstrap" if enabled else "gate_disabled")
            assert coordinator.hass.async_add_executor_job.await_count == int(enabled)
            coordinator.plan_history.record.assert_awaited_once()

            if enabled:
                shifted = (60.0, 3660.0)
                clock.time.return_value = 90.0
                network.action_snapshot.return_value = {"battery:discharge": (0.0, 0.0)}
                coordinator._runtime_data.horizon_manager.get_forecast_timestamps = lambda: shifted
                coordinator.hass.async_add_executor_job.return_value = PlanAssessment("below_threshold", 0.1, network)
                continuation = await coordinator._async_update_data()
                assert continuation.boundaries == (90.0, 3600.0, 3660.0)
                assert continuation.completed_at == plan.completed_at
                assert coordinator.plan_history.record.await_args.args[2] is False
                assert coordinator.accepted_metadata["rolling_cost"] == 0.1

    asyncio.run(run())


def test_revisions_preserve_acceptance_and_record_followed_power(tmp_path) -> None:
    from copy import deepcopy
    from datetime import timedelta

    async def run() -> None:
        hass = Mock()
        hass.config.path.side_effect = lambda *parts: str(tmp_path.joinpath(*parts))
        storage = Mock(async_load=AsyncMock(return_value=None), async_save=AsyncMock())
        with patch("custom_components.haeo_homusman.coordinator.plan_history.Store", return_value=storage):
            history = PlanHistory(hass, "revision-test")
        now = datetime.now(UTC)
        def plan(minutes, power, revision):
            start = now + timedelta(minutes=minutes)
            action = {"battery:discharge": (power,)}
            return SimpleNamespace(
                completed_at=now, started_at=start, boundaries=(start.timestamp(), now.timestamp() + 3600),
                actions=action, reference_actions={"battery:discharge": (1.0,)}, revision=revision,
                correction_energy_used={"battery": minutes * 0.1 / 60},
                corrections={"battery": {"power_kw": 0.1, "energy_kwh": 0.1}}, input_forecasts={},
                outputs={"battery": {"battery": {"power": SimpleNamespace(
                    forecast=[{"time": start, "value": power}], unit="kW",
                )}}},
            )
        original = plan(0, 1.0, 0)
        decision = {"reason": "accepted", "benefit": 0.1}
        await history.record(original, decision, True, active=original)
        accepted_at = history.accepted[0]["accepted_at"]
        corrected = plan(1, 0.9, 1)
        retained = {"reason": "below_threshold", "benefit": 0.0}
        await history.record(corrected, retained, False, previous=original, active=corrected)
        later = plan(2, 0.9, 1)
        await history.record(later, retained, False, previous=corrected, active=later)
        assert len(history.accepted) == 1
        record = history.accepted[0]
        assert record["accepted_at"] == accepted_at
        assert record["series"]["battery"]["power"][0][1] == 1.0
        assert record["execution_series"]["battery"]["power"][-1][1] == 0.9
        assert record["revision"] == 1
        assert len(record["revisions"]) == 1
        assert record["revisions"][0]["changes"]["battery:discharge"][0][2:] == [1.0, 0.9]
        storage.async_load.return_value = deepcopy(storage.async_save.await_args.args[0])
        with patch("custom_components.haeo_homusman.coordinator.plan_history.Store", return_value=storage):
            reloaded = PlanHistory(hass, "revision-test")
        await reloaded.load()
        assert reloaded.accepted == history.accepted

    asyncio.run(run())



def test_ungated_ticks_do_not_grow_archive(tmp_path) -> None:
    """A gate transition closes the last segment once, without archiving ungated solves."""
    async def run() -> None:
        hass = Mock()
        hass.config.path.side_effect = lambda *parts: str(tmp_path.joinpath(*parts))
        storage = Mock(async_load=AsyncMock(return_value=None), async_save=AsyncMock())
        with patch("custom_components.haeo_homusman.coordinator.plan_history.Store", return_value=storage):
            history = PlanHistory(hass, "test")
        now = datetime.now(UTC)
        plan = SimpleNamespace(outputs={}, completed_at=now, boundaries=(now.timestamp(), now.timestamp() + 3600))
        await history.record(plan, {"reason": "gate_disabled"}, True)
        history.store.async_save.assert_not_awaited()
        assert not history.accepted
        await history.record(plan, {"reason": "bootstrap"}, True)
        assert len(history.accepted) == 1
        await history.record(plan, {"reason": "gate_disabled"}, True)
        await history.record(plan, {"reason": "gate_disabled"}, True)
        assert len(history.accepted) == 1
        assert history.accepted[0]["ended_at"]
        assert history.store.async_save.await_count == 2

    asyncio.run(run())

